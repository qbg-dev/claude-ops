#!/usr/bin/env bun
/**
 * Fleet Relay Daemon — WebSocket Push + Registry Liveness + Session Persistence
 *
 * One daemon per machine, launchd-managed, port 9100.
 *
 * Phase 1 (this file — push-only daemon):
 *   - SSE endpoint for worker liveness tracking (/sse?pane=%NN)
 *   - WebSocket client to BMS admin mode → push notifications to tmux panes
 *   - Registry auto-update on SSE connect/disconnect
 *   - Session snapshot (hard-link .jsonl + subagents/ to stable fleet location)
 *
 * Phase 2 (future — HTTP MCP migration):
 *   - Extract tool handlers from index.ts into shared modules
 *   - Serve MCP tools over SSE transport
 *   - Replace stdio MCP with HTTP MCP for all workers
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync,
  linkSync, copyFileSync, readdirSync, unlinkSync, symlinkSync, renameSync,
} from "fs";
import { join, basename } from "path";
import { spawnSync } from "child_process";
import { acquireLock, releaseLock } from "./mcp/shared/lock-utils.js";

// ── Configuration ────────────────────────────────────────────────────

const HOME = process.env.HOME!;
const PORT = parseInt(process.env.FLEET_RELAY_PORT || "9100");
const FLEET_MAIL_URL = process.env.FLEET_MAIL_URL || "http://5.161.107.142:8026";
const BMS_ADMIN_TOKEN = process.env.BORING_MAIL_ADMIN_TOKEN || "";
const FLEET_DIR = join(HOME, ".claude/fleet");
const LOCK_DIR = join(HOME, ".claude-ops/state/locks");

// ── Types ────────────────────────────────────────────────────────────

interface WorkerContext {
  name: string;
  project: string;
  paneId: string;
  sessionId: string | null;
  bmsToken: string | null;
  registryPath: string;
  connectedAt: string;
}

interface ActiveConnection {
  controller: ReadableStreamDefaultController;
  context: WorkerContext;
  heartbeatInterval: ReturnType<typeof setInterval>;
}

// ── State ────────────────────────────────────────────────────────────

/** Active SSE connections: "name@project" → connection */
const activeConnections = new Map<string, ActiveConnection>();

/** BMS account UUID → { name, project } — refreshed from /api/directory */
const accountIdMap = new Map<string, { name: string; project: string }>();
let accountMapRefreshedAt = 0;

let bmsWs: WebSocket | null = null;
let bmsReconnectTimer: ReturnType<typeof setTimeout> | null = null;

// ── Identity Resolution ──────────────────────────────────────────────

/** Read Claude session ID from pane-map (written by statusline-command.sh) */
function readPaneSession(paneId: string): string | null {
  const path = join(HOME, ".claude/pane-map/by-pane", paneId);
  try { return readFileSync(path, "utf-8").trim() || null; } catch { return null; }
}

