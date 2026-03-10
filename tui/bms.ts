/**
 * BMS (Boring Mail Server) client + registry utilities.
 * Extracted from harness REPL for shared use.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, basename } from "path";

const BMS_URL = process.env.BMS_URL || "http://127.0.0.1:8025";

const PROJECT_ROOT =
  process.env.PROJECT_ROOT ||
  (() => {
    try {
      const { spawnSync } = require("child_process");
      return spawnSync("git", ["rev-parse", "--show-toplevel"]).stdout.toString().trim();
    } catch {
      return process.cwd();
    }
  })();

function resolveRegistryPath(): string {
  const HOME = process.env.HOME!;
  const projectName = basename(PROJECT_ROOT).replace(/-w-.*$/, '');
  const fleetPath = join(HOME, ".claude/fleet", projectName, "registry.json");
  if (existsSync(fleetPath)) return fleetPath;
  const legacyPath = join(PROJECT_ROOT, ".claude/workers/registry.json");
  if (existsSync(legacyPath)) return legacyPath;
  return fleetPath; // default to new location
}

export const REGISTRY_PATH = resolveRegistryPath();

// ── BMS HTTP Client ──

export async function bmsRequest(
  token: string,
  method: string,
  path: string,
  body?: any,
  _retries = 0
): Promise<any> {
  const r = await fetch(`${BMS_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (r.status === 401)
    throw new Error(`401 Unauthorized — token may be expired`);
  if (r.status === 429 && _retries < 2) {
    // Rate limited — backoff and retry (max 2 retries)
    await new Promise((resolve) => setTimeout(resolve, 2000 * (_retries + 1)));
    return bmsRequest(token, method, path, body, _retries + 1);
  }
  if (!r.ok)
    throw new Error(
      `BMS ${r.status}: ${(await r.text().catch(() => "")).slice(0, 80)}`
    );
  return r.json();
}

// ── Registry ──

export function loadRegistry(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  } catch {
    return {};
  }
}

export function loadTokenMap(registry: Record<string, any>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [name, w] of Object.entries(registry)) {
    if (name === "_config") continue;
    const worker = w as any;
    if (worker.bms_token) map.set(name, worker.bms_token);
  }
  return map;
}

export function resolveUserToken(): string {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8")).user?.bms_token || "";
  } catch {
    return process.env.BMS_TOKEN || "";
  }
}

export async function autoProvisionUser(): Promise<string> {
  const resp = await fetch(`${BMS_URL}/api/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "user",
      display_name: process.env.USER || "operator",
      bio: "Human operator",
    }),
    signal: AbortSignal.timeout(5000),
  });
  if (resp.ok) {
    const acct = (await resp.json()) as any;
    const token = acct.bearerToken;
    saveUserToken(token, acct.id);
    return token;
  } else if (resp.status === 409) {
    // Account exists but token not in registry. Fall back to any worker token for read-only access.
    const reg = loadRegistry();
    const fallback = Object.entries(reg)
      .filter(([k]) => k !== "_config" && k !== "user")
      .map(([, w]: [string, any]) => w.bms_token)
      .find((t: string) => !!t);
    if (fallback) {
      process.stderr.write("Warning: using fallback token (user account exists but token lost)\n");
      return fallback;
    }
    throw new Error("BMS user account exists but token not in registry. Query kevinster: ssh kevinster 'cd ~/mail_db && dolt sql -q \"SELECT bearer_token FROM accounts WHERE name=\\\"user\\\"\"'");
  }
  throw new Error(`BMS registration failed: ${resp.status}`);
}

function saveUserToken(token: string, id: string) {
  try {
    const reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    reg.user = reg.user || {};
    reg.user.bms_token = token;
    reg.user.bms_id = id;
    reg.user.status = "active";
    writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
  } catch {}
}

// ── Directory Resolution ──

export async function fetchDirectory(
  token: string
): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  try {
    const data = await bmsRequest(token, "GET", "/api/directory");
    for (const a of data.directory || data || []) {
      map[a.id] = a.displayName || a.name;
    }
  } catch {}
  return map;
}

export function senderName(
  msg: any,
  directory: Record<string, string>
): string {
  const fromId =
    typeof msg.from === "string" ? msg.from : msg.from?.id || msg.fromId;
  if (typeof msg.from === "object" && msg.from) {
    const display = msg.from.displayName || msg.from.name;
    if (display && display !== "?") return display;
  }
  if (fromId && directory[fromId]) return directory[fromId];
  return fromId?.slice(0, 8) || "?";
}

export function recipientNames(
  msg: any,
  directory: Record<string, string>
): string {
  const toList = msg.to || msg.toList || [];
  if (toList.length > 0) {
    return toList
      .map((t: any) => {
        if (typeof t === "object" && t)
          return t.displayName || t.name || directory[t.id] || t.id?.slice(0, 8);
        if (typeof t === "string" && directory[t]) return directory[t];
        return typeof t === "string" ? t.slice(0, 8) : "?";
      })
      .join(", ");
  }
  if (msg.toId) return directory[msg.toId] || msg.toId.slice(0, 12);
  return "";
}

// ── Time Formatting ──

export function timeAgo(iso: string): string {
  if (!iso) return "";
  const now = new Date();
  const d = new Date(iso);
  const ms = now.getTime() - d.getTime();
  if (ms < 60e3) return "now";
  if (ms < 3600e3) return `${(ms / 60e3) | 0}m`;
  // Same day: show HH:MM
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  // Same week (within 7 days): show "Mon 14:30"
  if (ms < 604800e3) {
    const day = d.toLocaleDateString("en-US", { weekday: "short" });
    const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
    return `${day} ${time}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Fetch Helpers ──

export async function fetchInbox(
  token: string,
  maxResults = 50
): Promise<any[]> {
  const data = await bmsRequest(
    token,
    "GET",
    `/api/messages?label=INBOX&maxResults=${maxResults}`
  );
  return data.messages || [];
}

export async function fetchSent(
  token: string,
  maxResults = 50
): Promise<any[]> {
  const data = await bmsRequest(
    token,
    "GET",
    `/api/messages?label=SENT&maxResults=${maxResults}`
  );
  return data.messages || [];
}

export async function fetchThreads(
  token: string,
  maxResults = 20
): Promise<any[]> {
  const data = await bmsRequest(
    token,
    "GET",
    `/api/threads?label=INBOX&maxResults=${maxResults}`
  );
  return data.threads || [];
}

export async function fetchThread(
  token: string,
  threadId: string
): Promise<any> {
  return bmsRequest(token, "GET", `/api/threads/${threadId}`);
}

export async function fetchMessage(
  token: string,
  messageId: string
): Promise<any> {
  return bmsRequest(token, "GET", `/api/messages/${messageId}`);
}

export async function sendMessage(
  token: string,
  to: string[],
  subject: string,
  body: string,
  opts?: { threadId?: string; inReplyTo?: string }
): Promise<any> {
  return bmsRequest(token, "POST", "/api/messages/send", {
    to,
    subject,
    body,
    cc: [],
    thread_id: opts?.threadId || null,
    in_reply_to: opts?.inReplyTo || null,
    reply_by: null,
    labels: [],
    attachments: [],
  });
}

export async function archiveMessage(
  token: string,
  messageId: string
): Promise<void> {
  await bmsRequest(token, "POST", `/api/messages/${messageId}/modify`, {
    addLabelIds: ["ARCHIVED"],
    removeLabelIds: ["INBOX", "UNREAD"],
  });
}

export async function starMessage(
  token: string,
  messageId: string,
  starred: boolean
): Promise<void> {
  await bmsRequest(token, "POST", `/api/messages/${messageId}/modify`, {
    addLabelIds: starred ? [] : ["STARRED"],
    removeLabelIds: starred ? ["STARRED"] : [],
  });
}

export async function trashMessage(
  token: string,
  messageId: string
): Promise<void> {
  await bmsRequest(token, "POST", `/api/messages/${messageId}/trash`);
}

export async function searchMessages(
  token: string,
  query: string,
  maxResults = 20
): Promise<any[]> {
  const data = await bmsRequest(
    token,
    "GET",
    `/api/search?q=${encodeURIComponent(query)}&maxResults=${maxResults}`
  );
  return data.messages || [];
}

export async function fetchUnreadCount(token: string): Promise<number> {
  try {
    const data = await bmsRequest(
      token,
      "GET",
      "/api/messages?label=UNREAD&maxResults=1"
    );
    // Use total from response if available, otherwise count
    return data.resultSizeEstimate ?? data.messages?.length ?? 0;
  } catch {
    return 0;
  }
}

export async function fetchLabels(token: string): Promise<any[]> {
  const data = await bmsRequest(token, "GET", "/api/labels");
  return data.labels || data || [];
}

export async function fetchAnalytics(token: string): Promise<any> {
  return bmsRequest(token, "GET", "/api/analytics");
}

// ── Undo Helpers ──

export async function unarchiveMessage(
  token: string,
  messageId: string
): Promise<void> {
  await bmsRequest(token, "POST", `/api/messages/${messageId}/modify`, {
    addLabelIds: ["INBOX"],
    removeLabelIds: ["ARCHIVED"],
  });
}

export async function untrashMessage(
  token: string,
  messageId: string
): Promise<void> {
  await bmsRequest(token, "POST", `/api/messages/${messageId}/untrash`);
}

// ── Search Query Parser ──

export interface ParsedSearchQuery {
  from?: string;
  to?: string;
  isUnread?: boolean;
  isStarred?: boolean;
  label?: string;
  before?: string;
  after?: string;
  q: string;
}

export function parseSearchQuery(input: string): ParsedSearchQuery {
  const result: ParsedSearchQuery = { q: "" };
  const remaining: string[] = [];

  const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith("from:")) {
      result.from = token.slice(5).replace(/^"|"$/g, "");
    } else if (lower.startsWith("to:")) {
      result.to = token.slice(3).replace(/^"|"$/g, "");
    } else if (lower === "is:unread") {
      result.isUnread = true;
    } else if (lower === "is:starred") {
      result.isStarred = true;
    } else if (lower.startsWith("label:")) {
      result.label = token.slice(6).replace(/^"|"$/g, "");
    } else if (lower.startsWith("before:")) {
      result.before = token.slice(7);
    } else if (lower.startsWith("after:")) {
      result.after = token.slice(6);
    } else {
      remaining.push(token);
    }
  }

  result.q = remaining.join(" ");
  return result;
}

export function applySearchFilters(messages: any[], parsed: ParsedSearchQuery, directory: Record<string, string>): any[] {
  return messages.filter((msg) => {
    if (parsed.isUnread !== undefined) {
      const hasUnread = (msg.labelIds || []).includes("UNREAD");
      if (parsed.isUnread && !hasUnread) return false;
    }
    if (parsed.isStarred !== undefined) {
      const hasStarred = (msg.labelIds || []).includes("STARRED");
      if (parsed.isStarred && !hasStarred) return false;
    }
    if (parsed.label) {
      if (!(msg.labelIds || []).includes(parsed.label.toUpperCase())) return false;
    }
    if (parsed.from) {
      const fromName = senderName(msg, directory).toLowerCase();
      if (!fromName.includes(parsed.from.toLowerCase())) return false;
    }
    if (parsed.to) {
      const toNames = recipientNames(msg, directory).toLowerCase();
      if (!toNames.includes(parsed.to.toLowerCase())) return false;
    }
    if (parsed.before) {
      const msgDate = new Date(msg.internalDate);
      if (msgDate >= new Date(parsed.before)) return false;
    }
    if (parsed.after) {
      const msgDate = new Date(msg.internalDate);
      if (msgDate <= new Date(parsed.after)) return false;
    }
    return true;
  });
}
