/**
 * Fleet Mail HTTP client for CLI commands.
 * Ported from mcp/worker-fleet/mail-client.ts with session-first identity.
 *
 * Token resolution: session dir > legacy worker dir > auto-provision.
 * No registry.json dependency — tokens live in per-session or per-worker dirs.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FLEET_MAIL_URL, FLEET_DATA } from "./paths";
import {
  resolveIdentity,
  resolveSessionId,
  sessionDir,
  resolveDirSlug,
  buildMailName,
} from "../../shared/identity";

// ── Token Management ────────────────────────────────────────────────

let _cachedToken: string | null = null;

/** Get a Fleet Mail bearer token for the current session/worker.
 *  Reads from session dir or legacy worker dir, or auto-provisions. */
export async function getToken(opts?: { sessionId?: string }): Promise<string> {
  if (_cachedToken) return _cachedToken;

  const identity = resolveIdentity(opts);

  if (identity?.type === "session") {
    const tokenPath = join(sessionDir(identity.identity.sessionId), "token");
    try {
      const token = readFileSync(tokenPath, "utf-8").trim();
      if (token) { _cachedToken = token; return token; }
    } catch {}
  }

  if (identity?.type === "legacy") {
    // Check per-worker token file
    const project = resolveDirSlug();
    const tokenPath = join(FLEET_DATA, project, identity.workerName, "token");
    try {
      const token = readFileSync(tokenPath, "utf-8").trim();
      if (token) { _cachedToken = token; return token; }
    } catch {}
  }

  // Auto-provision — need a name
  const sessionId = resolveSessionId(opts);
  const dirSlug = resolveDirSlug();
  const mailName = sessionId
    ? buildMailName(null, dirSlug, sessionId)
    : `operator-${dirSlug}`;

  return await autoProvision(mailName, sessionId);
}

/** Auto-provision a Fleet Mail account and save the token. */
async function autoProvision(mailName: string, sessionId: string | null): Promise<string> {
  if (!FLEET_MAIL_URL) throw new Error("Fleet Mail not configured — run: fleet mail-server connect <url>");

  const resp = await fetch(`${FLEET_MAIL_URL}/api/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: mailName, bio: `Fleet session: ${mailName}` }),
  });

  if (!resp.ok) {
    if (resp.status === 409) {
      throw new Error(`Fleet Mail account '${mailName}' already exists but token not found locally. Run: fleet register`);
    }
    const errText = await resp.text().catch(() => "");
    throw new Error(`Fleet Mail register failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as { bearerToken: string };
  const token = data.bearerToken;

  // Persist token
  if (sessionId) {
    const dir = sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "token"), token);
  }

  _cachedToken = token;
  return token;
}

// ── HTTP Request Helper ─────────────────────────────────────────────

/** HTTP helper with retry on transient errors. */
export async function mailRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  if (!FLEET_MAIL_URL) throw new Error("Fleet Mail not configured — run: fleet mail-server connect <url>");

  const token = await getToken();
  const url = `${FLEET_MAIL_URL}${path}`;

  for (let attempt = 0; attempt <= 3; attempt++) {
    try {
      const opts: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(15_000),
      };

      const resp = await fetch(url, opts);
      const text = await resp.text();

      if (!resp.ok) {
        const err = new Error(`Fleet Mail ${method} ${path} (${resp.status}): ${text.slice(0, 500)}`);
        (err as any).status = resp.status;
        throw err;
      }

      try { return JSON.parse(text); } catch { return text; }
    } catch (err: any) {
      const isTransient =
        (err.status && err.status >= 500) ||
        err.code === "ECONNREFUSED" ||
        err.name === "TimeoutError" ||
        err.message?.includes("timeout");
      if (!isTransient || attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt)));
    }
  }
  throw new Error("unreachable");
}

// ── Recipient Resolution ────────────────────────────────────────────

let _directoryCache: Record<string, string> | null = null;
let _dirCacheTime = 0;

/** Resolve a recipient name to a Fleet Mail account name.
 *  Supports: full mail names, legacy worker names, substring match. */
export async function resolveRecipient(name: string): Promise<string> {
  // Already a UUID — pass through
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return name;
  // List prefix — pass through
  if (name.startsWith("list:")) return name;

  // Refresh directory cache (1 min TTL)
  const now = Date.now();
  if (!_directoryCache || now - _dirCacheTime > 60_000) {
    try {
      const data = await mailRequest("GET", "/api/directory") as { directory?: Array<{ name: string; id: string }> };
      _directoryCache = {};
      for (const acct of data.directory || []) {
        _directoryCache[acct.name] = acct.id;
      }
      _dirCacheTime = now;
    } catch {
      // Use stale cache
    }
  }

  // Exact match
  if (_directoryCache?.[name]) return name;

  // Substring match (find accounts containing the name)
  if (_directoryCache) {
    const matches = Object.keys(_directoryCache).filter(k => k.includes(name));
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new Error(`Ambiguous recipient '${name}' — matches: ${matches.join(", ")}`);
    }
  }

  // Legacy: try with @project namespace
  const project = resolveDirSlug().toLowerCase();
  const nsName = `${name}@${project}`;
  if (_directoryCache?.[nsName]) return nsName;

  throw new Error(`Recipient '${name}' not found in Fleet Mail directory`);
}

/** Strip namespace suffixes from display names for clean output. */
export function cleanDisplayName(mailName: string): string {
  // Strip @project suffix (legacy)
  return mailName.replace(/@[^@]+$/, "");
}
