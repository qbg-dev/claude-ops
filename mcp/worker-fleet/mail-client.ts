/**
 * Fleet Mail HTTP client — token management, namespace helpers, request utilities.
 * Handles all communication with the Fleet Mail server (fleet-server).
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { FLEET_MAIL_URL, FLEET_MAIL_PROJECT, FLEET_DIR, WORKER_NAME } from "./config";
import { getWorkerEntry, withRegistryLocked, ensureWorkerInRegistry } from "./registry";

// Re-export for consumers that previously read FLEET_MAIL_URL from the monolith
export { FLEET_MAIL_URL } from "./config";

// ── Namespace Helpers ────────────────────────────────────────────────

/** Namespace a local worker name for Fleet Mail: "merger" → "merger@wechat" */
export function mailAccountName(localName: string): string {
  // Already namespaced (has @) or special — pass through
  if (localName.includes("@") || localName.startsWith("list:")) return localName;
  return `${localName}@${FLEET_MAIL_PROJECT}`;
}

/** Strip project namespace from a Fleet Mail account name: "merger@wechat" → "merger" */
export function stripMailNamespace(mailName: string): string {
  const suffix = `@${FLEET_MAIL_PROJECT}`;
  if (mailName.endsWith(suffix)) return mailName.slice(0, -suffix.length);
  return mailName;
}

// ── Unread Count ─────────────────────────────────────────────────────

/** Cached Fleet Mail unread count — refreshed by mail_inbox calls and background poll */
let _fleetMailUnreadCount = 0;
let _fleetMailUnreadLastCheck = 0;

/** Get the current cached unread count */
export function getFleetMailUnreadCount(): number {
  return _fleetMailUnreadCount;
}

/** Refresh Fleet Mail unread count (fire-and-forget, non-blocking) */
export function refreshFleetMailUnread(): void {
  const now = Date.now();
  if (now - _fleetMailUnreadLastCheck < 30_000) return; // throttle to 30s
  _fleetMailUnreadLastCheck = now;

  const entry = getWorkerEntry(WORKER_NAME);
  const mailToken = (entry as any)?.bms_token;
  if (!mailToken) return;

  fetch(`${FLEET_MAIL_URL}/api/messages?label=UNREAD&maxResults=1`, {
    headers: { Authorization: `Bearer ${mailToken}` },
    signal: AbortSignal.timeout(3000),
  }).then(r => r.ok ? r.json() : null).then((data: any) => {
    if (data) _fleetMailUnreadCount = data?._diagnostics?.unread_count || data?.messages?.length || 0;
  }).catch(() => {});
}

// ── Token Management ─────────────────────────────────────────────────

/** Cached token — avoids redundant filesystem reads during parallel sends */
let _cachedToken: string | null = null;

/** Get or auto-provision a Fleet Mail bearer token for the current worker.
 *  Tokens stored in per-worker dir ({name}/token) and registry.json (backward compat). */
