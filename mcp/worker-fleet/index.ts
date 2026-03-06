#!/usr/bin/env bun
/**
 * worker-fleet MCP server — Tools for worker fleet coordination.
 *
 * 16 tools in 5 categories:
 *   Messaging (2):  send_message (ack system: fyi, in_reply_to), read_inbox
 *   Tasks (3):      create_task, update_task, list_tasks
 *   State (2):      get_worker_state, update_state
 *   Fleet (1):      fleet_status
 *   Lifecycle (4):  recycle, heartbeat, check_config, reload
 *   Management (4): create_worker, get_worker_template, deregister, standby
 *
 * Task CRUD and inbox are native TS (no shell subprocess).
 * Messaging writes inbox first (durable), then fires bus (best-effort).
 *
 * Runtime: bun run ~/.claude-ops/mcp/worker-fleet/index.ts (stdio transport)
 * Identity: auto-detected from WORKER_NAME env or git branch (worker/* → name)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  readdirSync, openSync, fstatSync, statSync, readSync, closeSync, truncateSync,
  lstatSync, rmSync, copyFileSync, cpSync,
} from "fs";
import { join, basename } from "path";
import { execSync, spawnSync } from "child_process";

// ── Configuration ────────────────────────────────────────────────────
const HOME = process.env.HOME!;
const PROJECT_ROOT = process.env.PROJECT_ROOT || "/Users/wz/Desktop/zPersonalProjects/Wechat";
const CLAUDE_OPS = process.env.CLAUDE_OPS_DIR || join(HOME, ".claude-ops");
let WORKERS_DIR = join(PROJECT_ROOT, ".claude/workers");

/** For testing — override the workers directory */
function _setWorkersDir(dir: string) { WORKERS_DIR = dir; }
const HARNESS_LOCK_DIR = join(CLAUDE_OPS, "state/locks");

/** Project-level unified registry — replaces per-worker permissions.json, state.json, and pane-registry.json */
const REGISTRY_PATH = join(PROJECT_ROOT, ".claude/workers/registry.json");

// Script paths (only for tools that still shell out)
const WORKER_MESSAGE_SH = join(CLAUDE_OPS, "scripts/worker-message.sh");
const CHECK_WORKERS_SH = join(CLAUDE_OPS, "scripts/check-flat-workers.sh");

// ── Worker Identity Detection ────────────────────────────────────────
function detectWorkerName(): string {
  if (process.env.WORKER_NAME) return process.env.WORKER_NAME;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: process.cwd(), encoding: "utf-8", timeout: 5000,
    }).trim();
    if (branch.startsWith("worker/")) return branch.slice("worker/".length);
    // On main branch, derive from worktree directory name (e.g. Wechat-w-merger → merger)
    const dirName = basename(process.cwd());
    const match = dirName.match(/-w-(.+)$/);
    if (match) return match[1];
  } catch {}
  return "operator";
}

const WORKER_NAME = detectWorkerName();

// Cache git branch at module load for fast diagnostics (no subprocess at check time)
let _cachedBranch: string | null = null;
try {
  _cachedBranch = execSync("git rev-parse --abbrev-ref HEAD", {
    cwd: process.cwd(), encoding: "utf-8", timeout: 5000,
  }).trim();
} catch {}

// ── Generic Helpers ──────────────────────────────────────────────────

function runScript(
  cmd: string, args: string[],
  opts: { cwd?: string; timeout?: number } = {}
): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync("bash", [cmd, ...args], {
    cwd: opts.cwd || PROJECT_ROOT, encoding: "utf-8",
    timeout: opts.timeout || 30_000,
    env: { ...process.env, PROJECT_ROOT },
  });
  return {
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    exitCode: result.status ?? 1,
  };
}

function readJsonFile(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf-8")); } catch { return null; }
}

// ── Project Registry Types & Helpers ─────────────────────────────────
// Unified registry: .claude/workers/registry.json
// Top-level keys: "_config" + worker names. No nested workers/panes sections.

interface RegistryConfig {
  commit_notify: string[];
  merge_authority: string;
  deploy_authority: string;
  mission_authority: string;
  tmux_session: string;
  project_name: string;
}

interface RegistryWorkerEntry {
  model: string;
  permission_mode: string;
  disallowed_tools: string[];

  status: string;
  perpetual: boolean;
  sleep_duration: number;
  cycles_completed: number;
  last_cycle_at: string | null;

  branch: string;
  worktree: string | null;
  window: string | null;

  pane_id: string | null;
  pane_target: string | null;
  tmux_session: string;
  session_id: string | null;
  session_file: string | null;

  mission_file: string;
  custom: Record<string, any>;

  // Flat org — everyone reports to someone (default: chief-of-staff)
  report_to?: string | null;
  assigned_by?: string | null;  // deprecated alias for report_to
  parent?: string | null;       // deprecated alias for report_to
  forked_from?: string | null;  // set when created with fork_from_session=true

  // Optional commit tracking
  last_commit_sha?: string;
  last_commit_msg?: string;
  last_commit_at?: string;
  issues_found?: number;
  issues_fixed?: number;
}

interface ProjectRegistry {
  _config: RegistryConfig;
  [workerName: string]: RegistryWorkerEntry | RegistryConfig;
}

const LINT_ENABLED = process.env.WORKER_FLEET_LINT !== "0";

/** Resolve report_to with backward compat (assigned_by → parent → config.mission_authority) */
function getReportTo(w: RegistryWorkerEntry, config?: RegistryConfig): string | null {
  return w.report_to || w.assigned_by || w.parent || config?.mission_authority || null;
}

/** Check if caller has authority to update target worker's state */
function canUpdateWorker(callerName: string, targetName: string, registry: ProjectRegistry): boolean {
  if (callerName === targetName) return true;
  const config = registry._config as RegistryConfig;
  if (callerName === config?.mission_authority) return true;
  const target = registry[targetName] as RegistryWorkerEntry | undefined;
  if (target && getReportTo(target, config) === callerName) return true;
  return false;
}

/** Read project registry from disk (no locking — caller handles concurrency) */
function readRegistry(): ProjectRegistry {
  const raw = readJsonFile(REGISTRY_PATH);
  if (!raw || !raw._config) {
    // Bootstrap empty registry
    return {
      _config: {
        commit_notify: ["merger"],
        merge_authority: "merger",
        deploy_authority: "merger",
        mission_authority: "chief-of-staff",
        tmux_session: "w",
        project_name: basename(PROJECT_ROOT),
      },
    };
  }
  return raw as ProjectRegistry;
}

/** Get a worker entry from registry (returns null if not found) */
function getWorkerEntry(name: string): RegistryWorkerEntry | null {
  const reg = readRegistry();
  const entry = reg[name];
  if (!entry || name === "_config") return null;
  return entry as RegistryWorkerEntry;
}

/** Atomic read-modify-write under lock. Returns the value from fn(). */
function withRegistryLocked<T>(fn: (registry: ProjectRegistry) => T): T {
  const lockPath = join(HARNESS_LOCK_DIR, "worker-registry");
  if (!acquireLock(lockPath)) {
    throw new Error("Could not acquire worker-registry lock after 10s — stale lock?");
  }
  try {
    const registry = readRegistry();
    const result = fn(registry);
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
    return result;
  } finally {
    releaseLock(join(HARNESS_LOCK_DIR, "worker-registry"));
  }
}

/** Ensure worker entry exists in registry. Creates default entry if missing. */
function ensureWorkerInRegistry(registry: ProjectRegistry, name: string): RegistryWorkerEntry {
  if (registry[name] && name !== "_config") {
    const e = registry[name] as RegistryWorkerEntry;
    if (!e.custom) e.custom = {};  // backfill missing custom field for older entries
    return e;
  }

  const projectName = PROJECT_ROOT.split("/").pop()!;
  const worktreeDir = join(PROJECT_ROOT, "..", `${projectName}-w-${name}`);

  const entry: RegistryWorkerEntry = {
    model: "opus",
    permission_mode: "bypassPermissions",
    disallowed_tools: [],
    status: "idle",
    perpetual: false,
    sleep_duration: 1800,
    cycles_completed: 0,
    last_cycle_at: null,
    branch: `worker/${name}`,
    worktree: worktreeDir,
    window: null,
    pane_id: null,
    pane_target: null,
    tmux_session: registry._config?.tmux_session || "w",
    session_id: null,
    session_file: null,
    mission_file: `.claude/workers/${name}/mission.md`,
    custom: {},
  };

  registry[name] = entry;
  return entry;
}

/** Sync tasks to filesystem tasks.json (tasks stay as separate files) */
function syncTasksToFilesystem(name: string, tasks: Record<string, Task>): void {
  try {
    const tasksPath = join(WORKERS_DIR, name, "tasks.json");
    const dir = join(WORKERS_DIR, name);
    if (existsSync(dir)) {
      writeFileSync(tasksPath, JSON.stringify(tasks, null, 2) + "\n");
    }
  } catch {}
}

/** Run registry linter checks */
function lintRegistry(registry: ProjectRegistry): DiagnosticIssue[] {
  if (!LINT_ENABLED) return [];
  const issues: DiagnosticIssue[] = [];

  for (const [name, entry] of Object.entries(registry)) {
    if (name === "_config") continue;
    const w = entry as RegistryWorkerEntry;

    // worker dir doesn't exist
    const workerDir = join(WORKERS_DIR, name);
    if (!existsSync(workerDir)) {
      issues.push({ severity: "error", check: "lint.worker_dir", message: `Worker '${name}' worker_dir doesn't exist: ${workerDir}` });
    }

    // Dead pane
    if (w.pane_id && !isPaneAlive(w.pane_id)) {
      issues.push({ severity: "warning", check: "lint.dead_pane", message: `Dead pane ${w.pane_id} (worker: ${name})`, fix: "Auto-pruned on fleet_status()" });
    }

    // worktree doesn't exist (only for non-main-branch workers)
    if (w.worktree && w.branch !== "main" && !existsSync(w.worktree)) {
      issues.push({ severity: "warning", check: "lint.worktree", message: `Worker '${name}' worktree doesn't exist: ${w.worktree}` });
    }

    // model empty
    if (!w.model) {
      issues.push({ severity: "warning", check: "lint.model", message: `Worker '${name}' has no model configured` });
    }
  }

  // Duplicate: two live panes for same worker
  const workerPanes: Record<string, string[]> = {};
  for (const [name, entry] of Object.entries(registry)) {
    if (name === "_config") continue;
    const w = entry as RegistryWorkerEntry;
    if (w.pane_id && isPaneAlive(w.pane_id)) {
      if (!workerPanes[name]) workerPanes[name] = [];
      workerPanes[name].push(w.pane_id);
    }
  }
  for (const [name, panes] of Object.entries(workerPanes)) {
    if (panes.length > 1) {
      issues.push({ severity: "warning", check: "lint.duplicate_pane", message: `Worker '${name}' has ${panes.length} live panes: ${panes.join(", ")}` });
    }
  }

  // Validate assigned_by references exist in registry (flat model — no hierarchy enforcement)
  const allWorkerNames = Object.keys(registry).filter(n => n !== "_config");
  for (const name of allWorkerNames) {
    const w = registry[name] as RegistryWorkerEntry;
    const reportTo = getReportTo(w, registry._config as RegistryConfig);
    if (reportTo && !registry[reportTo]) {
      issues.push({ severity: "warning", check: "lint.report_to_missing", message: `Worker '${name}' report_to '${reportTo}' doesn't exist in registry` });
    }
  }

  return issues;
}

/** mkdir-based spinlock matching fleet-jq.sh convention */
function acquireLock(lockPath: string, maxWaitMs = 10_000): boolean {
  const start = Date.now();
  while (true) {
    try {
      mkdirSync(lockPath, { recursive: false });
      return true;
    } catch {
      if (Date.now() - start > maxWaitMs) {
        try { execSync(`rm -rf "${lockPath}"`, { timeout: 2000 }); } catch {}
        try { mkdirSync(lockPath, { recursive: false }); return true; } catch {}
        return false;
      }
      execSync("sleep 0.1", { timeout: 1000 });
    }
  }
}

function releaseLock(lockPath: string) {
  try { execSync(`rm -rf "${lockPath}"`, { timeout: 2000 }); } catch {}
}

// ── Task CRUD Helpers ────────────────────────────────────────────────

interface Task {
  subject: string;
  description: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed" | "deleted";
  priority: "critical" | "high" | "medium" | "low";
  recurring: boolean;
  blocked_by: string[];
  metadata: Record<string, string>;
  cycles_completed: number;
  owner: string | null;
  created_at: string;
  completed_at: string | null;
  last_completed_at?: string | null;
  deleted_at?: string | null;
}

function getTasksPath(worker: string): string {
  return join(WORKERS_DIR, worker, "tasks.json");
}