/** Scan all fleet registries for a matching pane_id */
function scanRegistriesForPane(paneId: string): { name: string; project: string; registryPath: string } | null {
  try {
    for (const proj of readdirSync(FLEET_DIR, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const regPath = join(FLEET_DIR, proj.name, "registry.json");
      try {
        const reg = JSON.parse(readFileSync(regPath, "utf-8"));
        for (const [name, entry] of Object.entries(reg)) {
          if (name === "_config") continue;
          if ((entry as any).pane_id === paneId) {
            return { name, project: proj.name, registryPath: regPath };
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

/** Resolve pane → worker identity. Explicit params override auto-detection. */
function resolveWorkerIdentity(
  paneId: string,
  explicitWorker?: string,
  explicitProject?: string,
): WorkerContext | null {
  const sessionId = readPaneSession(paneId);

  if (explicitWorker && explicitProject) {
    const registryPath = join(FLEET_DIR, explicitProject, "registry.json");
    return {
      name: explicitWorker,
      project: explicitProject,
      paneId,
      sessionId,
      bmsToken: readBmsToken(explicitWorker, registryPath),
      registryPath,
      connectedAt: new Date().toISOString(),
    };
  }

  const found = scanRegistriesForPane(paneId);
  if (found) {
    return {
      name: found.name,
      project: found.project,
      paneId,
      sessionId,
      bmsToken: readBmsToken(found.name, found.registryPath),
      registryPath: found.registryPath,
      connectedAt: new Date().toISOString(),
    };
  }

  return null;
}

function readBmsToken(workerName: string, registryPath: string): string | null {
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf-8"));
    return (reg[workerName] as any)?.bms_token || null;
  } catch { return null; }
}

// ── Registry Updates (locked) ────────────────────────────────────────

function withRegistryLocked<T>(registryPath: string, fn: (reg: any) => T): T {
  const lockPath = join(LOCK_DIR, "worker-registry");
  if (!acquireLock(lockPath)) {
    throw new Error("Could not acquire worker-registry lock after 10s");
  }
  try {
    let reg: any;
    try { reg = JSON.parse(readFileSync(registryPath, "utf-8")); } catch { reg = {}; }
    const result = fn(reg);
    writeFileSync(registryPath, JSON.stringify(reg, null, 2) + "\n");
    return result;
  } finally {
    releaseLock(lockPath);
  }
}

function updateRegistryOnConnect(ctx: WorkerContext): void {
  try {
    withRegistryLocked(ctx.registryPath, (reg) => {
      const entry = reg[ctx.name];
      if (!entry) return;
      entry.status = "active";
      entry.pane_id = ctx.paneId;
      if (ctx.sessionId) {
        entry.session_id = ctx.sessionId;
        entry.active_session_id = ctx.sessionId;
      }
      entry.connected_at = ctx.connectedAt;
    });
    log("registry", `${ctx.name}@${ctx.project}: status=active, pane=${ctx.paneId}`);
  } catch (e) {
    log("registry", `Failed to update on connect: ${e}`, "error");
  }
}

function updateRegistryOnDisconnect(ctx: WorkerContext): void {
  try {
    withRegistryLocked(ctx.registryPath, (reg) => {
      const entry = reg[ctx.name];
      if (!entry) return;
      entry.status = "inactive";
      entry.disconnected_at = new Date().toISOString();
    });
    log("registry", `${ctx.name}@${ctx.project}: status=inactive`);
  } catch (e) {
    log("registry", `Failed to update on disconnect: ${e}`, "error");
  }
}

// ── Session Snapshots (hard-link) ────────────────────────────────────

function snapshotSession(ctx: WorkerContext): void {
  if (!ctx.sessionId) {
    log("session", `${ctx.name}: no session_id — skipping snapshot`);
    return;
  }

  // Find the session .jsonl file across all project slugs
  const projectsDir = join(HOME, ".claude/projects");
  let sourceJsonl: string | null = null;
  let sourceSubDir: string | null = null;

  try {
    for (const slug of readdirSync(projectsDir)) {
      const jsonlPath = join(projectsDir, slug, `${ctx.sessionId}.jsonl`);
      if (existsSync(jsonlPath)) {
        sourceJsonl = jsonlPath;
        const subDir = join(projectsDir, slug, ctx.sessionId);
        if (existsSync(subDir)) sourceSubDir = subDir;
        break;
      }
    }
  } catch {}

  if (!sourceJsonl) {
    log("session", `${ctx.name}: .jsonl not found for session ${ctx.sessionId}`);
    return;
  }

  const destDir = join(FLEET_DIR, ctx.project, "sessions", ctx.name);
  mkdirSync(destDir, { recursive: true });

  // Hard-link the .jsonl transcript
  const destJsonl = join(destDir, `${ctx.sessionId}.jsonl`);
  hardLinkOrCopy(sourceJsonl, destJsonl);

  // Hard-link subagent directory tree
  if (sourceSubDir) {
    const destSubDir = join(destDir, ctx.sessionId);
    mkdirSync(destSubDir, { recursive: true });
    hardLinkTree(sourceSubDir, destSubDir);
  }

  // Update "latest" symlink atomically
  const latestLink = join(destDir, "latest");
  const latestTmp = join(destDir, "latest.tmp");
  try {
    try { unlinkSync(latestTmp); } catch {}
    symlinkSync(ctx.sessionId, latestTmp);
    renameSync(latestTmp, latestLink);
  } catch {
    try { unlinkSync(latestLink); } catch {}
    try { symlinkSync(ctx.sessionId, latestLink); } catch {}
  }

  // Update registry with session file path
  try {
    withRegistryLocked(ctx.registryPath, (reg) => {
      const entry = reg[ctx.name];
      if (entry) entry.session_file = destJsonl;
    });
  } catch {}

  log("session", `${ctx.name}@${ctx.project}: snapshot → ${destJsonl}`);
}

/** Hard-link a single file, falling back to copy on cross-device. */
function hardLinkOrCopy(src: string, dest: string): void {
  if (existsSync(dest)) return; // already linked
  try {
    linkSync(src, dest);
  } catch {
    try { copyFileSync(src, dest); } catch {}
  }
}

/** Recursively hard-link all files from src tree into dest tree. */
function hardLinkTree(src: string, dest: string): void {
  try {
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = join(src, entry.name);
      const destPath = join(dest, entry.name);
      if (entry.isDirectory()) {
        mkdirSync(destPath, { recursive: true });
        hardLinkTree(srcPath, destPath);
      } else if (entry.isFile()) {
        hardLinkOrCopy(srcPath, destPath);
      }
    }
  } catch {}
}

// ── BMS WebSocket Push ───────────────────────────────────────────────

function connectBmsWebSocket(): void {
  if (!BMS_ADMIN_TOKEN) {
    log("bms-ws", "No admin token configured — push notifications disabled", "warn");
    return;
  }

  const wsUrl = FLEET_MAIL_URL.replace(/^http/, "ws") + `/ws?token=${BMS_ADMIN_TOKEN}`;
  log("bms-ws", `Connecting to ${FLEET_MAIL_URL}/ws (admin mode)...`);

  try {
    bmsWs = new WebSocket(wsUrl);

    bmsWs.addEventListener("open", () => {
      log("bms-ws", "Connected — receiving all events");
      // Refresh account→worker map on connect
      refreshAccountIdMap().catch(() => {});
    });

    bmsWs.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        handleBmsEvent(data);
      } catch (e) {
        log("bms-ws", `Parse error: ${e}`, "error");
      }
    });

    bmsWs.addEventListener("close", () => {
      log("bms-ws", "Disconnected — reconnecting in 5s");
      bmsWs = null;
      scheduleReconnect();
    });

    bmsWs.addEventListener("error", (e) => {
      log("bms-ws", `Error: ${e}`, "error");
    });
  } catch (e) {
    log("bms-ws", `Connect failed: ${e}`, "error");
    scheduleReconnect();
  }
}

function scheduleReconnect(): void {
  if (bmsReconnectTimer) return;
  bmsReconnectTimer = setTimeout(() => {
    bmsReconnectTimer = null;
    connectBmsWebSocket();
  }, 5000);
}

/** Refresh BMS account_id → worker mapping from /api/directory.
 *  Uses any available worker token (or admin token) to call directory. */
async function refreshAccountIdMap(): Promise<void> {
  const now = Date.now();
  if (now - accountMapRefreshedAt < 60_000) return;
  accountMapRefreshedAt = now;

  // Collect ALL tokens from registries — try each until one works
  const tokens: string[] = [];
  for (const proj of safeReadDir(FLEET_DIR)) {
    const regPath = join(FLEET_DIR, proj, "registry.json");
    try {
      const reg = JSON.parse(readFileSync(regPath, "utf-8"));
      for (const [name, entry] of Object.entries(reg)) {
        if (name === "_config") continue;
        const token = (entry as any)?.bms_token;
        if (token && !tokens.includes(token)) tokens.push(token);
      }
    } catch {}
  }

  if (tokens.length === 0) {
    log("bms-ws", "No worker tokens found in registries — cannot fetch directory", "warn");
    return;
  }

  // Try tokens until one works (stale tokens return 401)
  let resp: Response | null = null;
  for (const token of tokens) {
    try {
      const r = await fetch(`${FLEET_MAIL_URL}/api/directory`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) { resp = r; break; }
    } catch {}
  }
  if (!resp) {
    log("bms-ws", `All ${tokens.length} tokens failed for /api/directory`, "error");
    return;
  }

  try {

    const data = await resp.json() as any;
    accountIdMap.clear();

    for (const acct of data.directory || []) {
      const atIdx = (acct.name as string).lastIndexOf("@");
      if (atIdx > 0) {
        const workerName = acct.name.slice(0, atIdx);
        const project = acct.name.slice(atIdx + 1);
        accountIdMap.set(acct.id, { name: workerName, project });
      }
    }

    log("bms-ws", `Account map refreshed: ${accountIdMap.size} entries`);
  } catch (e) {
    log("bms-ws", `Directory fetch failed: ${e}`, "error");
  }
}

function handleBmsEvent(event: any): void {
  if (event.type !== "new_message") return;

  const accountId = event.account_id;
  if (!accountId) return;

  // Resolve recipient
  const worker = accountIdMap.get(accountId);
  if (!worker) {
    // Lazy refresh and retry (don't block)
    refreshAccountIdMap().then(() => {
      const w = accountIdMap.get(accountId);
      if (w) deliverPushNotification(w.name, w.project, event);
    }).catch(() => {});
    return;
  }

  deliverPushNotification(worker.name, worker.project, event);
}

function deliverPushNotification(workerName: string, project: string, event: any): void {
  // Look up pane_id from registry
  let paneId: string | null = null;

  // Check active SSE connections first
  const connKey = `${workerName}@${project}`;
  const conn = activeConnections.get(connKey);
  if (conn) {
    paneId = conn.context.paneId;

    // Also push via SSE
    try {
      conn.controller.enqueue(`data: ${JSON.stringify({ type: "new_message", ...event.data })}\n\n`);
    } catch {}
  }

  // Fallback: read from registry
  if (!paneId) {
    paneId = lookupPaneFromRegistry(workerName, project);
  }

  if (!paneId) return;

  // Extract sender/subject — BMS sends flat fields at top level
  const fromRaw = event.from || event.data?.from || "unknown";
  const from = typeof fromRaw === "string"
    ? fromRaw.replace(/@[^@]+$/, "")  // strip @project suffix
    : (fromRaw?.name || "unknown").replace(/@[^@]+$/, "");
  const subject = event.subject || event.data?.subject || "(no subject)";

  deliverTmuxNotification(paneId, workerName, from, subject);
}

function lookupPaneFromRegistry(workerName: string, project: string): string | null {
  // Try matching project name (case-insensitive)
  try {
    for (const dir of readdirSync(FLEET_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      if (dir.name.toLowerCase() !== project.toLowerCase()) continue;
      const regPath = join(FLEET_DIR, dir.name, "registry.json");
      try {
        const reg = JSON.parse(readFileSync(regPath, "utf-8"));
        return (reg[workerName] as any)?.pane_id || null;
      } catch {}
    }
  } catch {}
  return null;
}

function deliverTmuxNotification(paneId: string, workerName: string, from: string, subject: string): void {
  try {
    const msg = `📬 [${from}] ${subject}`;
    spawnSync("tmux", ["display-message", "-t", paneId, "-d", "5000", msg], {
      timeout: 3000,
    });
    log("push", `${workerName} (${paneId}): ${from} — ${subject}`);
  } catch (e) {
    log("push", `Failed to notify ${workerName}: ${e}`, "error");
  }
}

// ── SSE Handler ──────────────────────────────────────────────────────

function handleSSE(req: Request, url: URL): Response {
  const paneId = url.searchParams.get("pane");
  const explicitWorker = url.searchParams.get("worker") || undefined;
  const explicitProject = url.searchParams.get("project") || undefined;

  if (!paneId && !explicitWorker) {
    return Response.json({ error: "pane or worker+project params required" }, { status: 400 });
  }

  const ctx = resolveWorkerIdentity(paneId || "", explicitWorker, explicitProject);
  if (!ctx) {
    return Response.json(
      { error: `Could not resolve worker identity for pane ${paneId}. Is this pane registered in any ~/.claude/fleet/*/registry.json?` },
      { status: 404 },
    );
  }

  const sessionKey = `${ctx.name}@${ctx.project}`;

  // Close existing connection for same worker (reconnect)
  const existing = activeConnections.get(sessionKey);
  if (existing) {
    try { existing.controller.close(); } catch {}
    clearInterval(existing.heartbeatInterval);
    activeConnections.delete(sessionKey);
  }

  const stream = new ReadableStream({
    start(controller) {
      // SSE keepalive every 30s
      const heartbeat = setInterval(() => {
        try { controller.enqueue(`: heartbeat\n\n`); } catch {}
      }, 30_000);

      activeConnections.set(sessionKey, { controller, context: ctx, heartbeatInterval: heartbeat });

      // Update registry
      updateRegistryOnConnect(ctx);

      // Snapshot session (deferred — don't block SSE open)
      setTimeout(() => snapshotSession(ctx), 500);

      // Send connected event
      const payload = {
        type: "connected",
        worker: ctx.name,
        project: ctx.project,
        session_id: ctx.sessionId,
        pane_id: ctx.paneId,
      };
      controller.enqueue(`data: ${JSON.stringify(payload)}\n\n`);

      log("sse", `Connected: ${ctx.name}@${ctx.project} (pane ${ctx.paneId}, session ${ctx.sessionId || "?"})`);
    },
    cancel() {
      const conn = activeConnections.get(sessionKey);
      if (conn) {
        clearInterval(conn.heartbeatInterval);
        activeConnections.delete(sessionKey);
      }
      updateRegistryOnDisconnect(ctx);
      log("sse", `Disconnected: ${ctx.name}@${ctx.project}`);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}

// ── HTTP Server ──────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        uptime: Math.round(process.uptime()),
        connections: activeConnections.size,
        bms_connected: bmsWs?.readyState === WebSocket.OPEN,
        bms_accounts: accountIdMap.size,
      });
    }

    if (url.pathname === "/sse" && req.method === "GET") {
      return handleSSE(req, url);
    }

    if (url.pathname === "/status") {
      return handleStatus();
    }

    // Force-refresh account map
    if (url.pathname === "/refresh" && req.method === "POST") {
      accountMapRefreshedAt = 0;
      refreshAccountIdMap().catch(() => {});
      return Response.json({ ok: true });
    }

    return new Response("Not Found", { status: 404 });
  },
});