export async function getFleetMailToken(): Promise<string> {
  if (_cachedToken) return _cachedToken;

  // Check per-worker token file first (new primary location)
  const tokenPath = join(FLEET_DIR, WORKER_NAME, "token");
  try {
    const token = readFileSync(tokenPath, "utf-8").trim();
    if (token) { _cachedToken = token; return token; }
  } catch {}

  // Fallback: check registry
  const entry = getWorkerEntry(WORKER_NAME);
  if (entry?.bms_token) {
    // Migrate: write to token file for future reads
    try {
      mkdirSync(join(FLEET_DIR, WORKER_NAME), { recursive: true });
      writeFileSync(tokenPath, entry.bms_token);
    } catch {}
    _cachedToken = entry.bms_token;
    return entry.bms_token;
  }

  // Auto-register with the mail server (namespaced: "project/worker")
  const nsName = mailAccountName(WORKER_NAME);
  const resp = await fetch(`${FLEET_MAIL_URL}/api/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nsName, bio: `Fleet worker: ${WORKER_NAME} (${FLEET_MAIL_PROJECT})` }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    // 409 = already registered but we lost the token — try daemon auto-repair
    if (resp.status === 409) {
      try {
        const repairResp = await fetch("http://localhost:9100/repair-tokens", {
          method: "POST",
          signal: AbortSignal.timeout(15000),
        });
        if (repairResp.ok) {
          // Re-read — daemon should have repaired our token
          try {
            const repairedToken = readFileSync(tokenPath, "utf-8").trim();
            if (repairedToken) return repairedToken;
          } catch {}
          const refreshed = getWorkerEntry(WORKER_NAME);
          if (refreshed?.bms_token) return refreshed.bms_token;
        }
      } catch {}
      throw new Error(`Fleet Mail account '${nsName}' exists but token is not in registry. Auto-repair via fleet-relay daemon failed.`);
    }
    throw new Error(`Fleet Mail register failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as any;
  const token = data.bearerToken as string;

  // Persist to per-worker token file (primary) + registry (backward compat)
  try {
    mkdirSync(join(FLEET_DIR, WORKER_NAME), { recursive: true });
    writeFileSync(tokenPath, token);
  } catch (e) {
    console.error(`[getFleetMailToken] WARN: Failed to write token file: ${e}`);
  }
  try {
    withRegistryLocked((reg) => {
      if (!reg[WORKER_NAME]) ensureWorkerInRegistry(reg, WORKER_NAME);
      (reg[WORKER_NAME] as any).bms_token = token;
    });
  } catch (e) {
    console.error(`[getFleetMailToken] WARN: Failed to persist bms_token for ${WORKER_NAME} to registry.json: ${e}`);
  }

  _cachedToken = token;
  return token;
}

// ── HTTP Request Helper ──────────────────────────────────────────────

/** Retry transient errors (5xx, connection refused, timeout) with exponential backoff.
 *  Delays: 2s, 4s, 8s. Does NOT retry 4xx client errors. */
async function withRetry<T>(fn: () => Promise<T>, context: string, maxRetries = 3): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const status = err.status ?? err.statusCode;
      const isTransient =
        (typeof status === "number" && status >= 500) ||
        err.code === "ECONNREFUSED" ||
        err.code === "UND_ERR_CONNECT_TIMEOUT" ||
        err.code === "ETIMEDOUT" ||
        err.name === "TimeoutError" ||
        err.message?.includes("timeout") ||
        err.message?.includes("abort");
      if (!isTransient || attempt === maxRetries) throw err;
      const delay = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      console.error(`[mail-client] ${context} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message ?? err}. Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}

/** HTTP helper for Fleet Mail API calls (with retry on transient errors) */
export async function fleetMailRequest(method: string, path: string, body?: any): Promise<any> {
  const token = await getFleetMailToken();
  const url = `${FLEET_MAIL_URL}${path}`;

  return withRetry(async () => {
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000), // 15s timeout — prevent hanging
    };

    const resp = await fetch(url, opts);
    const text = await resp.text();

    if (!resp.ok) {
      const err = new Error(`Fleet Mail ${method} ${path} failed (${resp.status}): ${text.slice(0, 500)}`);
      (err as any).status = resp.status;
      throw err;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }, `${method} ${path}`);
}

// ── Response Formatting ──────────────────────────────────────────────

/** Strip project namespace from account names in Fleet Mail responses so workers see
 *  clean names ("merger") instead of namespaced ones ("merger@wechat"). */
export function stripMailNamespaceFromResult(data: any): any {
  if (!data || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(stripMailNamespaceFromResult);
  const out: any = { ...data };
  // Strip from "from" field (string name or {name, id} object)
  if (typeof out.from === "string") out.from = stripMailNamespace(out.from);
  if (out.from?.name) out.from = { ...out.from, name: stripMailNamespace(out.from.name) };
  // Strip from "to" field (array of strings or objects)
  if (Array.isArray(out.to)) out.to = out.to.map((t: any) =>
    typeof t === "string" ? stripMailNamespace(t) : t?.name ? { ...t, name: stripMailNamespace(t.name) } : t);
  // Strip from "cc" field
  if (Array.isArray(out.cc)) out.cc = out.cc.map((t: any) =>
    typeof t === "string" ? stripMailNamespace(t) : t?.name ? { ...t, name: stripMailNamespace(t.name) } : t);
  // Recurse into "messages" array (inbox responses)
  if (Array.isArray(out.messages)) out.messages = out.messages.map(stripMailNamespaceFromResult);
  return out;
}

export function fleetMailTextResult(data: any): { content: { type: "text"; text: string }[] } {
  const cleaned = stripMailNamespaceFromResult(data);
  const text = typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

// ── Directory Cache & Recipient Resolution ───────────────────────────

/** Cache: name → account UUID. Populated lazily from /api/directory. */
let _fleetMailDirectoryCache: Record<string, string> | null = null;
let _fleetMailDirCacheTime = 0;
const FLEET_MAIL_DIR_CACHE_TTL = 60_000; // 1 minute

export async function resolveFleetMailAccountId(name: string): Promise<string> {
  // If it looks like a UUID already, pass through
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return name;
  // If it's a list: prefix, pass through
  if (name.startsWith("list:")) return name;

  // Namespace the name: "merger" → "merger@wechat"
  const nsName = mailAccountName(name);

  const now = Date.now();
  if (!_fleetMailDirectoryCache || now - _fleetMailDirCacheTime > FLEET_MAIL_DIR_CACHE_TTL) {
    const token = await getFleetMailToken();
    const resp = await fetch(`${FLEET_MAIL_URL}/api/directory`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      _fleetMailDirectoryCache = {};
      for (const acct of data.directory || []) {
        _fleetMailDirectoryCache[acct.name] = acct.id;
      }
      _fleetMailDirCacheTime = now;
    }
  }

  // Look up by namespaced name (e.g. "merger@wechat")
  // Return NAME (not UUID) — boring-mail v0.1.x send handler resolves names internally.
  // The UUID lookup validates the account exists; we return nsName for API compat.
  const id = _fleetMailDirectoryCache?.[nsName];
  if (id) return nsName;

  // Auto-provision "user" account if it doesn't exist
  if (name === "user") {
    const nsUserName = mailAccountName("user");
    try {
      const provResp = await fetch(`${FLEET_MAIL_URL}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nsUserName, display_name: "operator", bio: `Human operator (${FLEET_MAIL_PROJECT})` }),
      });
      if (provResp.ok) {
        const acct = await provResp.json() as any;
        // Save token to registry
        try {
          withRegistryLocked((reg) => {
            if (!reg.user) (reg as any).user = {};
            (reg.user as any).bms_token = acct.bearerToken;
            (reg.user as any).bms_id = acct.id;
            (reg.user as any).status = "active";
          });
        } catch {}
        if (!_fleetMailDirectoryCache) _fleetMailDirectoryCache = {};
        _fleetMailDirectoryCache[nsUserName] = acct.id;
        return nsUserName;
      }
      // 409 = already exists but not in cache — refresh (max 1 retry)
      if (provResp.status === 409) {
        if ((resolveFleetMailAccountId as any)._retrying) {
          delete (resolveFleetMailAccountId as any)._retrying;
          throw new Error(`Fleet Mail account '${nsName}' exists but cannot be resolved after retry`);
        }
        (resolveFleetMailAccountId as any)._retrying = true;
        _fleetMailDirectoryCache = null;
        _fleetMailDirCacheTime = 0;
        try {
          return await resolveFleetMailAccountId(name);
        } finally {
          delete (resolveFleetMailAccountId as any)._retrying;
        }
      }
    } catch {}
  }

  throw new Error(`Fleet Mail account '${nsName}' not found in directory`);
}