function readTasks(worker: string): Record<string, Task> {
  // Read from filesystem tasks.json (tasks remain as separate files)
  const path = getTasksPath(worker);
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeTasks(worker: string, tasks: Record<string, Task>): void {
  syncTasksToFilesystem(worker, tasks);
}

/** T001, T002, ... — zero-padded, 3+ digits, finds next available */
function nextTaskId(tasks: Record<string, Task>): string {
  const ids = Object.keys(tasks);
  if (ids.length === 0) return "T001";
  const nums = ids.map(id => parseInt(id.replace(/^T/, ""), 10)).filter(n => !isNaN(n));
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  const next = max + 1;
  return next < 1000 ? `T${String(next).padStart(3, "0")}` : `T${next}`;
}

function isTaskBlocked(tasks: Record<string, Task>, taskId: string): boolean {
  const task = tasks[taskId];
  if (!task) return false;
  const deps = task.blocked_by || [];
  return deps.length > 0 && deps.some(d => tasks[d]?.status !== "completed");
}

// ── Inbox Helpers ────────────────────────────────────────────────────

function generateMsgId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

interface PendingReply {
  msg_id: string;
  from_name: string;
  summary: string;
  reply_type?: string;
  _ts: string;
}

interface InboxCursor {
  offset: number;
  last_read_at: string;
  pending_replies?: PendingReply[];
}

function getInboxPath(worker: string): string {
  return join(WORKERS_DIR, worker, "inbox.jsonl");
}

function getCursorPath(worker: string): string {
  return join(WORKERS_DIR, worker, "inbox-cursor.json");
}

function readInboxCursor(worker: string): InboxCursor | null {
  try {
    const data = JSON.parse(readFileSync(getCursorPath(worker), "utf-8"));
    if (typeof data?.offset === "number") return data as InboxCursor;
    return null;
  } catch {
    return null;
  }
}

function writeInboxCursor(worker: string, offset: number, pending_replies?: PendingReply[]): void {
  writeFileSync(getCursorPath(worker), JSON.stringify({
    offset, last_read_at: new Date().toISOString(),
    pending_replies: pending_replies || [],
  }) + "\n");
}

/** Remove a msg_id from a worker's pending replies (called when they reply with in_reply_to) */
function removePendingReply(worker: string, msgId: string): void {
  const cursor = readInboxCursor(worker);
  if (!cursor?.pending_replies?.length) return;
  const filtered = cursor.pending_replies.filter(p => p.msg_id !== msgId);
  if (filtered.length !== cursor.pending_replies.length) {
    writeInboxCursor(worker, cursor.offset, filtered);
  }
}

/** Read inbox from byte offset cursor — returns only new messages */
function readInboxFromCursor(
  worker: string,
  opts: { limit?: number; since?: string; clear?: boolean } = {}
): { messages: any[]; newOffset: number } {
  const inboxPath = getInboxPath(worker);
  if (!existsSync(inboxPath)) return { messages: [], newOffset: 0 };

  const cursor = readInboxCursor(worker);
  const startOffset = cursor?.offset ?? 0;

  let fd: number;
  try {
    fd = openSync(inboxPath, "r");
  } catch {
    return { messages: [], newOffset: 0 };
  }

  try {
    const stat = fstatSync(fd);
    const fileSize = stat.size;

    // File was truncated externally → reset to 0 (also clear pending replies)
    const wasTruncated = fileSize < startOffset;
    const readFrom = wasTruncated ? 0 : startOffset;
    const bytesToRead = fileSize - readFrom;
    const existingPending: PendingReply[] = wasTruncated ? [] : (cursor?.pending_replies || []);

    if (bytesToRead <= 0) {
      // No new data
      if (opts.clear) {
        truncateSync(inboxPath, 0);
        writeInboxCursor(worker, 0, []);
      }
      return { messages: [], newOffset: fileSize };
    }

    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, readFrom);

    const newData = buffer.toString("utf-8");
    let entries = newData.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    // Collect new pending replies from ack_required messages
    const newPending: PendingReply[] = entries
      .filter((e: any) => e.ack_required === true && e.msg_id && !e.in_reply_to)
      .map((e: any) => {
        const p: PendingReply = {
          msg_id: e.msg_id,
          from_name: e.from_name || "?",
          summary: e.summary || (e.content?.slice(0, 40) + "...") || "?",
          _ts: e._ts || new Date().toISOString(),
        };
        if (e.reply_type) p.reply_type = e.reply_type;
        return p;
      });
    const mergedPending = [...existingPending, ...newPending];

    if (opts.since) {
      entries = entries.filter(e => {
        const ts = e._ts || e.ts || e.timestamp || "";
        return ts >= opts.since!;
      });
    }

    if (opts.limit !== undefined) {
      entries = opts.limit > 0 ? entries.slice(-opts.limit) : [];
    }

    const newOffset = fileSize;

    // Write cursor with pending replies
    writeInboxCursor(worker, opts.clear ? 0 : newOffset, opts.clear ? [] : mergedPending);

    // Clear: truncate file after reading
    if (opts.clear) {
      try { truncateSync(inboxPath, 0); } catch {}
    }

    return { messages: entries, newOffset };
  } finally {
    closeSync(fd);
  }
}

/** Write a message to a worker's inbox.jsonl (durable delivery) */
function writeToInbox(
  recipientName: string,
  message: { content: string; summary?: string; from_name: string; ack_required?: boolean; in_reply_to?: string; reply_type?: string; [k: string]: any }
): { ok: true; msg_id: string } | { ok: false; error: string } {
  const workerDir = join(WORKERS_DIR, recipientName);
  if (!existsSync(workerDir)) {
    return { ok: false, error: `Worker directory not found: ${recipientName}` };
  }

  const msgId = generateMsgId();
  const inboxPath = join(workerDir, "inbox.jsonl");
  const payload: Record<string, any> = {
    msg_id: msgId,
    to: `worker/${recipientName}`,
    from: `worker/${message.from_name}`,
    from_name: message.from_name,
    content: message.content,
    summary: message.summary || message.content.slice(0, 60),
    ack_required: message.ack_required !== false,
    in_reply_to: message.in_reply_to || null,
    msg_type: "message",
    channel: "worker-message",
    _ts: new Date().toISOString(),
  };
  if (message.reply_type) payload.reply_type = message.reply_type;

  try {
    appendFileSync(inboxPath, JSON.stringify(payload) + "\n");
    return { ok: true, msg_id: msgId };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Resolve recipient — worker name, "report", "direct_reports", or raw pane ID */
function resolveRecipient(to: string): {
  type: "worker" | "pane" | "multi_pane";
  workerName?: string;
  paneId?: string;
  paneIds?: string[];
  error?: string;
} {
  // Raw pane ID
  if (to.startsWith("%")) {
    return { type: "pane", paneId: to };
  }

  // "report" — find who this worker reports to (report_to → assigned_by → parent → mission_authority)
  if (to === "report") {
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      const myEntry = registry[WORKER_NAME] as RegistryWorkerEntry | undefined;
      const reportToName = myEntry ? getReportTo(myEntry, config) : config?.mission_authority;
      if (reportToName && reportToName !== WORKER_NAME) {
        const reportToEntry = registry[reportToName] as RegistryWorkerEntry | undefined;
        if (reportToEntry?.pane_id && isPaneAlive(reportToEntry.pane_id)) {
          if (existsSync(join(WORKERS_DIR, reportToName))) {
            return { type: "worker", workerName: reportToName };
          }
          return { type: "pane", paneId: reportToEntry.pane_id };
        }
        return { type: "pane", error: `'${reportToName}' (report_to for '${WORKER_NAME}') has no live pane` };
      }
      return { type: "pane", error: `No report_to found for worker '${WORKER_NAME}'` };
    } catch {
      return { type: "pane", error: "Failed to read registry" };
    }
  }

  // "direct_reports" — find all workers who report_to this worker
  if (to === "direct_reports") {
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      const paneIds: string[] = [];
      for (const [name, entry] of Object.entries(registry)) {
        if (name === "_config") continue;
        const w = entry as RegistryWorkerEntry;
        const reportTo = getReportTo(w, config);
        if (reportTo === WORKER_NAME && w.pane_id && isPaneAlive(w.pane_id)) {
          paneIds.push(w.pane_id);
        }
      }
      if (paneIds.length === 0) {
        return { type: "multi_pane", paneIds: [], error: "No workers reporting to you have live panes" };
      }
      return { type: "multi_pane", paneIds };
    } catch {
      return { type: "multi_pane", error: "Failed to read registry" };
    }
  }

  // Worker name
  return { type: "worker", workerName: to };
}

/** Send text + Enter to a tmux pane. Uses -H 0d for Enter (not literal \n which tmux ignores).
 *  Uses spawnSync (no shell) to avoid backtick/dollar-sign interpretation that was
 *  silently truncating messages containing code references like `--service web`.
 *  Sends Enter 3 times with 300ms delays — Claude's TUI sometimes misses a single Enter
 *  if the pane isn't fully focused/rendered yet. Extra Enters on an idle prompt are harmless. */
