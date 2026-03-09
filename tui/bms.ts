/**
 * BMS (Boring Mail Server) client + registry utilities.
 * Extracted from harness REPL for shared use.
 */

import { readFileSync, writeFileSync } from "fs";

const BMS_URL = process.env.BMS_URL || "http://127.0.0.1:8025";

const PROJECT_ROOT =
  process.env.PROJECT_ROOT ||
  (() => {
    const wellKnown = `${process.env.HOME}/Desktop/zPersonalProjects/Wechat`;
    try {
      readFileSync(`${wellKnown}/.claude/workers/registry.json`);
      return wellKnown;
    } catch {}
    try {
      const { spawnSync } = require("child_process");
      return spawnSync("git", ["rev-parse", "--show-toplevel"]).stdout.toString().trim();
    } catch {
      return process.cwd();
    }
  })();

export const REGISTRY_PATH = `${PROJECT_ROOT}/.claude/workers/registry.json`;

// ── BMS HTTP Client ──

export async function bmsRequest(
  token: string,
  method: string,
  path: string,
  body?: any
): Promise<any> {
  const r = await fetch(`${BMS_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
  });
  if (r.status === 401)
    throw new Error(`401 Unauthorized — token may be expired`);
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
    try {
      const reg = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
      reg.user = reg.user || {};
      reg.user.bms_token = token;
      reg.user.bms_id = acct.id;
      reg.user.status = "active";
      writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
    } catch {}
    return token;
  } else if (resp.status === 409) {
    throw new Error("BMS user account exists but token not in registry");
  }
  throw new Error(`BMS registration failed: ${resp.status}`);
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
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60e3) return "now";
  if (ms < 3600e3) return `${(ms / 60e3) | 0}m`;
  if (ms < 86400e3) return `${(ms / 3600e3) | 0}h`;
  if (ms < 604800e3) return `${(ms / 86400e3) | 0}d`;
  const d = new Date(iso);
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