export async function resolveFleetMailRecipients(names: string[]): Promise<string[]> {
  return Promise.all(names.map(resolveFleetMailAccountId));
}

// ── Monitor Subscriptions (Erlang-style) ──────────────────────────

/** Subscribe a monitor to receive DOWN notifications when target dies.
 *  Adds monitor to target's config.json.monitors[] (idempotent). */
export function subscribeMonitor(monitor: string, target: string): void {
  const configPath = join(FLEET_DIR, target, "config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const monitors: string[] = Array.isArray(config.monitors) ? config.monitors : [];
    if (!monitors.includes(monitor)) {
      monitors.push(monitor);
      config.monitors = monitors;
      writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    }
  } catch (e: any) {
    throw new Error(`Failed to subscribe monitor '${monitor}' to '${target}': ${e.message}`);
  }
}

/** Unsubscribe a monitor from target's DOWN notifications.
 *  Removes monitor from target's config.json.monitors[]. */
export function unsubscribeMonitor(monitor: string, target: string): void {
  const configPath = join(FLEET_DIR, target, "config.json");
  try {
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    if (!Array.isArray(config.monitors)) return;
    config.monitors = config.monitors.filter((m: string) => m !== monitor);
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  } catch (e: any) {
    throw new Error(`Failed to unsubscribe monitor '${monitor}' from '${target}': ${e.message}`);
  }
}