function tmuxSendMessage(paneId: string, text: string): void {
  // Use load-buffer + paste-buffer for reliable delivery of any length.
  // send-keys silently truncates long text (terminal input buffer limit).
  const tmpFile = join(process.env.HOME || "/tmp", `.claude-ops/tmp/msg-${Date.now()}.txt`);
  try {
    const tmpDir = join(process.env.HOME || "/tmp", ".claude-ops/tmp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, text);
    spawnSync("tmux", ["load-buffer", tmpFile], { timeout: 5000 });
    spawnSync("tmux", ["paste-buffer", "-t", paneId, "-d"], { timeout: 5000 });
  } finally {
    try { rmSync(tmpFile); } catch {}
  }
  // Single Enter to submit (paste-buffer already inserted the text)
  spawnSync("sleep", ["0.3"]);
  spawnSync("tmux", ["send-keys", "-t", paneId, "-H", "0d"], { timeout: 5000 });
}

/** Check if a tmux pane is alive */
function isPaneAlive(paneId: string): boolean {
  try {
    const result = spawnSync("tmux", ["has-session", "-t", paneId], {
      encoding: "utf-8", timeout: 3000,
    });
    if (result.status !== 0) return false;
    // has-session checks the session, but we need to verify the pane specifically
    const check = spawnSync("tmux", ["display-message", "-t", paneId, "-p", "#{pane_id}"], {
      encoding: "utf-8", timeout: 3000,
    });
    return check.status === 0 && check.stdout.trim() === paneId;
  } catch {
    return false;
  }
}

// ── Pane & Session Helpers ───────────────────────────────────────────

/** Find this worker's pane. Prefers TMUX_PANE env (exact), falls back to registry search. */
function findOwnPane(): { paneId: string; paneTarget: string } | null {
  const tmuxPane = process.env.TMUX_PANE;
  if (tmuxPane) {
    // Check if registry has matching pane_id for our worker
    const entry = getWorkerEntry(WORKER_NAME);
    if (entry?.pane_id === tmuxPane) {
      return { paneId: tmuxPane, paneTarget: entry.pane_target || "" };
    }
    // Resolve from tmux directly
    try {
      const target = execSync(
        `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${tmuxPane}" '$1 == id {print $2}'`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (target) return { paneId: tmuxPane, paneTarget: target };
    } catch {}
    return { paneId: tmuxPane, paneTarget: "" };
  }

  // Fallback: search registry by worker name
  const entry = getWorkerEntry(WORKER_NAME);
  if (entry?.pane_id) {
    return { paneId: entry.pane_id, paneTarget: entry.pane_target || "" };
  }
  return null;
}

/** Read Claude session ID from the pane-map (written by statusline-command.sh) */
function getSessionId(paneId: string): string | null {
  const paneMapPath = join(HOME, ".claude/pane-map/by-pane", paneId);
  try { return readFileSync(paneMapPath, "utf-8").trim(); } catch { return null; }
}

/** Read worker's model from registry */
function getWorkerModel(): string {
  try {
    const entry = getWorkerEntry(WORKER_NAME);
    return entry?.model || "opus";
  } catch { return "opus"; }
}

/** Compute the worktree directory path (PROJECT_ROOT/../ProjectName-w-WORKER) */
function getWorktreeDir(): string {
  const projectName = PROJECT_ROOT.split("/").pop()!;
  return join(PROJECT_ROOT, "..", `${projectName}-w-${WORKER_NAME}`);
}

/** Generate the seed prompt content for a worker (same template as launch-flat-worker.sh) */
function generateSeedContent(handoff?: string): string {
  const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
  const worktreeDir = getWorktreeDir();
  const branch = `worker/${WORKER_NAME}`;

  let seed = `You are worker **${WORKER_NAME}**.
Worktree: ${worktreeDir} (branch: ${branch})
Worker config: ${workerDir}/

Read these files NOW in this order:
1. ${workerDir}/mission.md — your goals and tasks
2. Call \`get_worker_state()\` — your current cycle count and status (stored in registry.json)
3. Check \`.claude/scripts/${WORKER_NAME}/\` for existing scripts

Your MEMORY.md is auto-loaded by Claude (see "persistent auto memory directory" in your context).
Use Edit/Write to update it directly at that path. Then begin your cycle immediately.

## Cycle Pattern

Every cycle follows this sequence:

1. **Heartbeat** — \`heartbeat(cycles_completed=N)\` — auto-registers your pane + stamps cycle state in one call
2. **Drain inbox** — \`read_inbox()\` — act on messages before anything else (cursor-based, no data loss)
3. **Create tasks** — If your task list is empty or stale, read your mission.md and \`create_task\` for each goal. As you explore the codebase, \`create_task\` for discovered work items too. Your tasks are your contract with the fleet — keep them current.
4. **Check tasks** — \`list_tasks(filter="pending")\` — find highest-priority unblocked work
5. **Claim** — \`update_task(task_id="T00N", status="in_progress")\` — mark what you're working on
6. **Do the work** — investigate, fix, test, commit, deploy, verify
7. **Complete** — \`update_task(task_id="T00N", status="completed")\` — only after fully verified
8. **Perpetual?** — if \`perpetual: true\`, sleep for \`sleep_duration\` seconds, then loop

If your inbox has a message from Warren or chief-of-staff, prioritize it over your current task list.

## MCP Tools (\`mcp__worker-fleet__*\`)

| Tool | What it does |
|------|-------------|
| \`send_message(to, content, summary, fyi?, in_reply_to?, reply_type?)\` | Send to a worker; \`fyi=true\` = no reply needed; \`in_reply_to="msg_id"\` to ack; \`reply_type="e2e_verify"\` to tag expected reply type |
| \`read_inbox(limit?, since?, clear?)\` | Read your inbox; messages marked [NEEDS REPLY] require a response via \`in_reply_to\` |
| \`create_task(subject, priority?, ...)\` | Add a task to your task list |
| \`update_task(task_id, status?, subject?, owner?, ...)\` | Update task status/fields — claim, complete, delete, reassign |
| \`list_tasks(filter?, worker?)\` | List tasks; \`worker="all"\` for cross-worker view |
| \`get_worker_state(name?)\` | Read any worker's state from registry.json |
| \`update_state(key, value)\` | Update your state in registry.json + emit bus event |
| \`fleet_status()\` | Full fleet overview (all workers) |
| \`recycle(message?)\` | Self-recycle: write handoff, restart fresh with new context |
| \`create_worker(name, mission, launch=true, fork_from_session=true)\` | Fork yourself into a new worker with your conversation context |
| \`heartbeat(cycles_completed?, extra?)\` | Call at start of each cycle: auto-registers pane + stamps last_cycle_at, status, cycles_completed |
| \`deregister(name)\` | Remove a worker from the registry (rename = create_worker + deregister) |
| \`reload()\` | Hot-restart: exit + resume same session to pick up new MCP config |

These are native MCP tool calls — no bash wrappers needed.

## Rules
- **Use your MCP tools proactively.** The worker-fleet MCP tools (\`mcp__worker-fleet__*\`) are your primary affordances for coordination, state management, and task tracking. Each tool provides capabilities that make you more effective and visible to the fleet — use them whenever appropriate, not just when explicitly told.
- **Fix everything.** Never just report issues — investigate, fix, deploy, document in MEMORY.md.
- **Git discipline**: Stage only specific files (\`git add src/foo.ts\`). NEVER \`git add -A\`. Commit to branch **${branch}** only. Never checkout main.
- **Deploy**: TEST only. See your mission.md for project-specific deploy commands.
- **Verify before completing**: Tests pass + TypeScript clean + deploy succeeds + endpoint/UI verified.
- **Report everything to chief-of-staff via MCP**: On any bug, error, test failure, completed task, or finding worth noting — use \`send_message(to="chief-of-staff", content="...", summary="...")\`. Never append to inbox.jsonl directly. Never silently move on.
- **Send results back**: When your mission produces output (analysis, compiled data, recommendations) — send it to chief-of-staff via \`send_message\`.

## If You Run Continuously (Perpetual Mode)

Each cycle: **Observe → Decide → Act → Measure → Adapt** — you're an LLM, not a cron job. Adapt.

- **Save learnings**: Edit your MEMORY.md (auto-loaded path — see "persistent auto memory directory" in your context). Claude picks it up next session automatically.
- **Scripts first**: Check \`.claude/scripts/${WORKER_NAME}/\` before writing inline bash. If you do something twice, save it as a script there. Scripts persist across recycles; one-off bash commands don't.
- **Adapt sleep**: Call \`update_state("sleep_duration", N)\` to tune your cycle interval.
- **Discover new work**: Read server logs, other workers' MEMORY.md, Nexus for issues in your domain.
- **Eliminate waste**: Skip checks that never change; cache expensive lookups.`;

  if (handoff) {
    seed += `\n\n## Handoff from Previous Cycle\n\n${handoff}`;
  }

  // Also check for handoff.md on disk
  const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
  if (!handoff && existsSync(handoffPath)) {
    try {
      const handoffContent = readFileSync(handoffPath, "utf-8").trim();
      if (handoffContent) {
        seed += `\n\n## Handoff from Previous Cycle\n\n${handoffContent}`;
      }
    } catch {}
  }

  return seed;
}

// ── Diagnostics ─────────────────────────────────────────────────────

interface DiagnosticIssue {
  severity: "error" | "warning";
  check: string;
  message: string;
  fix?: string;
}

function runDiagnostics(): DiagnosticIssue[] {
  const issues: DiagnosticIssue[] = [];

  // ── Environment ──

  if (WORKER_NAME === "operator") {
    issues.push({ severity: "warning", check: "env.WORKER_NAME", message: "Worker name defaulted to 'operator' — not on a worker/* branch and WORKER_NAME not set", fix: "Set WORKER_NAME env or checkout a worker/* branch" });
  }

  // ── Worker config dir ──
  const workerDir = join(WORKERS_DIR, WORKER_NAME);
  if (!existsSync(workerDir)) {
    issues.push({ severity: "error", check: "worker_dir", message: `Worker dir missing: ${workerDir}`, fix: `mkdir -p ${workerDir}` });
  } else {
    // mission.md
    const missionPath = join(workerDir, "mission.md");
    if (!existsSync(missionPath)) {
      issues.push({ severity: "error", check: "mission.md", message: "mission.md missing — worker has no goals", fix: `Create ${missionPath} with task list and goals` });
    } else {
      try {
        const content = readFileSync(missionPath, "utf-8").trim();
        if (content.length < 10) issues.push({ severity: "warning", check: "mission.md", message: "mission.md is nearly empty", fix: "Add goals and tasks to mission.md" });
      } catch {}
    }

    // Registry entry (replaces state.json + permissions.json checks)
    const regEntry = getWorkerEntry(WORKER_NAME);
    if (!regEntry) {
      issues.push({ severity: "error", check: "registry_entry", message: `Worker '${WORKER_NAME}' not in registry.json`, fix: "Run migration or call create_worker to bootstrap entry, then heartbeat() to register" });
    } else {
      if (typeof regEntry.cycles_completed !== "number") {
        issues.push({ severity: "warning", check: "registry.cycles_completed", message: "registry entry missing 'cycles_completed' field", fix: `update_state("cycles_completed", 0)` });
      }
      if (!regEntry.status) {
        issues.push({ severity: "warning", check: "registry.status", message: "registry entry missing 'status' field", fix: `update_state("status", "idle")` });
      }
      if (!regEntry.model) {
        issues.push({ severity: "warning", check: "registry.model", message: "registry entry missing 'model' field — defaulting to opus", fix: `update_state("model", "opus")` });
      }
    }

    // tasks.json (if exists, validate)
    const tasksPath = join(workerDir, "tasks.json");
    if (existsSync(tasksPath)) {
      const tasks = readJsonFile(tasksPath);
      if (!tasks) {
        issues.push({ severity: "error", check: "tasks.json", message: "tasks.json is invalid JSON", fix: `Fix or delete ${tasksPath} (will be recreated on create_task)` });
      }
    }

    // inbox.jsonl (if exists, validate last line)
    const inboxPath = join(workerDir, "inbox.jsonl");
    if (existsSync(inboxPath)) {
      try {
        const content = readFileSync(inboxPath, "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        if (lines.length > 0) {
          const lastLine = lines[lines.length - 1];
          try { JSON.parse(lastLine); } catch {
            issues.push({ severity: "warning", check: "inbox.jsonl", message: "inbox.jsonl has corrupt last line — may cause read errors", fix: `read_inbox(clear=true) to reset, or manually fix ${inboxPath}` });
          }
        }
      } catch {}
    }
  }

  // ── Git branch (uses cached value from module load — no subprocess) ──
  if (_cachedBranch && WORKER_NAME !== "operator") {
    const expectedBranch = `worker/${WORKER_NAME}`;
    if (_cachedBranch !== expectedBranch) {
      issues.push({ severity: "warning", check: "git.branch", message: `On branch '${_cachedBranch}' but expected '${expectedBranch}'`, fix: `git checkout ${expectedBranch}` });
    }
  }

  // ── Worktree ──
  if (WORKER_NAME !== "operator") {
    const worktreeDir = getWorktreeDir();
    if (!existsSync(worktreeDir)) {
      issues.push({ severity: "warning", check: "worktree", message: `Worktree dir not found: ${worktreeDir}`, fix: `git -C ${PROJECT_ROOT} worktree add ${worktreeDir} -b worker/${WORKER_NAME}` });
    }
  }

  // ── Registry ──
  if (process.env.TMUX_PANE) {
    const entry = getWorkerEntry(WORKER_NAME);
    if (!entry) {
      issues.push({ severity: "error", check: "registry", message: `Worker '${WORKER_NAME}' not in registry.json — watchdog cannot monitor you. Call heartbeat() BEFORE doing anything else.`, fix: "Call heartbeat() immediately" });
    } else if (entry.pane_id !== process.env.TMUX_PANE) {
      issues.push({ severity: "error", check: "registry.pane_id", message: `Pane ${process.env.TMUX_PANE} not registered for '${WORKER_NAME}' in registry.json. Call heartbeat() to fix.`, fix: "Call heartbeat() immediately" });
    }
  } else {
    issues.push({ severity: "error", check: "env.TMUX_PANE", message: "TMUX_PANE not set — you are not registered with the fleet. Messaging, watchdog monitoring, and recycle will NOT work.", fix: "Launch via launch-flat-worker.sh or call heartbeat()" });
  }

  // ── Registry linter ──
  try {
    const registry = readRegistry();
    const lintIssues = lintRegistry(registry);
    issues.push(...lintIssues);
  } catch {}

  // ── Required scripts ──
  const requiredScripts: [string, string][] = [
    [CHECK_WORKERS_SH, "fleet_status"],
  ];
  for (const [scriptPath, toolName] of requiredScripts) {
    if (!existsSync(scriptPath)) {
      issues.push({ severity: "warning", check: `script.${toolName}`, message: `Script missing for ${toolName}: ${scriptPath}`, fix: `Ensure file exists at ${scriptPath}` });
    }
  }

  // ── Git hooks ──
  // Verify required hooks are installed in the worktree (or main repo for main-branch workers)
  try {
    const worktreeDir = getWorktreeDir();
    let gitDir: string;
    try {
      gitDir = execSync(`git -C "${worktreeDir}" rev-parse --git-dir 2>/dev/null`, { encoding: "utf-8", timeout: 5000, shell: "/bin/bash" }).trim();
      if (!gitDir.startsWith("/")) gitDir = join(worktreeDir, gitDir);
    } catch {
      gitDir = join(worktreeDir, ".git");
    }
    const hooksDir = join(gitDir, "hooks");

    const requiredHooks: [string, string][] = [
      ["post-commit", "Auto-notify merger/chief-of-staff on commit"],
      ["commit-msg", "Auto-add Worker:/Cycle: trailers to commit messages"],
    ];
    for (const [hookName, desc] of requiredHooks) {
      const hookPath = join(hooksDir, hookName);
      if (!existsSync(hookPath)) {
        issues.push({ severity: "warning", check: `git.hook.${hookName}`, message: `Git ${hookName} hook not installed — ${desc}`, fix: `Relaunch with launch-flat-worker.sh to install hooks, or manually copy from ~/.claude-ops/scripts/worker-${hookName.replace("-", "-")}-hook.sh` });
      } else {
        // Check it's executable
        try {
          const stat = statSync(hookPath);
          if (!(stat.mode & 0o111)) {
            issues.push({ severity: "warning", check: `git.hook.${hookName}`, message: `Git ${hookName} hook exists but is not executable`, fix: `chmod +x ${hookPath}` });
          }
        } catch {}
      }
    }
  } catch {
    // Can't resolve git dir — skip hook checks
  }

  return issues;
}

// ── Cached diagnostics — 3 min TTL, lazy on first tool call ─────────
let _diagCache: { issues: DiagnosticIssue[]; ts: number } | null = null;
const DIAG_CACHE_TTL_MS = 10_000; // 10 seconds
let _firstCallDone = false;

function getCachedDiagnostics(): DiagnosticIssue[] {
  if (_diagCache && Date.now() - _diagCache.ts < DIAG_CACHE_TTL_MS) return _diagCache.issues;
  const issues = runDiagnostics();
  _diagCache = { issues, ts: Date.now() };
  return issues;
}

/** Prepend critical diagnostic errors to a tool response on the very first tool call */
function withStartupDiagnostics(result: { content: { type: "text"; text: string }[] }): typeof result {
  if (_firstCallDone) return result;
  _firstCallDone = true;
  const issues = getCachedDiagnostics();
  const errors = issues.filter(i => i.severity === "error");
  if (errors.length === 0) return result;
  const prefix = "⚠ Config errors detected (run check_config for full report):\n" +
    errors.map(i => `  ✘ [${i.check}] ${i.message}${i.fix ? ` → ${i.fix}` : ""}`).join("\n") +
    "\n\n";
  return {
    content: [{ type: "text" as const, text: prefix + result.content[0].text }],
  };
}

/** Append pending reply reminder to any tool response (called on most tool handlers) */
function withPendingReminder(result: { content: { type: "text"; text: string }[] }): typeof result {
  const cursor = readInboxCursor(WORKER_NAME);
  const pending = cursor?.pending_replies || [];
  if (pending.length === 0) return result;

  const suffix = `\n\n⚠ ${pending.length} PENDING REPLY(S):\n` +
    pending.map(p => {
      const typeTag = p.reply_type ? `[${p.reply_type}] ` : "";
      return `  ${typeTag}${p.msg_id} from ${p.from_name}: "${p.summary}"`;
    }).join("\n") +
    `\nReply: send_message(to=<sender>, in_reply_to="<msg_id>", content="...", summary="...")`;

  return {
    content: [{ type: "text" as const, text: result.content[0].text + suffix }],
  };
}

// ── MCP Server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "worker-fleet",
  version: "2.0.0",
});

// ═══════════════════════════════════════════════════════════════════
// MESSAGING TOOLS (3)
// ═══════════════════════════════════════════════════════════════════