function handleStatus(): Response {
  const connections: any[] = [];
  for (const [_key, { context }] of activeConnections) {
    connections.push({
      worker: context.name,
      project: context.project,
      pane: context.paneId,
      session: context.sessionId,
      connected_at: context.connectedAt,
    });
  }

  return Response.json({
    daemon: "fleet-relay",
    version: "1.0.0",
    port: PORT,
    uptime: Math.round(process.uptime()),
    bms: {
      url: FLEET_MAIL_URL,
      connected: bmsWs?.readyState === WebSocket.OPEN,
      accounts_mapped: accountIdMap.size,
    },
    connections,
  });
}

// ── Helpers ──────────────────────────────────────────────────────────

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch { return []; }
}

function log(tag: string, msg: string, level: "info" | "warn" | "error" = "info"): void {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${tag}]`;
  if (level === "error") console.error(`${prefix} ERROR: ${msg}`);
  else if (level === "warn") console.warn(`${prefix} WARN: ${msg}`);
  else console.log(`${prefix} ${msg}`);
}

// ── Startup ──────────────────────────────────────────────────────────

log("daemon", `Fleet Relay Daemon starting on port ${PORT}`);
log("daemon", `BMS: ${FLEET_MAIL_URL}`);
log("daemon", `Fleet dir: ${FLEET_DIR}`);

// Ensure directories exist
mkdirSync(FLEET_DIR, { recursive: true });
mkdirSync(LOCK_DIR, { recursive: true });

// Connect to BMS for push notifications
connectBmsWebSocket();

log("daemon", `Ready on http://localhost:${PORT}`);