server.registerTool(
  "send_message",
  { description: `Primary inter-worker communication. Messages require a reply by default — the recipient is reminded at recycle/standby if they haven't replied. Use fyi=true for informational messages that don't need a response. Use in_reply_to with a msg_id to acknowledge a message you received. Writes to the recipient's durable inbox (survives restarts) and delivers instantly via tmux if the pane is live. Use to="all" to broadcast fleet-wide (expensive — use sparingly). Use to="report" to message who you report_to. Use to="direct_reports" to message all workers who report_to you.`, inputSchema: {
    to: z.string().describe("Worker name, 'report', 'direct_reports', 'all' (broadcast to every worker), or raw pane ID '%NN'"),
    content: z.string().describe("Message content"),
    summary: z.string().describe("Short preview (5-10 words)"),
    fyi: z.boolean().optional().describe("If true, no reply expected — informational only (default: false = reply expected)"),
    in_reply_to: z.string().optional().describe("msg_id of a message you're replying to — marks it as acknowledged"),
    reply_type: z.string().optional().describe("What kind of reply is expected: 'ack' (simple acknowledgment), 'e2e_verify' (verify on main test and confirm), 'review' (review and provide feedback). Stored in message and shown in pending replies."),
  } },
  async ({ to, content, summary, fyi, in_reply_to, reply_type }) => {
    // Broadcast path: to="all" sends to every worker's inbox (defaults to fyi=true)
    if (to === "all") {
      const broadcastFyi = fyi !== false; // broadcasts are FYI unless explicitly fyi=false
      const failures: string[] = [];
      const successes: string[] = [];
      try {
        const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
          .map(d => d.name)
          .filter(name => name !== WORKER_NAME);
        for (const name of dirs) {
          const result = writeToInbox(name, { content, summary, from_name: WORKER_NAME, ack_required: !broadcastFyi, reply_type });
          if (result.ok) successes.push(name);
          else failures.push(`${name}: ${result.error}`);
        }
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error listing workers: ${e.message}` }], isError: true };
      }
      // Fire bus for tmux delivery (best-effort)
      try {
        const args = ["broadcast", content];
        if (summary) args.push("--summary", summary);
        runScript(WORKER_MESSAGE_SH, args, { timeout: 10_000 });
      } catch {}
      let msg = `Broadcast to ${successes.length} workers`;
      if (failures.length > 0) msg += `\nFailed: ${failures.join(", ")}`;
      return { content: [{ type: "text" as const, text: msg }] };
    }

    const resolved = resolveRecipient(to);

    if (resolved.error) {
      return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }], isError: true };
    }

    // Multi-pane (children) — tmux delivery to each child
    if (resolved.type === "multi_pane") {
      const paneIds = resolved.paneIds!;
      const successes: string[] = [];
      const failures: string[] = [];
      const dead: string[] = [];
      for (const pId of paneIds) {
        if (!isPaneAlive(pId)) {
          dead.push(pId);
          continue;
        }
        try {
          tmuxSendMessage(pId, `[msg from ${WORKER_NAME}] ${content}`);
          successes.push(pId);
        } catch {
          failures.push(pId);
        }
      }
      let result = successes.length > 0
        ? `Sent to ${successes.length} direct reports: ${successes.join(", ")}`
        : "No live direct reports to deliver to";
      if (dead.length > 0) result += `\nDead panes (skipped): ${dead.join(", ")}`;
      if (failures.length > 0) result += `\nFailed: ${failures.join(", ")}`;
      return { content: [{ type: "text" as const, text: result }], isError: successes.length === 0 };
    }

    // Raw pane ID or report pane — tmux-only delivery (no inbox)
    if (resolved.type === "pane") {
      if (!isPaneAlive(resolved.paneId!)) {
        return { content: [{ type: "text" as const, text: `Error: Pane ${resolved.paneId} is dead (not found in tmux)` }], isError: true };
      }
      try {
        tmuxSendMessage(resolved.paneId!, `[msg from ${WORKER_NAME}] ${content}`);
        const label = to === "report" ? `report (pane ${resolved.paneId})` : `pane ${resolved.paneId}`;
        return { content: [{ type: "text" as const, text: `Sent to ${label} (tmux-only, no inbox)` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error sending to pane: ${e.message}` }], isError: true };
      }
    }

    // Worker name — durable inbox + best-effort bus
    const recipientName = resolved.workerName!;

    // Pane-alive check: warn before writing if worker has no live pane
    let paneWarning = "";
    try {
      const registry = readRegistry();
      const entry = registry[recipientName] as RegistryWorkerEntry | undefined;
      const paneId = entry?.pane_id;
      if (!paneId || !isPaneAlive(paneId)) {
        paneWarning = `\nWARNING: Worker '${recipientName}' has no active pane — message queued in inbox but won't be received until the worker is restarted.`;
      }
    } catch { /* registry read failed, skip check */ }

    // Step 1: Write to inbox (critical — must succeed)
    const inboxResult = writeToInbox(recipientName, {
      content, summary, from_name: WORKER_NAME,
      ack_required: !fyi,
      in_reply_to,
      reply_type,
    });
    if (!inboxResult.ok) {
      return { content: [{ type: "text" as const, text: `Error: ${inboxResult.error}` }], isError: true };
    }

    // If replying to a message, mark it as acked in our pending replies
    if (in_reply_to) {
      removePendingReply(WORKER_NAME, in_reply_to);
    }

    // Step 2: Tmux instant delivery (best-effort)
    // Prefer direct pane_id from registry.json (flat workers don't appear in pane-registry.json)
    try {
      const registry = readRegistry();
      const entry = registry[recipientName] as RegistryWorkerEntry | undefined;
      const paneId = entry?.pane_id;
      if (paneId && isPaneAlive(paneId)) {
        tmuxSendMessage(paneId, `[msg from ${WORKER_NAME}] ${content}`);
      } else {
        // Fall back to worker-message.sh (uses legacy pane-registry.json)
        const args = ["send", recipientName, content];
        if (summary) args.push("--summary", summary);
        runScript(WORKER_MESSAGE_SH, args, { timeout: 10_000 });
      }
    } catch {
      // Tmux delivery failed — inbox already delivered, that's fine
    }

    const ackNote = fyi ? " (fyi, no reply needed)" : "";
    const replyNote = in_reply_to ? ` (acked ${in_reply_to})` : "";
    const typeNote = reply_type ? ` (reply_type: ${reply_type})` : "";
    return withPendingReminder({ content: [{ type: "text" as const, text: `Message sent to ${recipientName} [${inboxResult.msg_id}]${ackNote}${replyNote}${typeNote}${paneWarning}` }] });
  }
);


server.registerTool(
  "read_inbox",
  { description: "Read messages sent to you by other workers or Warren. Call at the start of every cycle to act on pending instructions before checking tasks. Uses a cursor so repeated calls only return new messages — no data loss on restart. Use clear=true only if you want to explicitly purge old messages.", inputSchema: {
    limit: z.number().optional().describe("Max messages to return (default: all)"),
    since: z.string().optional().describe("ISO timestamp — only messages after this time"),
    clear: z.boolean().optional().describe("If true, clear inbox after reading (replaces clear_inbox)"),
  } },
  async ({ limit, since, clear }) => {
    try {
      const { messages } = readInboxFromCursor(WORKER_NAME, { limit, since, clear });

      if (messages.length === 0) {
        return withStartupDiagnostics({ content: [{ type: "text" as const, text: clear ? "Inbox cleared (was empty)" : "No new messages" }] });
      }

      const formatted = messages.map(m => {
        const from = m.from_name || m.from || "?";
        const type = m.msg_type || "message";
        const text = m.content || m.message || "";
        const ts = m._ts || m.ts || "";
        const id = m.msg_id ? ` [${m.msg_id}]` : "";
        const ackTag = (m.ack_required === true) ? " [NEEDS REPLY]" : "";
        const replyTag = m.in_reply_to ? ` (reply to ${m.in_reply_to})` : "";
        return `[${type}]${id} from ${from}${ts ? ` at ${ts}` : ""}${ackTag}${replyTag}: ${text}`;
      }).join("\n");

      // Append pending replies summary
      const cursor = readInboxCursor(WORKER_NAME);
      const pending = cursor?.pending_replies || [];
      let pendingSuffix = "";
      if (pending.length > 0) {
        pendingSuffix = `\n\n--- ${pending.length} PENDING REPLIES ---\n` +
          pending.map(p => {
            const typeTag = p.reply_type ? `[${p.reply_type}] ` : "";
            return `  ${typeTag}${p.msg_id} from ${p.from_name}: "${p.summary}" (${p._ts})`;
          }).join("\n") +
          `\nReply with: send_message(to=<sender>, in_reply_to="<msg_id>", content="...", summary="...")`;
      }

      const suffix = clear ? " (inbox cleared)" : "";
      return withStartupDiagnostics({ content: [{ type: "text" as const, text: `${messages.length} messages${suffix}:\n${formatted}${pendingSuffix}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// TASK TOOLS (3) — native TS, no shell subprocess
// ═══════════════════════════════════════════════════════════════════

server.registerTool(
  "create_task",
  { description: "Track a unit of work you've identified. Use whenever you discover a bug, feature, or investigation that needs doing — even mid-cycle. Tasks survive recycles, can block each other, and give the team visibility into your queue. Prefer creating tasks over holding work in context.", inputSchema: {
    subject: z.string().describe("Task title (imperative form)"),
    description: z.string().optional().describe("Detailed description"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Priority level (default: medium)"),
    active_form: z.string().optional().describe("Present continuous label for spinner (e.g. 'Running tests')"),
    blocks: z.string().optional().describe("Comma-separated task IDs that this task blocks (e.g. 'T003,T004')"),
    blocked_by: z.string().optional().describe("Comma-separated task IDs that block this (e.g. 'T001,T002')"),
    recurring: z.boolean().optional().describe("If true, resets to pending when completed"),
  } },
  async ({ subject, description, priority, active_form, blocks, blocked_by, recurring }) => {
    try {
      const tasks = readTasks(WORKER_NAME);
      const taskId = nextTaskId(tasks);
      const now = new Date().toISOString();

      const blockedByList = blocked_by
        ? blocked_by.split(",").map(s => s.trim()).filter(Boolean)
        : [];

      const task: Task = {
        subject,
        description: description || "",
        activeForm: active_form || `Working on: ${subject}`,
        status: "pending",
        priority: (priority as Task["priority"]) || "medium",
        recurring: recurring || false,
        blocked_by: blockedByList,
        metadata: {},
        cycles_completed: 0,
        owner: null,
        created_at: now,
        completed_at: null,
      };

      tasks[taskId] = task;

      // Forward-blocking: add taskId to blocked_by of specified tasks
      if (blocks) {
        const blocksList = blocks.split(",").map(s => s.trim()).filter(Boolean);
        for (const targetId of blocksList) {
          if (tasks[targetId]) {
            const existing = tasks[targetId].blocked_by || [];
            if (!existing.includes(taskId)) {
              tasks[targetId].blocked_by = [...existing, taskId];
            }
          }
        }
      }

      writeTasks(WORKER_NAME, tasks);

      let suffix = ` [${task.priority}]`;
      if (recurring) suffix += " (recurring)";
      if (blockedByList.length > 0) suffix += ` (after: ${blockedByList.join(",")})`;
      if (blocks) suffix += ` (blocks: ${blocks})`;

      return withPendingReminder({ content: [{ type: "text" as const, text: `Added ${taskId}: ${subject}${suffix}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "update_task",
  { description: "Advance a task through its lifecycle or reassign it. Claim work with status='in_progress' before starting (prevents double-work across workers). Mark 'completed' only after fully verified. Use 'deleted' to discard irrelevant tasks. Set add_blocked_by to express dependencies that gate execution.", inputSchema: {
    task_id: z.string().describe("Task ID (e.g. 'T001')"),
    status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional().describe("New status"),
    subject: z.string().optional().describe("New subject"),
    description: z.string().optional().describe("New description"),
    active_form: z.string().optional().describe("Present continuous label for spinner"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("New priority"),
    owner: z.string().optional().describe("New owner (worker name)"),
    add_blocked_by: z.string().optional().describe("Comma-separated task IDs to add as blockers"),
    add_blocks: z.string().optional().describe("Comma-separated task IDs this task should block"),
  } },
  async ({ task_id, status, subject, description, active_form, priority, owner, add_blocked_by, add_blocks }) => {
    try {
      const tasks = readTasks(WORKER_NAME);
      const task = tasks[task_id];

      if (!task) {
        return { content: [{ type: "text" as const, text: `Error: Task ${task_id} not found` }], isError: true };
      }

      const changes: string[] = [];
      const now = new Date().toISOString();

      // Status transitions
      if (status) {
        if (status === "in_progress") {
          if (task.status === "completed") {
            return { content: [{ type: "text" as const, text: `Error: Task ${task_id} already completed` }], isError: true };
          }
          if (task.status === "deleted") {
            return { content: [{ type: "text" as const, text: `Error: Task ${task_id} has been deleted` }], isError: true };
          }
          if (isTaskBlocked(tasks, task_id)) {
            const blockers = (task.blocked_by || []).filter(d => tasks[d]?.status !== "completed");
            return { content: [{ type: "text" as const, text: `Error: Task ${task_id} blocked by: ${blockers.join(", ")}` }], isError: true };
          }
          task.status = "in_progress";
          task.owner = owner || WORKER_NAME;
          changes.push("claimed");
        } else if (status === "completed") {
          if (task.recurring) {
            task.status = "pending";
            task.owner = null;
            task.completed_at = null;
            task.last_completed_at = now;
            task.cycles_completed = (task.cycles_completed || 0) + 1;
            changes.push(`completed (recurring — reset to pending, cycle #${task.cycles_completed})`);
          } else {
            task.status = "completed";
            task.completed_at = now;
            changes.push("completed");
          }
        } else if (status === "deleted") {
          task.status = "deleted";
          task.deleted_at = now;
          changes.push("deleted");
        } else if (status === "pending") {
          task.status = "pending";
          changes.push("set to pending");
        }
      }

      // Field updates
      if (subject) { task.subject = subject; changes.push("subject updated"); }
      if (description !== undefined) { task.description = description; changes.push("description updated"); }
      if (active_form) { task.activeForm = active_form; changes.push("activeForm updated"); }
      if (priority) { task.priority = priority; changes.push(`priority → ${priority}`); }
      if (owner && !status) { task.owner = owner; changes.push(`owner → ${owner}`); }

      // Dependency updates
      if (add_blocked_by) {
        const ids = add_blocked_by.split(",").map(s => s.trim()).filter(Boolean);
        task.blocked_by = [...new Set([...(task.blocked_by || []), ...ids])];
        changes.push(`blocked by: ${ids.join(",")}`);
      }
      if (add_blocks) {
        const ids = add_blocks.split(",").map(s => s.trim()).filter(Boolean);
        for (const targetId of ids) {
          if (tasks[targetId]) {
            const existing = tasks[targetId].blocked_by || [];
            if (!existing.includes(task_id)) {
              tasks[targetId].blocked_by = [...existing, task_id];
            }
          }
        }
        changes.push(`blocks: ${ids.join(",")}`);
      }

      if (changes.length === 0) {
        return { content: [{ type: "text" as const, text: `No changes specified for ${task_id}` }] };
      }

      writeTasks(WORKER_NAME, tasks);
      return withPendingReminder({ content: [{ type: "text" as const, text: `Updated ${task_id}: ${changes.join(", ")}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "list_tasks",
  { description: "Survey available work before starting a cycle. Use filter='pending' to find unblocked tasks ready to claim. Use worker='all' to see the full fleet's queue and avoid duplicating work another worker is already doing.", inputSchema: {
    filter: z.enum(["all", "pending", "in_progress", "blocked"]).optional()
      .describe("Filter by status (default: all non-deleted)"),
    worker: z.string().optional()
      .describe("Specific worker name, or 'all' for cross-worker view (default: self)"),
  } },
  async ({ filter, worker }) => {
    try {
      const targetWorkers: string[] = [];
      const workerName = worker || WORKER_NAME;

      if (workerName === "all") {
        const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
          .map(d => d.name);
        targetWorkers.push(...dirs);
      } else {
        targetWorkers.push(workerName);
      }

      const results: string[] = [];
      let totalCount = 0;

      for (const w of targetWorkers) {
        const tasks = readTasks(w);
        if (Object.keys(tasks).length === 0) continue;

        const entries = Object.entries(tasks) as [string, Task][];
        const filtered = entries.filter(([taskId, t]) => {
          if (t.status === "deleted") return false;
          const blocked = isTaskBlocked(tasks, taskId);
          if (filter === "pending") return t.status === "pending" && !blocked;
          if (filter === "in_progress") return t.status === "in_progress";
          if (filter === "blocked") return blocked && t.status !== "completed";
          return true;
        });

        if (filtered.length === 0) continue;

        results.push(`## ${w}`);
        for (const [id, t] of filtered) {
          const blocked = isTaskBlocked(tasks, id);
          const status = blocked ? "blocked" : t.status;
          const deps = (t.blocked_by || []).length > 0 ? ` [after:${t.blocked_by.join(",")}]` : "";
          const rec = t.recurring ? " (recurring)" : "";
          results.push(`  ${id} [${t.priority || "medium"}] ${status}: ${t.subject}${deps}${rec}`);
          totalCount++;
        }
      }

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No tasks found" }] };
      }

      return withPendingReminder({ content: [{ type: "text" as const, text: `${totalCount} tasks:\n${results.join("\n")}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// STATE & FLEET TOOLS (3)
// ═══════════════════════════════════════════════════════════════════

server.registerTool(
  "get_worker_state",
  { description: "Read persisted state for any worker — cycles completed, sleep duration, last commit, custom metrics. Call at startup to resume where you left off. Omit name to read your own state.", inputSchema: {
    name: z.string().optional().describe("Worker name (default: self)"),
  } },
  async ({ name }) => {
    try {
      const targetName = name || WORKER_NAME;
      const entry = getWorkerEntry(targetName);
      if (!entry) {
        return { content: [{ type: "text" as const, text: `No state for worker '${targetName}'` }], isError: true };
      }
      // Return state-relevant fields
      const state: Record<string, any> = {
        status: entry.status,
        cycles_completed: entry.cycles_completed,
        perpetual: entry.perpetual,
        sleep_duration: entry.sleep_duration,
        last_cycle_at: entry.last_cycle_at,
        ...entry.custom,
      };
      if (entry.last_commit_sha) state.last_commit_sha = entry.last_commit_sha;
      if (entry.last_commit_msg) state.last_commit_msg = entry.last_commit_msg;
      if (entry.last_commit_at) state.last_commit_at = entry.last_commit_at;
      if (entry.issues_found) state.issues_found = entry.issues_found;
      if (entry.issues_fixed) state.issues_fixed = entry.issues_fixed;
      return withPendingReminder({ content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "update_state",
  { description: "Persist state across recycles — cycle count, sleep duration, custom metrics. Call after every cycle to stamp cycles_completed and last_cycle_at. The watchdog reads last_cycle_at to detect stuck workers, so always update it. Pass `worker` to update another worker's state (requires authority: you must be their report_to or the mission_authority).", inputSchema: {
    key: z.string().describe("State key to update (e.g. 'status', 'cycles_completed'). Known keys go top-level; unknown keys go into custom."),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
    worker: z.string().optional().describe("Target worker name (default: self). Requires authority — caller must be target's report_to or mission_authority."),
  } },
  async ({ key, value, worker }) => {
    try {
      const targetName = worker || WORKER_NAME;

      // Write to project registry
      let stateJson: string = "";
      withRegistryLocked((registry) => {
        // Authorization check for cross-worker updates
        if (targetName !== WORKER_NAME && !canUpdateWorker(WORKER_NAME, targetName, registry)) {
          throw new Error(`Not authorized to update '${targetName}' — you are not their report_to or the mission_authority`);
        }

        const entry = ensureWorkerInRegistry(registry, targetName);
        // Allowlist of state-owned fields (prevents overwriting pane_id, branch, etc.)
        const STATE_KEYS = new Set(["status","cycles_completed","perpetual","sleep_duration","last_cycle_at",
          "last_commit_sha","last_commit_msg","last_commit_at","issues_found","issues_fixed","report_to"]);
        if (STATE_KEYS.has(key)) {
          (entry as any)[key] = value;
        } else {
          entry.custom[key] = value;
        }
        stateJson = JSON.stringify(entry, null, 2) + "\n";
      });

      // Sync to watchdog config-cache (best-effort, bypasses macOS TCC restrictions)
      try {
        const cacheDir = join(
          process.env.HOME || "/tmp",
          ".claude-ops/state/harness-runtime/worker",
          targetName
        );
        if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, "config-cache.json"), stateJson);
      } catch {}

      // Emit bus event (best-effort)
      try {
        const payload = JSON.stringify({
          worker: targetName, key, value, channel: "worker-fleet-mcp", updated_by: WORKER_NAME,
        });
        execSync(
          `source "${CLAUDE_OPS}/lib/event-bus.sh" && bus_publish "agent.state-changed" '${payload.replace(/'/g, "'\\''")}'`,
          { cwd: PROJECT_ROOT, timeout: 5000, encoding: "utf-8", shell: "/bin/bash" }
        );
      } catch {}

      const prefix = targetName !== WORKER_NAME ? `${targetName}.` : "state.";
      return withPendingReminder({ content: [{ type: "text" as const, text: `Updated ${prefix}${key} = ${JSON.stringify(value)}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "fleet_status",
  { description: "Snapshot of every worker's health — pane alive, status, last cycle, recent commits. Use to understand the fleet before spawning workers, to check if a recipient worker is actually running before messaging, or to diagnose why something isn't responding." },
  async () => {
    try {
      // All reads + prunes inside one lock to avoid TOCTOU race
      const registry = withRegistryLocked((reg) => {
        // Auto-discover workers from filesystem
        try {
          const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true })
            .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
            .map(d => d.name);
          for (const name of dirs) {
            ensureWorkerInRegistry(reg, name);
          }
        } catch {}

        // Auto-prune dead panes
        for (const [key, entry] of Object.entries(reg)) {
          if (key === "_config" || typeof entry !== "object" || !entry) continue;
          const w = entry as RegistryWorkerEntry;
          if (w.pane_id && !isPaneAlive(w.pane_id)) {
            w.pane_id = null;
            w.pane_target = null;
            w.session_id = null;
          }
        }

        return { ...reg };
      });

      // Format output
      const projectName = basename(PROJECT_ROOT);
      let output = `=== Worker Fleet Status (${projectName}) ===\n`;
      output += `${new Date().toISOString()}\n\n`;

      // Workers table
      const header = `${"Worker".padEnd(22)} ${"Status".padEnd(10)} ${"Cycles".padEnd(8)} ${"Last Cycle".padEnd(24)} ${"Active Task"}`;
      output += header + "\n";
      output += `${"------".padEnd(22)} ${"------".padEnd(10)} ${"------".padEnd(8)} ${"----------".padEnd(24)} ${"-----------"}\n`;

      const workerEntries = Object.entries(registry)
        .filter(([key]) => key !== "_config")
        .sort(([a], [b]) => a.localeCompare(b));

      for (const [name, entry] of workerEntries) {
        const w = entry as RegistryWorkerEntry;
        let activeTask = "";
        try {
          const tasks = readTasks(name);
          const ip = Object.entries(tasks).find(([_, t]) => t.status === "in_progress");
          if (ip) activeTask = `${ip[0]}: ${ip[1].subject}`.slice(0, 40);
        } catch {}
        output += `${name.padEnd(22)} ${String(w.status || "unknown").padEnd(10)} ${String(w.cycles_completed || 0).padEnd(8)} ${String(w.last_cycle_at || "never").padEnd(24)} ${activeTask}\n`;
      }

      // Custom state for active workers
      output += "\n=== Worker State ===\n";
      for (const [name, entry] of workerEntries) {
        const w = entry as RegistryWorkerEntry;
        if (w.custom && Object.keys(w.custom).length > 0) {
          const stateStr = Object.entries(w.custom)
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
            .join(", ");
          output += `  ${name}: ${stateStr}\n`;
        }
      }

      // Pane check
      output += "\n=== Pane Check ===\n";
      for (const [name, entry] of workerEntries) {
        const w = entry as RegistryWorkerEntry;
        if (w.pane_id) {
          const alive = isPaneAlive(w.pane_id);
          output += `  ${name} (${w.pane_id} ${w.pane_target || "?"}) ${alive ? "⚡" : "❌ dead"}\n`;
        } else {
          output += `  ${name}: NO PANE (dead or not started)\n`;
        }
      }

      // (dead panes were already auto-pruned inside withRegistryLocked above)

      return withPendingReminder({ content: [{ type: "text" as const, text: output }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// MEMORY TOOL
// ═══════════════════════════════════════════════════════════════════

/** Pure helper: upsert a ## Section block in a MEMORY.md string. Exported for testing. */
function _replaceMemorySection(existing: string, section: string, content: string): string {
  const heading = `## ${section}`;
  const lines = existing.split("\n");
  let sectionStart = -1;
  let sectionEnd = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === heading) { sectionStart = i; continue; }
    if (sectionStart !== -1 && i > sectionStart && lines[i].startsWith("## ")) { sectionEnd = i; break; }
  }
  const newBlock = [heading, content.trimEnd(), ""].join("\n");
  if (sectionStart === -1) {
    return existing.trimEnd() + "\n\n" + newBlock + "\n";
  }
  const before = lines.slice(0, sectionStart).join("\n");
  const after = lines.slice(sectionEnd).join("\n");
  return (before ? before + "\n" : "") + newBlock + (after ? "\n" + after : "");
}

// ═══════════════════════════════════════════════════════════════════
// LIFECYCLE TOOLS (4) — recycle, heartbeat, check_config, reload
// ═══════════════════════════════════════════════════════════════════

server.registerTool(
  "recycle",
  { description: "Restart yourself with a fresh context window in the same pane. Use when your context is getting full, at the end of a long cycle, or when you've completed your mission. Writes a handoff.md so the next instance knows what happened. Set final=true to exit without restarting (mission complete).", inputSchema: {
    message: z.string().optional().describe("Handoff message for the next instance (what's done, what's next, blockers)"),
    final: z.boolean().optional().describe("If true, this is the last cycle — exit cleanly without restarting. Use when work is complete."),
  } },
  async ({ message, final }) => {
    // 1. Find own pane
    const ownPane = findOwnPane();
    if (!ownPane) {
      return { content: [{ type: "text" as const, text: "Error: Could not find own pane in registry. Are you running in tmux?" }], isError: true };
    }

    // 1b. Check for unreplied messages
    const recycleCursor = readInboxCursor(WORKER_NAME);
    const pendingReplies = recycleCursor?.pending_replies || [];
    const pendingWarning = pendingReplies.length > 0
      ? `\n\nWARNING: ${pendingReplies.length} unreplied message(s):\n` +
        pendingReplies.map(p => {
          const typeTag = p.reply_type ? `[${p.reply_type}] ` : "";
          return `  - ${typeTag}[${p.msg_id}] from ${p.from_name}: "${p.summary}" (${p._ts})`;
        }).join("\n") +
        `\nReply before recycling, or these will carry over to next cycle.`
      : "";

    // 2. Get session ID for transcript reference
    const sessionId = getSessionId(ownPane.paneId);
    const worktreeDir = getWorktreeDir();
    const pathSlug = worktreeDir.replace(/\//g, "-").replace(/^-/, "-");
    const transcriptPath = sessionId
      ? join(HOME, ".claude/projects", pathSlug, `${sessionId}.jsonl`)
      : null;

    // 3. Write handoff.md (includes session transcript reference)
    const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
    if (message || transcriptPath) {
      try {
        let handoffContent = message || "";
        if (transcriptPath) {
          handoffContent += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
        }
        writeFileSync(handoffPath, handoffContent.trim() + "\n");
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error writing handoff: ${e.message}` }], isError: true };
      }
    }

    // 4. Notify parent/operator of cycle completion
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      // Build cycle report
      const cycleReport = message
        ? `[${WORKER_NAME}] ${final ? "FINAL cycle" : "Cycle"} complete: ${message}`
        : `[${WORKER_NAME}] ${final ? "FINAL cycle" : "Cycle"} complete (no summary provided)`;

      // Notify mission_authority (operator equivalent)
      const operatorName = config?.mission_authority || null;
      if (operatorName && operatorName !== WORKER_NAME) {
        writeToInbox(operatorName, { content: cycleReport, summary: `${WORKER_NAME} cycle done`, from_name: WORKER_NAME });
      }
    } catch {
      // Best-effort notification — don't block recycle if it fails
    }

    // 4b. If final cycle, just exit without restarting
    if (final) {
      // Update state to reflect completion — write to registry
      try {
        withRegistryLocked((registry) => {
          ensureWorkerInRegistry(registry, WORKER_NAME);
          const entry = registry[WORKER_NAME] as RegistryWorkerEntry;
          entry.status = "done";
          entry.custom.completed_at = new Date().toISOString();
        });
      } catch {}

      // Send /exit to Claude (graceful shutdown)
      try {
        const exitScript = `/tmp/final-exit-${WORKER_NAME}-${Date.now()}.sh`;
        writeFileSync(exitScript, `#!/bin/bash
sleep 5
tmux send-keys -t "${ownPane.paneId}" "/exit"
tmux send-keys -t "${ownPane.paneId}" -H 0d
rm -f "${exitScript}"
`);
        execSync(`nohup bash "${exitScript}" > /dev/null 2>&1 &`, {
          shell: "/bin/bash", timeout: 5000,
        });
      } catch {}

      return {
        content: [{
          type: "text" as const,
          text: `Final cycle. Shutting down.\n` +
            `Handoff: ${message ? "written to handoff.md" : "none"}\n` +
            `Parent/operator notified.\n` +
            `Do NOT send any more tool calls — /exit will be sent shortly.` +
            pendingWarning,
        }],
      };
    }

    // 5. Get config
    const model = getWorkerModel();
    const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);

    // 7. Generate seed file (includes handoff + transcript path)
    const seedHandoff = message || "";
    const seedTranscript = transcriptPath
      ? `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
      : "";
    const seedContent = generateSeedContent((seedHandoff + seedTranscript).trim() || undefined);
    const seedFile = `/tmp/worker-${WORKER_NAME}-seed.txt`;
    writeFileSync(seedFile, seedContent);

    // 8. Create recycle script
    // Key fix: use /exit via tmux instead of kill — keeps pane alive
    const recycleScript = `/tmp/recycle-${WORKER_NAME}-${Date.now()}.sh`;
    const claudeCmd = `claude --model ${model} --dangerously-skip-permissions --add-dir ${workerDir}`;

    writeFileSync(recycleScript, `#!/bin/bash
# Auto-generated recycle script for ${WORKER_NAME}
set -uo pipefail
PANE_ID="${ownPane.paneId}"
PANE_TARGET="${ownPane.paneTarget}"
SEED_FILE="${seedFile}"

# Wait for MCP tool response to propagate to Claude TUI
sleep 5

# Send /exit to Claude (graceful — keeps pane alive with shell prompt)
tmux send-keys -t "$PANE_ID" "/exit"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for Claude to exit and shell prompt to return (max 30s)
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  # Check if Claude is still running in this pane
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && { echo "FATAL: pane $PANE_ID gone"; exit 1; }
  CLAUDE_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *claude* ]] && CLAUDE_RUNNING=true && break
  done
  [ "$CLAUDE_RUNNING" = "false" ] && break
done

# Small delay for shell prompt to stabilize
sleep 2

# Change to worktree directory
tmux send-keys -t "$PANE_ID" "cd ${worktreeDir}"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 1

# Launch Claude
tmux send-keys -t "$PANE_ID" "${claudeCmd}"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for TUI ready (poll for statusline, max 90s)
WAIT=0
until tmux capture-pane -t "$PANE_ID" -p 2>/dev/null | grep -qE "bypass permissions|Context left"; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 90 ] && break
done
sleep 3

# Inject seed using a named buffer (prevents race conditions when multiple workers recycle concurrently)
BUFFER_NAME="recycle-${WORKER_NAME}-$$"
tmux load-buffer -b "$BUFFER_NAME" "$SEED_FILE"
tmux paste-buffer -b "$BUFFER_NAME" -t "$PANE_ID" -d
sleep 2
tmux send-keys -t "$PANE_ID" -H 0d

# Cleanup
rm -f "${recycleScript}"
`);

    // 9. Spawn recycle script in background (detached)
    try {
      execSync(`nohup bash "${recycleScript}" > /tmp/recycle-${WORKER_NAME}.log 2>&1 &`, {
        shell: "/bin/bash", timeout: 5000,
      });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error spawning recycle: ${e.message}` }], isError: true };
    }

    return {
      content: [{
        type: "text" as const,
        text: `Recycling initiated. You will be restarted in ~10 seconds.\n` +
          `Handoff: ${message ? "written to handoff.md" : "none"}\n` +
          `Transcript: ${transcriptPath || "unknown"}\n` +
          `Seed: ${seedFile}\n` +
          `Do NOT send any more tool calls — /exit will be sent shortly.` +
          pendingWarning,
      }],
    };
  }
);

server.registerTool(
  "heartbeat",
  {
    description: "Call at the start of every cycle. Auto-registers your pane in the fleet (so send_message and fleet_status can find you) and stamps your state — no separate register_pane or update_state needed. Pass cycles_completed to increment your counter. Any extra key/value goes into custom state.",
    inputSchema: {
      cycles_completed: z.number().optional().describe("Your current cycle count — pass N+1 at end of each cycle"),
      status: z.string().optional().describe("Worker status (default: 'active')"),
      extra: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe("Any additional custom state to persist (e.g. {pass_rate: 99, current_focus: 'fix-tests'})"),
    },
  },
  async ({ cycles_completed, status, extra }) => {
    const tmuxPane = process.env.TMUX_PANE;

    // Resolve pane_target + session from tmux
    let paneTarget = "";
    let tmuxSession = "";
    if (tmuxPane) {
      try {
        const raw = execSync(
          `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{session_name}' | awk -v id="${tmuxPane}" '$1 == id {print $2, $3}'`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        const parts = raw.split(" ");
        paneTarget = parts[0] || "";
        tmuxSession = parts[1] || "";
      } catch {}
    }

    const now = new Date().toISOString();
    let registered = false;

    try {
      withRegistryLocked((registry) => {
        ensureWorkerInRegistry(registry, WORKER_NAME);
        const entry = registry[WORKER_NAME] as RegistryWorkerEntry;

        // Auto-register pane
        if (tmuxPane && isPaneAlive(tmuxPane)) {
          if (entry.pane_id !== tmuxPane) {
            entry.pane_id = tmuxPane;
            entry.pane_target = paneTarget;
            entry.tmux_session = tmuxSession;
            registered = true;
          }
        }

        // Stamp state
        entry.status = status || "active";
        entry.last_cycle_at = now;
        if (cycles_completed !== undefined) entry.cycles_completed = cycles_completed;

        // Extra custom fields
        if (extra) {
          for (const [k, v] of Object.entries(extra)) entry.custom[k] = v;
        }
      });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }

    // Emit bus event (best-effort)
    try {
      const payload = JSON.stringify({ worker: WORKER_NAME, key: "heartbeat", value: now, channel: "worker-fleet-mcp" });
      execSync(
        `source "${CLAUDE_OPS}/lib/event-bus.sh" && bus_publish "agent.state-changed" '${payload.replace(/'/g, "'\\''")}'`,
        { cwd: PROJECT_ROOT, timeout: 5000, encoding: "utf-8", shell: "/bin/bash" }
      );
    } catch {}

    // ── Heartbeat linter — ALL issues are blocking or auto-fixed ─────
    // Blocking issues return isError=true so the worker MUST stop and fix before continuing.
    // Auto-fixable issues are corrected in-place; the fix is reported in the success message.
    const blocking: string[] = [];
    const autoFixed: string[] = [];

    // 1. WORKER_NAME is fallback — unrecoverable without re-launch
    if (WORKER_NAME === "operator") {
      blocking.push("WORKER_NAME is 'operator' (env var not set at launch). Your registry entry will conflict with other workers. Notify chief-of-staff and ask to be re-launched via launch-flat-worker.sh with the correct worker name.");
    }

    // 2. TMUX_PANE not set or dead — unrecoverable without re-launch
    if (!tmuxPane) {
      blocking.push("TMUX_PANE env var is not set — not running inside tmux. Watchdog cannot monitor you, send_message cannot reach you. You must be launched via launch-flat-worker.sh inside a tmux pane.");
    } else if (!isPaneAlive(tmuxPane)) {
      blocking.push(`TMUX_PANE=${tmuxPane} no longer exists in tmux. Your session is detached or the pane was killed. Re-launch via launch-flat-worker.sh.`);
    }

    // 3. Registry entry / pane_id checks
    try {
      const reg = readRegistry();
      const myEntry = reg[WORKER_NAME] as RegistryWorkerEntry | undefined;
      if (!myEntry) {
        blocking.push(`Worker '${WORKER_NAME}' still missing from registry.json after heartbeat write — likely a file permission error on ${REGISTRY_PATH}. Check permissions and re-run heartbeat.`);
      } else {
        if (!myEntry.pane_id) {
          blocking.push(`No pane_id in registry for '${WORKER_NAME}' even after heartbeat. Watchdog and messaging cannot reach you. Check TMUX_PANE env var and registry write permissions.`);
        }

        // 4. No report_to — auto-fix by setting to mission_authority
        if (!getReportTo(myEntry, reg._config as RegistryConfig)) {
          const config = reg._config as RegistryConfig;
          const auth = config?.mission_authority || "chief-of-staff";
          try {
            withRegistryLocked((r) => {
              const e = r[WORKER_NAME] as RegistryWorkerEntry;
              if (e && !e.report_to) e.report_to = auth;
            });
            autoFixed.push(`report_to auto-set to '${auth}' (mission_authority)`);
          } catch {
            blocking.push(`No report_to set for '${WORKER_NAME}' and auto-fix failed. Run update_state("report_to", "${auth}") before continuing.`);
          }
        }
      }
    } catch {
      blocking.push(`Could not read registry.json to verify state — check file at ${REGISTRY_PATH}.`);
    }

    if (blocking.length > 0) {
      const msg = [
        `HEARTBEAT FAILED — ${blocking.length} issue(s) must be resolved before continuing:`,
        ...blocking.map((b, i) => `${i + 1}. ${b}`),
      ].join("\n");
      return { content: [{ type: "text" as const, text: msg }], isError: true };
    }

    const parts = [`Heartbeat OK: ${WORKER_NAME} at ${now}`];
    if (registered) parts.push(`pane registered: ${tmuxPane} (${paneTarget})`);
    if (cycles_completed !== undefined) parts.push(`cycles: ${cycles_completed}`);
    if (autoFixed.length > 0) parts.push(`auto-fixed: ${autoFixed.join(", ")}`);
    if (extra) parts.push(`custom: ${Object.keys(extra).join(", ")}`);

    // Nudge if no in-progress task
    try {
      const tasks = readTasks(WORKER_NAME);
      const hasInProgress = Object.values(tasks).some(t => t.status === "in_progress");
      if (!hasInProgress) {
        const hasPending = Object.values(tasks).some(t => t.status === "pending");
        if (hasPending) {
          parts.push("\n⚠️ No task marked in_progress. Use list_tasks() then update_task(status='in_progress') to claim your current work.");
        } else {
          parts.push("\n⚠️ Task list is empty. Use create_task() to register your goals from mission.md, then update_task(status='in_progress') to claim work.");
        }
      }
    } catch {}

    return withPendingReminder({ content: [{ type: "text" as const, text: parts.join(" | ") }] });
  }
);

server.registerTool(
  "check_config",
  { description: "Diagnose why things aren't working. Checks your environment, registry entry, required files, git branch, and worktree. Returns specific issues with fix suggestions. Run when something feels wrong — missing messages, watchdog not picking you up, tools misbehaving." },
  async () => {
    const issues = getCachedDiagnostics();
    if (issues.length === 0) {
      return { content: [{ type: "text" as const, text: "All checks passed. Configuration looks good." }] };
    }

    const errors = issues.filter(i => i.severity === "error");
    const warnings = issues.filter(i => i.severity === "warning");

    let output = `Found ${issues.length} issue(s): ${errors.length} error(s), ${warnings.length} warning(s)\n\n`;

    if (errors.length > 0) {
      output += "ERRORS (must fix):\n";
      for (const e of errors) {
        output += `  ✘ [${e.check}] ${e.message}\n`;
        if (e.fix) output += `    Fix: ${e.fix}\n`;
      }
      output += "\n";
    }

    if (warnings.length > 0) {
      output += "WARNINGS:\n";
      for (const w of warnings) {
        output += `  ⚠ [${w.check}] ${w.message}\n`;
        if (w.fix) output += `    Fix: ${w.fix}\n`;
      }
    }

    return {
      content: [{ type: "text" as const, text: output }],
      isError: errors.length > 0,
    };
  }
);

// ═══════════════════════════════════════════════════════════════════
// WORKER MANAGEMENT (1)
// ═══════════════════════════════════════════════════════════════════

type WorkerType = "implementer" | "monitor" | "coordinator" | "optimizer";

interface CreateWorkerInput {
  name: string;
  mission: string;
  type?: WorkerType;
  model?: "sonnet" | "opus" | "haiku";
  perpetual?: boolean;
  sleep_duration?: number;
  disallowed_tools?: string[];
  window?: string;
  report_to?: string;
  permission_mode?: string;
  taskEntries?: Array<{ subject: string; description?: string; priority?: string }>;
}

const TEMPLATE_TYPES_DIR = join(CLAUDE_OPS, "templates/flat-worker/types");

function loadTypeTemplate(type: WorkerType): { model?: string; perpetual?: boolean; sleep_duration?: number; disallowedTools?: string[]; permission_mode?: string } {
  const typeDir = join(TEMPLATE_TYPES_DIR, type);
  const result: { model?: string; perpetual?: boolean; sleep_duration?: number; disallowedTools?: string[]; permission_mode?: string } = {};
  try {
    const perms = JSON.parse(readFileSync(join(typeDir, "permissions.json"), "utf-8"));
    if (perms.model) result.model = perms.model;
    if (perms.permission_mode) result.permission_mode = perms.permission_mode;
    if (Array.isArray(perms.denyList)) result.disallowedTools = perms.denyList;
  } catch {}
  try {
    const state = JSON.parse(readFileSync(join(typeDir, "state.json"), "utf-8"));
    if (typeof state.perpetual === "boolean") result.perpetual = state.perpetual;
    if (typeof state.sleep_duration === "number") result.sleep_duration = state.sleep_duration;
  } catch {}
  return result;
}

interface CreateWorkerResult {
  ok: boolean;
  error?: string;
  workerDir?: string;
  model?: string;
  perpetual?: boolean;
  taskIds?: string[];
  tasks?: Record<string, Task>;
  state?: Record<string, any>;
  permissions?: Record<string, any>;
}

/** Core logic for creating a worker's directory and files. Exported for testing. */
function createWorkerFiles(input: CreateWorkerInput): CreateWorkerResult {
  const { name, mission, type, model, perpetual, sleep_duration, disallowed_tools, window: windowGroup, report_to, permission_mode, taskEntries = [] } = input;

  // Validate
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return { ok: false, error: `Name must be kebab-case (got '${name}')` };
  }
  const workerDir = join(WORKERS_DIR, name);
  if (existsSync(workerDir)) {
    return { ok: false, error: `Worker '${name}' already exists at ${workerDir}` };
  }
  if (!mission.trim()) {
    return { ok: false, error: `Mission cannot be empty` };
  }

  // Load type template defaults (if type provided)
  const tpl = type ? loadTypeTemplate(type) : {};

  // Create directory
  mkdirSync(workerDir, { recursive: true });

  // MEMORY.md — write directly to Claude Code's auto-memory path (no symlinks)
  const worktreePath = `${PROJECT_ROOT}-w-${name}`;
  const slug = worktreePath.replace(/\//g, "-");
  const autoMemoryDir = join(HOME, ".claude", "projects", slug, "memory");
  mkdirSync(autoMemoryDir, { recursive: true });
  const autoMemoryPath = join(autoMemoryDir, "MEMORY.md");
  // Remove stale symlink if present (legacy linkWorkerMemory artifact), then write real file
  try { if (lstatSync(autoMemoryPath).isSymbolicLink()) { rmSync(autoMemoryPath); } } catch {}
  if (!existsSync(autoMemoryPath)) {
    writeFileSync(autoMemoryPath, `# ${name} Memory\n\n`);
  }

  // mission.md
  writeFileSync(join(workerDir, "mission.md"), mission.trim() + "\n");

  // Config — override precedence: explicit param > type template > hardcoded default
  const defaultDisallowed = [
    "Bash(git checkout main*)",
    "Bash(git merge*)",
    "Bash(git push*)",
    "Bash(git reset --hard*)",
    "Bash(git clean*)",
    "Bash(rm -rf*)",
  ];
  const selectedModel = model ?? tpl.model ?? "opus";
  const resolvedDisallowed = disallowed_tools ?? tpl.disallowedTools ?? defaultDisallowed;
  const resolvedPermMode = permission_mode ?? tpl.permission_mode ?? "bypassPermissions";
  const permissions = {
    model: selectedModel,
    permission_mode: resolvedPermMode,
    disallowedTools: resolvedDisallowed,
    window: windowGroup || null,
    report_to: report_to || null,
  };

  // State — override precedence: explicit param > type template > hardcoded default
  const isPerpetual = perpetual ?? tpl.perpetual ?? false;
  const state: Record<string, any> = {
    status: "idle",
    cycles_completed: 0,
    perpetual: isPerpetual,
  };
  if (isPerpetual) {
    state.sleep_duration = sleep_duration ?? tpl.sleep_duration ?? 1800;
  }

  // tasks.json
  const tasksObj: Record<string, Task> = {};
  const now = new Date().toISOString();
  const taskIds: string[] = [];
  for (const entry of taskEntries) {
    const taskId = nextTaskId(tasksObj);
    taskIds.push(taskId);
    tasksObj[taskId] = {
      subject: entry.subject,
      description: entry.description || "",
      activeForm: `Working on: ${entry.subject}`,
      status: "pending",
      priority: (entry.priority as Task["priority"]) || "medium",
      recurring: false,
      blocked_by: [],
      metadata: {},
      cycles_completed: 0,
      owner: null,
      created_at: now,
      completed_at: null,
    };
  }
  writeFileSync(join(workerDir, "tasks.json"), JSON.stringify(tasksObj, null, 2) + "\n");

  return { ok: true, workerDir, model: selectedModel, perpetual: isPerpetual, taskIds, tasks: tasksObj, state, permissions };
}

server.registerTool(
  "create_worker",
  { description: "Spin up a new persistent worker with its own mission, memory, and task list. Use when you've identified a domain of work that warrants a dedicated agent — ongoing monitoring, specialized repair, continuous optimization. Set launch=true to start it immediately. Set fork_from_session=true to fork your current conversation context (inherits what you know). Set placement to control where the pane appears.", inputSchema: {
    name: z.string().describe("Worker name in kebab-case (e.g. 'chatbot-fix')"),
    mission: z.string().describe("Full mission.md content (markdown)"),
    type: z.enum(["implementer", "monitor", "coordinator", "optimizer"]).optional().describe("Worker archetype — sets model, permissions, perpetual/sleep defaults from template. Caller still writes mission. Use get_worker_template to preview."),
    model: z.enum(["sonnet", "opus", "haiku"]).optional().describe("LLM model (overrides type default if set)"),
    perpetual: z.boolean().optional().describe("Run in perpetual loop (overrides type default if set)"),
    sleep_duration: z.number().optional().describe("Seconds between cycles, only if perpetual (overrides type default if set)"),
    disallowed_tools: z.string().optional().describe("JSON array of disallowed tool patterns (default: safe git/rm guards). Example: [\"Bash(git push*)\",\"Edit\",\"Bash(*deploy*)\"]"),
    window: z.string().optional().describe("tmux window group name (e.g. 'optimizers', 'monitors'). Workers in the same group share a tiled layout."),
    report_to: z.string().optional().describe("Who this worker reports to (default: chief-of-staff / mission_authority). Use direct_report=true to report to calling worker instead."),
    permission_mode: z.string().optional().describe("Claude permission mode (default: bypassPermissions)"),
    launch: z.boolean().optional().describe("Auto-launch in tmux after creation (default: false)"),
    tasks: z.string().optional().describe("JSON array of tasks: [{subject, description?, priority?}]"),
    fork_from_session: z.boolean().optional().describe("Fork the caller's Claude session so the new worker inherits conversation context (default: false). Requires launch=true."),
    direct_report: z.boolean().optional().describe("Set report_to to the calling worker instead of mission_authority (default: false)"),
    placement: z.enum(["window", "beside", "new-window"]).optional().describe("Where to place the pane: 'window' (join named window group, default), 'beside' (split next to caller), 'new-window' (fresh named window)"),
  } },
  async ({ name, mission, type, model, perpetual, sleep_duration, disallowed_tools: disallowedToolsJson, window: windowGroup, report_to, permission_mode, launch, tasks: tasksJson, fork_from_session, direct_report, placement }) => {
    try {
      // Change 4: Enforce unique worker names
      const existingRegistry = readRegistry();
      if (existingRegistry[name] && name !== "_config") {
        return { content: [{ type: "text" as const, text: `Error: Worker '${name}' already exists in registry. Choose a unique name.` }], isError: true };
      }

      // Parse tasks JSON if provided
      let taskEntries: Array<{ subject: string; description?: string; priority?: string }> = [];
      if (tasksJson) {
        try {
          const parsed = JSON.parse(tasksJson);
          if (!Array.isArray(parsed)) {
            return { content: [{ type: "text" as const, text: `Error: tasks must be a JSON array` }], isError: true };
          }
          for (const t of parsed) {
            if (!t.subject || typeof t.subject !== "string") {
              return { content: [{ type: "text" as const, text: `Error: Each task must have a string 'subject'` }], isError: true };
            }
          }
          taskEntries = parsed;
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Error parsing tasks JSON: ${e.message}` }], isError: true };
        }
      }

      // Parse disallowed_tools JSON if provided
      let disallowedTools: string[] | undefined;
      if (disallowedToolsJson) {
        try {
          const parsed = JSON.parse(disallowedToolsJson);
          if (!Array.isArray(parsed) || !parsed.every((t: any) => typeof t === "string")) {
            return { content: [{ type: "text" as const, text: `Error: disallowed_tools must be a JSON array of strings` }], isError: true };
          }
          disallowedTools = parsed;
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Error parsing disallowed_tools JSON: ${e.message}` }], isError: true };
        }
      }

      // Validate fork_from_session requires launch
      if (fork_from_session && !launch) {
        return { content: [{ type: "text" as const, text: `Error: fork_from_session=true requires launch=true` }], isError: true };
      }

      // Create files
      const result = createWorkerFiles({ name, mission, type, model, perpetual, sleep_duration, disallowed_tools: disallowedTools, window: windowGroup, report_to, permission_mode, taskEntries });
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }

      // Determine report_to — default to chief-of-staff (mission_authority) unless explicit
      const config = readRegistry()._config as RegistryConfig | undefined;
      const missionAuthority = config?.mission_authority || "chief-of-staff";
      const reportTo = direct_report
        ? WORKER_NAME
        : (report_to || missionAuthority);

      // Register in unified registry
      const { state, permissions, taskIds, model: selectedModel, perpetual: isPerpetual } = result as Required<CreateWorkerResult>;
      withRegistryLocked((registry) => {
        ensureWorkerInRegistry(registry, name);
        const entry = registry[name] as RegistryWorkerEntry;
        entry.model = permissions.model || "opus";
        entry.permission_mode = permissions.permission_mode || "bypassPermissions";
        entry.disallowed_tools = permissions.disallowedTools || [];
        entry.status = state.status || "idle";
        entry.perpetual = state.perpetual || false;
        entry.sleep_duration = state.sleep_duration || 1800;
        entry.cycles_completed = state.cycles_completed || 0;
        if (permissions.window) {
          entry.window = permissions.window;
        }
        entry.report_to = reportTo;
        if (fork_from_session) {
          entry.forked_from = WORKER_NAME;
        }
      });

      // Create worktree for the new worker
      const projectName = PROJECT_ROOT.split("/").pop()!;
      const worktreeDir = join(PROJECT_ROOT, "..", `${projectName}-w-${name}`);
      const workerBranch = `worker/${name}`;
      let worktreeReady = false;
      try {
        if (!existsSync(worktreeDir)) {
          try { execSync(`git -C "${PROJECT_ROOT}" branch "${workerBranch}" HEAD 2>/dev/null`, { timeout: 5000 }); } catch {}
          execSync(`git -C "${PROJECT_ROOT}" worktree add "${worktreeDir}" "${workerBranch}"`, { encoding: "utf-8", timeout: 10000 });
        }
        worktreeReady = true;
      } catch {}

      // ── Launch helpers (shared by all placement modes) ──

      /** Create a tmux pane based on placement strategy. Returns pane ID or null. */
      function createPane(pl: string, cwd: string): string | null {
        const ownPane = findOwnPane();
        const tmuxSession = ownPane?.paneTarget?.split(":")[0] || "w";
        if (pl === "beside") {
          if (!ownPane) return null;
          return execSync(
            `tmux split-window -h -t "${ownPane.paneTarget}" -d -P -F '#{pane_id}' -c "${cwd}"`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
        }
        if (pl === "new-window") {
          return execSync(
            `tmux new-window -t "${tmuxSession}" -n "${name}" -d -P -F '#{pane_id}' -c "${cwd}"`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
        }
        // "window" — join named window group
        const winName = windowGroup || "workers";
        const winCheck = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf-8" });
        const windows = (winCheck.stdout || "").split("\n").map(w => w.trim());
        if (!windows.includes(winName)) {
          return execSync(
            `tmux new-window -t "${tmuxSession}" -n "${winName}" -d -P -F '#{pane_id}' -c "${cwd}"`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
        }
        const paneId = execSync(
          `tmux split-window -t "${tmuxSession}:${winName}" -d -P -F '#{pane_id}' -c "${cwd}"`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
        spawnSync("tmux", ["select-layout", "-t", `${tmuxSession}:${winName}`, "tiled"], { encoding: "utf-8" });
        return paneId;
      }

      /** Register a newly created pane in the registry. */
      function registerPane(paneId: string) {
        let paneTarget = "";
        try {
          paneTarget = execSync(
            `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${paneId}" '$1 == id {print $2}'`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
        } catch {}
        withRegistryLocked((registry) => {
          const entry = registry[name] as RegistryWorkerEntry;
          if (entry) {
            entry.pane_id = paneId;
            entry.pane_target = paneTarget;
            entry.tmux_session = paneTarget?.split(":")[0] || "w";
          }
        });
      }

      /** Write a spawn script and run it in the background. Returns launchInfo string. */
      function spawnInPane(paneId: string, cmd: string, label: string, cleanupFiles: string[] = []): string {
        const spawnScript = `/tmp/spawn-worker-${name}-${Date.now()}.sh`;
        const rmCmd = cleanupFiles.length > 0 ? `\nrm -f ${cleanupFiles.map(f => `"${f}"`).join(" ")} "${spawnScript}"` : `\nrm -f "${spawnScript}"`;
        writeFileSync(spawnScript, `#!/bin/bash\nsleep 1\ntmux send-keys -t "${paneId}" "${cmd}" && tmux send-keys -t "${paneId}" -H 0d${rmCmd}\n`);
        execSync(`nohup bash "${spawnScript}" > /tmp/spawn-worker-${name}.log 2>&1 &`, { shell: "/bin/bash", timeout: 5000 });
        return `\n  Launched (${label}): pane ${paneId}`;
      }

      // ── Optional launch ──
      let launchInfo = "";
      if (launch) {
        const effectivePlacement = placement || "window";
        const cwd = worktreeReady ? worktreeDir : PROJECT_ROOT;

        if (fork_from_session) {
          // Fork path: inherit caller's conversation context
          const ownPane = findOwnPane();
          const sessionId = ownPane ? getSessionId(ownPane.paneId) : null;
          if (!ownPane) {
            launchInfo = `\n  Launch: FAILED — could not find own pane (not in tmux?)`;
          } else if (!sessionId) {
            launchInfo = `\n  Launch: FAILED — no session ID for pane ${ownPane.paneId}`;
          } else {
            // Copy session data to new worktree's project dir
            if (worktreeReady) {
              try {
                const parentSlug = PROJECT_ROOT.replace(/\//g, "-");
                const newSlug = worktreeDir.replace(/\//g, "-");
                const parentProj = join(HOME, ".claude/projects", parentSlug);
                const newProj = join(HOME, ".claude/projects", newSlug);
                mkdirSync(newProj, { recursive: true });
                const jsonlSrc = join(parentProj, `${sessionId}.jsonl`);
                if (existsSync(jsonlSrc)) copyFileSync(jsonlSrc, join(newProj, `${sessionId}.jsonl`));
                const subdirSrc = join(parentProj, sessionId);
                if (existsSync(subdirSrc)) cpSync(subdirSrc, join(newProj, sessionId), { recursive: true });
              } catch {} // non-fatal
            }

            try {
              const childPaneId = createPane(effectivePlacement, cwd);
              if (!childPaneId?.startsWith("%")) {
                launchInfo = `\n  Launch: FAILED — pane creation returned: ${childPaneId}`;
              } else {
                registerPane(childPaneId);
                const workerModel = selectedModel || "opus";
                const workerDir = join(PROJECT_ROOT, ".claude/workers", name);
                const extraFlags = `--model ${workerModel} --dangerously-skip-permissions --add-dir ${workerDir}`;
                const cwdFlag = worktreeReady ? ` --cwd ${worktreeDir}` : "";
                const forkCmd = `bash ${join(CLAUDE_OPS, "scripts/fork-worker.sh")} ${ownPane.paneId} ${sessionId} --name ${name} --no-worktree${cwdFlag} ${extraFlags}`;
                const taskFile = `/tmp/create-worker-task-${name}-${Date.now()}.txt`;
                const setupPrefix = worktreeReady
                  ? `You are worker "${name}". Your isolated worktree is at ${worktreeDir}.\n\n`
                  : `You are worker "${name}". Create your worktree first: git worktree add ${worktreeDir} worker/${name}\n\n`;
                writeFileSync(taskFile, setupPrefix + mission.slice(0, 500));
                launchInfo = spawnInPane(childPaneId, `cat ${taskFile} | ${forkCmd}`, `fork from ${sessionId}`, [taskFile]);
              }
            } catch (e: any) {
              launchInfo = `\n  Launch: FAILED — ${e.message}`;
            }
          }
        } else if (effectivePlacement === "window" && !fork_from_session) {
          // Default "window" placement without fork — delegate to launch-flat-worker.sh
          const launchScript = join(CLAUDE_OPS, "scripts/launch-flat-worker.sh");
          if (!existsSync(launchScript)) {
            launchInfo = `\n  Launch: FAILED — script not found: ${launchScript}`;
          } else {
            const launchArgs = [launchScript, name, "--project", PROJECT_ROOT];
            if (permissions.window) launchArgs.push("--window", permissions.window);
            const launchResult = spawnSync("bash", launchArgs, {
              encoding: "utf-8", timeout: 120_000,
              env: { ...process.env, PROJECT_ROOT },
            });
            if (launchResult.status === 0) {
              const paneMatch = launchResult.stdout.match(/pane\s+(%\d+)/);
              launchInfo = `\n  Launched: pane ${paneMatch ? paneMatch[1] : "unknown"}`;
            } else {
              launchInfo = `\n  Launch: FAILED (exit ${launchResult.status}) — ${(launchResult.stderr || "").slice(0, 200)}`;
            }
          }
        } else {
          // Fresh session with "beside" or "new-window" placement
          try {
            const childPaneId = createPane(effectivePlacement, cwd);
            if (!childPaneId?.startsWith("%")) {
              launchInfo = `\n  Launch: FAILED — pane creation returned: ${childPaneId}`;
            } else {
              registerPane(childPaneId);
              const workerModel = selectedModel || "opus";
              const workerDir = join(PROJECT_ROOT, ".claude/workers", name);
              const claudeCmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${workerModel} --dangerously-skip-permissions --add-dir ${workerDir}`;
              const seedFile = `/tmp/seed-${name}-${Date.now()}.txt`;
              writeFileSync(seedFile, `You are worker "${name}". Your isolated worktree is at ${worktreeReady ? worktreeDir : "(create it)"}.\nRead ${join(WORKERS_DIR, name, "mission.md")} now and begin work.`);
              launchInfo = spawnInPane(childPaneId, `cat ${seedFile} | ${claudeCmd}`, effectivePlacement, [seedFile]);
            }
          } catch (e: any) {
            launchInfo = `\n  Launch: FAILED — ${e.message}`;
          }
        }
      } else {
        launchInfo = `\n  Launch: manual — bash launch-flat-worker.sh ${name}`;
      }

      // Return summary
      const taskSummary = taskIds.length > 0
        ? `${taskIds.length} (${taskIds.join(", ")})`
        : "none";

      const summary = [
        `Created worker/${name}:`,
        `  Dir: .claude/workers/${name}/`,
        `  Model: ${selectedModel} | Perpetual: ${isPerpetual}`,
        permissions.window ? `  Window: ${permissions.window}` : null,
        `  Reports to: ${reportTo}`,
        fork_from_session ? `  Forked from: ${WORKER_NAME}` : null,
        permissions.disallowedTools.length > 0 ? `  Disallowed: ${permissions.disallowedTools.length} rules` : `  Disallowed: none (full access)`,
        `  Tasks: ${taskSummary}`,
        worktreeReady ? `  Worktree: ${worktreeDir}` : `  Worktree: NOT CREATED (manual setup needed)`,
        launchInfo.trim() ? `  ${launchInfo.trim()}` : null,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "get_worker_template",
  {
    description: "Preview a worker type template before creating. Returns mission.md (with {{PLACEHOLDERS}} showing expected structure and 三省吾身 variant), permissions defaults, and state config. Use before create_worker(type=...) to understand what to write.",
    inputSchema: {
      type: z.enum(["implementer", "monitor", "coordinator", "optimizer"]).describe("Worker archetype to preview"),
    },
  },
  async ({ type }) => {
    const typeDir = join(TEMPLATE_TYPES_DIR, type);
    if (!existsSync(typeDir)) {
      return { content: [{ type: "text" as const, text: `Error: template type '${type}' not found at ${typeDir}` }], isError: true };
    }
    const sections: string[] = [`# Template: ${type}\n`];
    try {
      sections.push("## mission.md (structure to follow)\n```markdown\n" + readFileSync(join(typeDir, "mission.md"), "utf-8").trim() + "\n```\n");
    } catch { sections.push("## mission.md\n_Not found_\n"); }
    try {
      const perms = JSON.parse(readFileSync(join(typeDir, "permissions.json"), "utf-8"));
      sections.push("## Defaults (from permissions.json)\n" +
        `- **model**: ${perms.model || "opus"}\n` +
        `- **permission_mode**: ${perms.permission_mode || "bypassPermissions"}\n` +
        `- **denyList** (${(perms.denyList || []).length} rules): ${(perms.denyList || []).map((r: string) => `\`${r}\``).join(", ") || "none"}\n`);
    } catch { sections.push("## permissions.json\n_Not found_\n"); }
    try {
      const state = JSON.parse(readFileSync(join(typeDir, "state.json"), "utf-8"));
      sections.push("## Defaults (from state.json)\n" +
        `- **perpetual**: ${state.perpetual}\n` +
        `- **sleep_duration**: ${state.sleep_duration}s\n`);
    } catch { sections.push("## state.json\n_Not found_\n"); }
    sections.push("## Usage\n`create_worker(name=\"...\", type=\"" + type + "\", mission=\"# Your mission here\\n...\")`\nThe `type` sets model/permissions/perpetual/sleep defaults. You always write your own mission. Explicit params override type defaults.");
    return { content: [{ type: "text" as const, text: sections.join("\n") }] };
  }
);

server.registerTool(
  "standby",
  {
    description: "Put a worker into standby mode — keeps it in the registry (easy to restart later) but tells the watchdog to leave it alone. Use when a worker has finished its immediate task but may be needed again. The worker's pane is killed gracefully. To bring it back, use create_worker(launch=true) or bash launch-flat-worker.sh. Same auth rules as deregister: self-only unless you're chief-of-staff.",
    inputSchema: {
      name: z.string().optional().describe("Worker to put in standby (default: yourself). Only chief-of-staff may put other workers in standby."),
      reason: z.string().optional().describe("Why it's going to standby — stored in handoff.md"),
    },
  },
  async ({ name, reason }) => {
    const targetName = name || WORKER_NAME;

    // Authorization: self-only unless chief-of-staff
    if (targetName !== WORKER_NAME && WORKER_NAME !== "chief-of-staff") {
      return {
        content: [{
          type: "text" as const,
          text: `Only chief-of-staff can put other workers in standby. Contact chief-of-staff to stand down '${targetName}'.`,
        }],
        isError: true,
      };
    }

    const existing = getWorkerEntry(targetName);
    if (!existing) {
      return {
        content: [{ type: "text" as const, text: `Worker '${targetName}' not found in registry.` }],
        isError: true,
      };
    }

    // Write handoff.md
    if (reason) {
      try {
        const handoffPath = join(WORKERS_DIR, targetName, "handoff.md");
        const timestamp = new Date().toISOString();
        writeFileSync(handoffPath, `# Standby\n\n**At:** ${timestamp}\n**Reason:** ${reason}\n\nWorker is in standby — registered but not running. Launch with \`bash launch-flat-worker.sh ${targetName}\` to resume.\n`);
      } catch {}
    }

    // Check for unreplied messages
    const standbyCursor = readInboxCursor(targetName);
    const standbyPending = standbyCursor?.pending_replies || [];
    const standbyPendingWarning = standbyPending.length > 0
      ? `\n  WARNING: ${standbyPending.length} unreplied message(s):\n` +
        standbyPending.map(p => {
          const typeTag = p.reply_type ? `[${p.reply_type}] ` : "";
          return `    - ${typeTag}[${p.msg_id}] from ${p.from_name}: "${p.summary}"`;
        }).join("\n")
      : "";

    // Set status = standby in registry
    withRegistryLocked((registry) => {
      const entry = registry[targetName] as RegistryWorkerEntry;
      if (entry) {
        entry.status = "standby";
        entry.last_cycle_at = new Date().toISOString();
      }
    });

    // Move pane to "standby" window, then gracefully exit Claude
    const paneId = existing.pane_id;
    const tmuxSession = existing.tmux_session || "w";
    let moveResult = "";

    if (paneId) {
      try {
        // Rename any existing "stand-by" window to "standby" (normalize hyphen)
        spawnSync("tmux", ["rename-window", "-t", `${tmuxSession}:stand-by`, "standby"], { encoding: "utf-8" });

        // Ensure "standby" window exists — create it if not
        const windowCheck = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf-8" });
        const windows = (windowCheck.stdout || "").split("\n").map(w => w.trim());
        if (!windows.includes("standby")) {
          spawnSync("tmux", ["new-window", "-t", tmuxSession, "-n", "standby", "-d"], { encoding: "utf-8" });
        }

        // Move the pane into the standby window
        const moveRes = spawnSync("tmux", ["move-pane", "-s", paneId, "-t", `${tmuxSession}:standby`], { encoding: "utf-8" });
        if (moveRes.status === 0) {
          moveResult = `\n  Pane ${paneId}: moved to ${tmuxSession}:standby`;
          // Re-tile the standby window after move
          spawnSync("tmux", ["select-layout", "-t", `${tmuxSession}:standby`, "tiled"], { encoding: "utf-8" });
        } else {
          moveResult = `\n  Pane ${paneId}: move failed — ${(moveRes.stderr || "").trim()}`;
        }
      } catch (e: any) {
        moveResult = `\n  Pane move error: ${e.message}`;
      }

    } else {
      moveResult = "\n  No active pane to move";
    }

    return {
      content: [{
        type: "text" as const,
        text: [
          `Worker '${targetName}' → standby.`,
          `  Registry: status=standby (watchdog will ignore it)`,
          moveResult.trim() ? `  ${moveResult.trim()}` : null,
          reason ? `  Handoff: written to .claude/workers/${targetName}/handoff.md` : null,
          ``,
          standbyPendingWarning || null,
          ``,
          `To resume: bash ~/.claude-ops/scripts/launch-flat-worker.sh ${targetName}`,
        ].filter(Boolean).join("\n"),
      }],
    };
  }
);

server.registerTool(
  "deregister",
  {
    description: "Remove a worker from the registry (clean up ghost workers or finished one-off workers). Preserves the worker's files (.claude/workers/{name}/) and git worktree — only the registry entry is removed. Workers can only deregister themselves; chief-of-staff can deregister any worker. If you try to deregister someone else, you'll get an error telling you to contact chief-of-staff.",
    inputSchema: {
      name: z.string().optional().describe("Worker name to deregister (default: yourself). Only chief-of-staff may deregister other workers."),
      reason: z.string().optional().describe("Reason for deregistration — written to the worker's handoff.md for posterity"),
    },
  },
  async ({ name, reason }) => {
    const targetName = name || WORKER_NAME;

    // Authorization: only self-deregister, OR chief-of-staff can deregister anyone
    if (targetName !== WORKER_NAME && WORKER_NAME !== "chief-of-staff") {
      return {
        content: [{
          type: "text" as const,
          text: `Only chief-of-staff can deregister other workers. Contact chief-of-staff to deregister '${targetName}'.`,
        }],
        isError: true,
      };
    }

    // Check worker exists
    const existing = getWorkerEntry(targetName);
    if (!existing) {
      return {
        content: [{ type: "text" as const, text: `Worker '${targetName}' not found in registry.` }],
        isError: true,
      };
    }

    // Write reason to handoff.md if provided
    if (reason) {
      try {
        const handoffPath = join(WORKERS_DIR, targetName, "handoff.md");
        const timestamp = new Date().toISOString();
        writeFileSync(handoffPath, `# Deregistered\n\n**By:** ${WORKER_NAME}\n**At:** ${timestamp}\n**Reason:** ${reason}\n`);
      } catch {
        // Best-effort — don't block deregistration if handoff write fails
      }
    }

    const preservedWorktree = existing.worktree || "(none registered)";

    // Remove entry from registry (files and worktree are NOT touched)
    withRegistryLocked((registry) => {
      delete registry[targetName];
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Deregistered '${targetName}' from registry.`,
          ``,
          `Preserved (not deleted):`,
          `  Worker files: .claude/workers/${targetName}/`,
          `  Git worktree: ${preservedWorktree}`,
          ``,
          `To fully clean up when ready:`,
          `  git worktree remove ${preservedWorktree}`,
          `  rm -rf .claude/workers/${targetName}/`,
        ].join("\n"),
      }],
    };
  }
);

server.registerTool(
  "reload",
  {
    description: "Hot-restart: exit and resume the same session to pick up new MCP server config, model changes, or permission updates. Unlike recycle (which starts fresh), reload resumes the exact same conversation. Use after the MCP server bundle has been rebuilt.",
    inputSchema: {},
  },
  async () => {
    const ownPane = findOwnPane();
    if (!ownPane) {
      return { content: [{ type: "text" as const, text: "Error: Could not find own pane in registry. Are you running in tmux?" }], isError: true };
    }

    const sessionId = getSessionId(ownPane.paneId);
    if (!sessionId) {
      return { content: [{ type: "text" as const, text: "Error: Could not detect session ID — cannot resume." }], isError: true };
    }

    const model = getWorkerModel();
    const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
    const worktreeDir = getWorktreeDir();
    const resumeCmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model} --dangerously-skip-permissions --add-dir ${workerDir} --resume ${sessionId}`;

    const reloadScript = `/tmp/reload-${WORKER_NAME}-${Date.now()}.sh`;
    writeFileSync(reloadScript, `#!/bin/bash
# Auto-generated reload script for ${WORKER_NAME}
set -uo pipefail
PANE_ID="${ownPane.paneId}"

# Wait for MCP response to propagate
sleep 3

# Send /exit to Claude
tmux send-keys -t "$PANE_ID" "/exit"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for Claude to exit (max 30s)
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && { echo "FATAL: pane gone"; exit 1; }
  CLAUDE_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *claude* ]] && CLAUDE_RUNNING=true && break
  done
  [ "$CLAUDE_RUNNING" = "false" ] && break
done

sleep 2

# cd to worktree and resume same session
tmux send-keys -t "$PANE_ID" "cd ${worktreeDir}"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 1
tmux set-buffer -b reload-cmd "echo 'Continue from where you left off.' | ${resumeCmd}"
tmux paste-buffer -b reload-cmd -t "$PANE_ID"
tmux send-keys -t "$PANE_ID" -H 0d
tmux delete-buffer -b reload-cmd 2>/dev/null || true
rm -f "${reloadScript}"
`);

    execSync(`nohup bash "${reloadScript}" > /dev/null 2>&1 &`, {
      shell: "/bin/bash", timeout: 5000,
    });

    return {
      content: [{
        type: "text" as const,
        text: `Reloading — /exit will be sent in ~3s, then session ${sessionId} will resume.\n` +
          `Model: ${model}\n` +
          `Do NOT send any more tool calls — /exit is imminent.`,
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("worker-fleet MCP server fatal:", e);
    process.exit(1);
  });
}

// ── Exports for testing ──────────────────────────────────────────────
export {
  readTasks, writeTasks, nextTaskId, isTaskBlocked, getTasksPath,
  writeToInbox, readInboxFromCursor, readInboxCursor, writeInboxCursor,
  resolveRecipient, isPaneAlive, readJsonFile, acquireLock, releaseLock,
  findOwnPane, getSessionId, getWorkerModel, getWorktreeDir, generateSeedContent,
  runDiagnostics, createWorkerFiles, _setWorkersDir,
  readRegistry, getWorkerEntry, withRegistryLocked, ensureWorkerInRegistry,
  lintRegistry, _replaceMemorySection, getReportTo, canUpdateWorker,
  WORKER_NAME, WORKERS_DIR, HARNESS_LOCK_DIR, REGISTRY_PATH,
  type Task, type InboxCursor, type DiagnosticIssue,
  type RegistryConfig, type RegistryWorkerEntry, type ProjectRegistry,
};
