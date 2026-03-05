#!/usr/bin/env bun
/**
 * worker-fleet MCP server — Tools for worker fleet coordination.
 *
 * 14 tools in 5 categories:
 *   Messaging (2):  send_message (supports to="all" for broadcast), read_inbox
 *   Tasks (3):      create_task, update_task, list_tasks
 *   State (2):      get_worker_state, update_state
 *   Fleet (1):      fleet_status
 *   Lifecycle (4):  recycle, spawn_child, heartbeat, check_config
 *   Management (1): create_worker
 *
 * Task CRUD and inbox are native TS (no shell subprocess).
 * Messaging writes inbox first (durable), then fires bus (best-effort).
 *
 * Runtime: bun run ~/.claude-ops/mcp/worker-fleet/index.ts (stdio transport)
 * Identity: auto-detected from WORKER_NAME env, git branch, or fallback "operator"
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  readdirSync, openSync, fstatSync, statSync, readSync, closeSync, truncateSync,
  lstatSync, rmSync,
} from "fs";
import { join, basename } from "path";
import { execSync, spawnSync, spawn, type ChildProcess } from "child_process";

// ── Configuration ────────────────────────────────────────────────────
const HOME = process.env.HOME!;
const PROJECT_ROOT = process.env.PROJECT_ROOT || "/Users/wz/Desktop/zPersonalProjects/Wechat";
const CLAUDE_OPS = process.env.CLAUDE_OPS_DIR || join(HOME, ".claude-ops");
let WORKERS_DIR = join(PROJECT_ROOT, ".claude/workers");

/** For testing — override the workers directory */
function _setWorkersDir(dir: string) { WORKERS_DIR = dir; }
const BORING_DIR = process.env.BORING_DIR || join(HOME, ".boring");
const HARNESS_LOCK_DIR = join(BORING_DIR, "state/locks");

/** Project-level unified registry — replaces per-worker permissions.json, state.json, and pane-registry.json */
const REGISTRY_PATH = join(PROJECT_ROOT, ".claude/workers/registry.json");

// Script paths (only for tools that still shell out)
const WORKER_MESSAGE_SH = join(CLAUDE_OPS, "scripts/worker-message.sh");
const CHECK_WORKERS_SH = join(CLAUDE_OPS, "scripts/check-flat-workers.sh");


// ── Relay Configuration ──────────────────────────────────────────────
const RELAY_PORT = parseInt(process.env.RELAY_PORT || "3847", 10);
const RELAY_SECRET_PATH = join(BORING_DIR, "relay-secret");
const RELAY_SERVER_PATH = join(CLAUDE_OPS, "mcp/relay-server/index.ts");
const REMOTE_RELAY_URL = process.env.REMOTE_RELAY_URL || "";
const PROJECT_SLUG = basename(PROJECT_ROOT);

let _relaySecret = "";
try { _relaySecret = readFileSync(RELAY_SECRET_PATH, "utf-8").trim(); } catch {}

let _relayProcess: ChildProcess | null = null;

/** Start local relay server as a detached subprocess (idempotent) */
function startRelayServer(): void {
  if (_relayProcess && _relayProcess.exitCode === null) return; // already running

  // Check if relay is already listening (pass auth since /health requires it)
  const check = spawnSync("curl", [
    "-sf", "--max-time", "1",
    "-H", `Authorization: Bearer ${_relaySecret}`,
    `http://localhost:${RELAY_PORT}/health`,
  ], { timeout: 3000, encoding: "utf-8" });
  if (check.status === 0) return; // already running (maybe from another MCP instance)

  if (!existsSync(RELAY_SERVER_PATH)) return;
  if (!_relaySecret) return;

  const bunPath = process.env.BUN_PATH || join(HOME, ".bun/bin/bun");
  _relayProcess = spawn(bunPath, ["run", RELAY_SERVER_PATH], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      RELAY_PORT: String(RELAY_PORT),
      RELAY_PROJECT_ROOTS: PROJECT_ROOT,
    },
  });
  _relayProcess.unref();
}

/** Fetch from remote relay with auth + timeout. Returns null on any failure. */
async function relayFetch(
  method: string,
  path: string,
  body?: any,
): Promise<any | null> {
  if (!REMOTE_RELAY_URL || !_relaySecret) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const opts: RequestInit = {
      method,
      headers: {
        "Authorization": `Bearer ${_relaySecret}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    };
    if (body && method !== "GET") {
      opts.body = JSON.stringify(body);
    }

    const resp = await fetch(`${REMOTE_RELAY_URL}${path}`, opts);
    clearTimeout(timeout);

    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// ── Worker Identity Detection ────────────────────────────────────────
function detectWorkerName(): string {
  if (process.env.WORKER_NAME) return process.env.WORKER_NAME;
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: process.cwd(), encoding: "utf-8", timeout: 5000,
    }).trim();
    if (branch.startsWith("worker/")) return branch.slice("worker/".length);
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

  // Parent/child tracking (for spawn_child)
  parent?: string | null;      // parent worker name (set on children)
  children?: string[];         // child worker names (set on parents)

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
    model: "sonnet",
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

  // Parent/child enforcement: every non-config worker should be either a parent (has children) or a child (has parent)
  const allWorkerNames = Object.keys(registry).filter(n => n !== "_config");
  for (const name of allWorkerNames) {
    const w = registry[name] as RegistryWorkerEntry;
    const hasParent = !!w.parent;
    const hasChildren = Array.isArray(w.children) && w.children.length > 0;
    if (!hasParent && !hasChildren) {
      issues.push({ severity: "warning", check: "lint.orphan", message: `Worker '${name}' has no parent and no children — orphaned in hierarchy`, fix: `Set parent field (e.g. "chief-of-staff") or register children via spawn_child` });
    }
    // Validate parent reference exists in registry
    if (w.parent && !registry[w.parent]) {
      issues.push({ severity: "error", check: "lint.parent_missing", message: `Worker '${name}' references parent '${w.parent}' which doesn't exist in registry` });
    }
    // Validate children references exist in registry
    if (w.children) {
      for (const child of w.children) {
        if (!registry[child]) {
          issues.push({ severity: "error", check: "lint.child_missing", message: `Worker '${name}' references child '${child}' which doesn't exist in registry` });
        }
      }
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

interface InboxCursor {
  offset: number;
  last_read_at: string;
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

function writeInboxCursor(worker: string, offset: number): void {
  writeFileSync(getCursorPath(worker), JSON.stringify({
    offset, last_read_at: new Date().toISOString(),
  }) + "\n");
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

    // File was truncated externally → reset to 0
    const readFrom = fileSize < startOffset ? 0 : startOffset;
    const bytesToRead = fileSize - readFrom;

    if (bytesToRead <= 0) {
      // No new data
      if (opts.clear) {
        truncateSync(inboxPath, 0);
        writeInboxCursor(worker, 0);
      }
      return { messages: [], newOffset: fileSize };
    }

    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, readFrom);

    const newData = buffer.toString("utf-8");
    let entries = newData.split("\n").filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

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

    // Write cursor
    writeInboxCursor(worker, opts.clear ? 0 : newOffset);

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
  message: { content: string; summary?: string; from_name: string; [k: string]: any }
): { ok: true } | { ok: false; error: string } {
  const workerDir = join(WORKERS_DIR, recipientName);
  if (!existsSync(workerDir)) {
    return { ok: false, error: `Worker directory not found: ${recipientName}` };
  }

  const inboxPath = join(workerDir, "inbox.jsonl");
  const payload = {
    to: `worker/${recipientName}`,
    from: `worker/${message.from_name}`,
    from_name: message.from_name,
    content: message.content,
    summary: message.summary || message.content.slice(0, 60),
    msg_type: "message",
    channel: "worker-message",
    _ts: new Date().toISOString(),
  };

  try {
    appendFileSync(inboxPath, JSON.stringify(payload) + "\n");
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Resolve recipient — worker name, "parent", "children", or raw pane ID */
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

  // "parent" — find parent worker (from registry parent field, then fallback to "operator")
  if (to === "parent") {
    try {
      const registry = readRegistry();
      // 1. Check this worker's parent field
      const myEntry = registry[WORKER_NAME] as RegistryWorkerEntry | undefined;
      const parentName = myEntry?.parent;
      if (parentName) {
        const parentEntry = registry[parentName] as RegistryWorkerEntry | undefined;
        if (parentEntry?.pane_id && isPaneAlive(parentEntry.pane_id)) {
          if (existsSync(join(WORKERS_DIR, parentName))) {
            return { type: "worker", workerName: parentName };
          }
          return { type: "pane", paneId: parentEntry.pane_id };
        }
        return { type: "pane", error: `Parent '${parentName}' for worker '${WORKER_NAME}' has no live pane` };
      }
      // 2. Fallback: use mission_authority from _config (modern equivalent of "operator")
      const config = registry._config as RegistryConfig;
      const authorityName = config?.mission_authority;
      if (authorityName && authorityName !== WORKER_NAME) {
        const authEntry = registry[authorityName] as RegistryWorkerEntry | undefined;
        if (authEntry?.pane_id && isPaneAlive(authEntry.pane_id)) {
          if (existsSync(join(WORKERS_DIR, authorityName))) {
            return { type: "worker", workerName: authorityName };
          }
          return { type: "pane", paneId: authEntry.pane_id };
        }
      }
      return { type: "pane", error: `No parent found for worker '${WORKER_NAME}' (parent field not set in registry, mission_authority '${authorityName || "unset"}' has no live pane)` };
    } catch {
      return { type: "pane", error: "Failed to read registry" };
    }
  }

  // "children" — look up from registry.json children array
  if (to === "children") {
    try {
      const registry = readRegistry();
      const entry = registry[WORKER_NAME] as RegistryWorkerEntry | undefined;
      const childNames = entry?.children || [];
      if (childNames.length === 0) {
        return { type: "multi_pane", paneIds: [], error: "No children registered" };
      }
      // Resolve child names to pane IDs
      const paneIds: string[] = [];
      for (const childName of childNames) {
        const childEntry = registry[childName] as RegistryWorkerEntry | undefined;
        if (childEntry?.pane_id) paneIds.push(childEntry.pane_id);
      }
      if (paneIds.length === 0) {
        return { type: "multi_pane", paneIds: [], error: "Children registered but none have live panes" };
      }
      return { type: "multi_pane", paneIds };
    } catch {
      return { type: "multi_pane", error: "Failed to read registry for children" };
    }
  }

  // Worker name
  return { type: "worker", workerName: to };
}

/** Send text + Enter to a tmux pane. Uses -H 0d for Enter (not literal \n which tmux ignores).
 *  Sends Enter 3 times with 300ms delays — Claude's TUI sometimes misses a single Enter
 *  if the pane isn't fully focused/rendered yet. Extra Enters on an idle prompt are harmless. */
function tmuxSendMessage(paneId: string, text: string): void {
  execSync(`tmux send-keys -t ${JSON.stringify(paneId)} ${JSON.stringify(text)} ""`, { timeout: 5000 });
  execSync(`tmux send-keys -t ${JSON.stringify(paneId)} -H 0d`, { timeout: 5000 });
  spawnSync("sleep", ["0.3"]);
  execSync(`tmux send-keys -t ${JSON.stringify(paneId)} -H 0d`, { timeout: 5000 });
  spawnSync("sleep", ["0.3"]);
  execSync(`tmux send-keys -t ${JSON.stringify(paneId)} -H 0d`, { timeout: 5000 });
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
    return entry?.model || "sonnet";
  } catch { return "sonnet"; }
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
3. **Check tasks** — \`list_tasks(filter="pending")\` — find highest-priority unblocked work
4. **Claim** — \`update_task(task_id="T00N", status="in_progress")\` — mark what you're working on
5. **Do the work** — investigate, fix, test, commit, deploy, verify
6. **Complete** — \`update_task(task_id="T00N", status="completed")\` — only after fully verified
7. **Perpetual?** — if \`perpetual: true\`, sleep for \`sleep_duration\` seconds, then loop

If your inbox has a message from Warren or chief-of-staff, prioritize it over your current task list.

## MCP Tools (\`mcp__worker-fleet__*\`)

| Tool | What it does |
|------|-------------|
| \`send_message(to, content, summary)\` | Send to a worker, "parent", "children", raw pane "%NN", or **"all"** (broadcast to every worker) |
| \`read_inbox(limit?, since?, clear?)\` | Read your inbox; \`clear=true\` truncates after reading |
| \`create_task(subject, priority?, ...)\` | Add a task to your task list |
| \`update_task(task_id, status?, subject?, owner?, ...)\` | Update task status/fields — claim, complete, delete, reassign |
| \`list_tasks(filter?, worker?)\` | List tasks; \`worker="all"\` for cross-worker view |
| \`get_worker_state(name?)\` | Read any worker's state from registry.json |
| \`update_state(key, value)\` | Update your state in registry.json + emit bus event |
| \`fleet_status()\` | Full fleet overview (all workers) |
| \`recycle(message?)\` | Self-recycle: write handoff, restart fresh with new context |
| \`spawn_child(task?)\` | Fork yourself into a new pane to the right |
| \`heartbeat(cycles_completed?, extra?)\` | Call at start of each cycle: auto-registers pane + stamps last_cycle_at, status, cycles_completed |

These are native MCP tool calls — no bash wrappers needed.

## Rules
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
        issues.push({ severity: "warning", check: "registry.model", message: "registry entry missing 'model' field — defaulting to sonnet", fix: `update_state("model", "sonnet")` });
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
    issues.push({ severity: "error", check: "env.TMUX_PANE", message: "TMUX_PANE not set — you are not registered with the fleet. Messaging, watchdog monitoring, spawn_child, and recycle will NOT work.", fix: "Launch via launch-flat-worker.sh or call heartbeat()" });
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
  { description: `Primary inter-worker communication. Use whenever you need to coordinate with another worker, report findings to chief-of-staff, or notify your parent/children. Writes to the recipient's durable inbox (survives restarts) and delivers instantly via tmux if the pane is live. Use to="all" to broadcast fleet-wide (expensive — use sparingly). Use to="parent"/"children" for hierarchy traversal without knowing names.`, inputSchema: {
    to: z.string().describe("Worker name, 'parent', 'children', 'all' (broadcast to every worker), or raw pane ID '%NN'"),
    content: z.string().describe("Message content"),
    summary: z.string().describe("Short preview (5-10 words)"),
  } },
  async ({ to, content, summary }) => {
    // Broadcast path: to="all" sends to every worker's inbox
    if (to === "all") {
      const failures: string[] = [];
      const successes: string[] = [];
      try {
        const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
          .map(d => d.name)
          .filter(name => name !== WORKER_NAME);
        for (const name of dirs) {
          const result = writeToInbox(name, { content, summary, from_name: WORKER_NAME });
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
      // Remote workers via relay (best-effort)
      let remoteCount = 0;
      try {
        const remote = await relayFetch("GET", "/workers");
        if (remote) {
          for (const [proj, workers] of Object.entries(remote) as [string, string[]][]) {
            for (const w of workers) {
              if (w === WORKER_NAME || successes.includes(w)) continue;
              const r = await relayFetch("POST", "/msg", { project: proj, worker: w, content, summary, from_name: WORKER_NAME });
              if (r?.ok) remoteCount++;
            }
          }
        }
      } catch {}
      let msg = `Broadcast to ${successes.length} local workers`;
      if (remoteCount > 0) msg += ` + ${remoteCount} remote`;
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
        ? `Sent to ${successes.length} children: ${successes.join(", ")}`
        : "No live children to deliver to";
      if (dead.length > 0) result += `\nDead panes (skipped): ${dead.join(", ")}`;
      if (failures.length > 0) result += `\nFailed: ${failures.join(", ")}`;
      return { content: [{ type: "text" as const, text: result }], isError: successes.length === 0 };
    }

    // Raw pane ID or parent pane — tmux-only delivery (no inbox)
    if (resolved.type === "pane") {
      if (!isPaneAlive(resolved.paneId!)) {
        return { content: [{ type: "text" as const, text: `Error: Pane ${resolved.paneId} is dead (not found in tmux)` }], isError: true };
      }
      try {
        tmuxSendMessage(resolved.paneId!, `[msg from ${WORKER_NAME}] ${content}`);
        const label = to === "parent" ? `parent (pane ${resolved.paneId})` : `pane ${resolved.paneId}`;
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
    const inboxResult = writeToInbox(recipientName, { content, summary, from_name: WORKER_NAME });
    if (!inboxResult.ok) {
      // Worker not local — try remote relay
      const remoteResult = await relayFetch("POST", "/msg", {
        project: PROJECT_SLUG, worker: recipientName, content, summary, from_name: WORKER_NAME,
      });
      if (remoteResult?.ok) {
        return { content: [{ type: "text" as const, text: `Message sent to ${recipientName} (remote)` }] };
      }
      return { content: [{ type: "text" as const, text: `Error: ${inboxResult.error}` }], isError: true };
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

    return { content: [{ type: "text" as const, text: `Message sent to ${recipientName}${paneWarning}` }] };
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
        return `[${type}] from ${from}${ts ? ` at ${ts}` : ""}: ${text}`;
      }).join("\n");

      const suffix = clear ? " (inbox cleared)" : "";
      return withStartupDiagnostics({ content: [{ type: "text" as const, text: `${messages.length} messages${suffix}:\n${formatted}` }] });
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

      return { content: [{ type: "text" as const, text: `Added ${taskId}: ${subject}${suffix}` }] };
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
      return { content: [{ type: "text" as const, text: `Updated ${task_id}: ${changes.join(", ")}` }] };
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
        let tasks = readTasks(w);

        // If no local tasks and querying a specific worker, try remote
        if (Object.keys(tasks).length === 0 && workerName !== "all") {
          const remote = await relayFetch("GET", `/tasks/${PROJECT_SLUG}/${w}`);
          if (remote && Object.keys(remote).length > 0) {
            tasks = remote;
          }
        }

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

      return { content: [{ type: "text" as const, text: `${totalCount} tasks:\n${results.join("\n")}` }] };
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
      return { content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "update_state",
  { description: "Persist your own state across recycles — cycle count, sleep duration, custom metrics. Call after every cycle to stamp cycles_completed and last_cycle_at. The watchdog reads last_cycle_at to detect stuck workers, so always update it.", inputSchema: {
    key: z.string().describe("State key to update (e.g. 'status', 'cycles_completed')"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
  } },
  async ({ key, value }) => {
    try {
      // Write to project registry
      let stateJson: string = "";
      withRegistryLocked((registry) => {
        const entry = ensureWorkerInRegistry(registry, WORKER_NAME);
        // Allowlist of state-owned fields (prevents overwriting pane_id, branch, etc.)
        const STATE_KEYS = new Set(["status","cycles_completed","perpetual","sleep_duration","last_cycle_at",
          "last_commit_sha","last_commit_msg","last_commit_at","issues_found","issues_fixed"]);
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
          ".boring/state/harness-runtime/worker",
          WORKER_NAME
        );
        if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, "config-cache.json"), stateJson);
      } catch {}

      // Emit bus event (best-effort)
      try {
        const payload = JSON.stringify({
          worker: WORKER_NAME, key, value, channel: "worker-fleet-mcp",
        });
        execSync(
          `source "${CLAUDE_OPS}/lib/event-bus.sh" && bus_publish "agent.state-changed" '${payload.replace(/'/g, "'\\''")}'`,
          { cwd: PROJECT_ROOT, timeout: 5000, encoding: "utf-8", shell: "/bin/bash" }
        );
      } catch {}

      return { content: [{ type: "text" as const, text: `Updated state.${key} = ${JSON.stringify(value)}` }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "fleet_status",
  { description: "Snapshot of every worker's health — pane alive, status, last cycle, recent commits. Use to understand the fleet before spawning children, to check if a recipient worker is actually running before messaging, or to diagnose why something isn't responding." },
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
      const header = `${"Worker".padEnd(22)} ${"Status".padEnd(10)} ${"Cycles".padEnd(8)} ${"Last Cycle".padEnd(24)} ${"Found".padEnd(8)} ${"Fixed".padEnd(8)}`;
      output += header + "\n";
      output += `${"------".padEnd(22)} ${"------".padEnd(10)} ${"------".padEnd(8)} ${"----------".padEnd(24)} ${"-----".padEnd(8)} ${"-----".padEnd(8)}\n`;

      const workerEntries = Object.entries(registry)
        .filter(([key]) => key !== "_config")
        .sort(([a], [b]) => a.localeCompare(b));

      for (const [name, entry] of workerEntries) {
        const w = entry as RegistryWorkerEntry;
        output += `${name.padEnd(22)} ${String(w.status || "unknown").padEnd(10)} ${String(w.cycles_completed || 0).padEnd(8)} ${String(w.last_cycle_at || "never").padEnd(24)} ${String(w.issues_found || 0).padEnd(8)} ${String(w.issues_fixed || 0).padEnd(8)}\n`;
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

      // Append remote fleet status (best-effort)
      const remote = await relayFetch("GET", "/fleet");
      if (remote?.output) {
        output += "\n\n=== Remote Fleet ===\n" + remote.output;
      }

      return { content: [{ type: "text" as const, text: output }] };
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
// LIFECYCLE TOOLS (4) — recycle, spawn_child, heartbeat, check_config
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
            `Do NOT send any more tool calls — /exit will be sent shortly.`,
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
          `Do NOT send any more tool calls — /exit will be sent shortly.`,
      }],
    };
  }
);

server.registerTool(
  "spawn_child",
  { description: "Parallelize work by forking into a new pane. Use when you have independent subtasks that would be faster done simultaneously — research + implementation, testing multiple approaches, or delegating grunt work to a Sonnet child while you reason on Opus. The child gets a task injected after launch.", inputSchema: {
    task: z.string().optional().describe("Task/instruction to inject into the child after it starts"),
  } },
  async ({ task }) => {
    // 1. Find own pane
    const ownPane = findOwnPane();
    if (!ownPane) {
      return { content: [{ type: "text" as const, text: "Error: Could not find own pane in registry. Are you running in tmux?" }], isError: true };
    }

    // 2. Get session ID from pane-map
    const sessionId = getSessionId(ownPane.paneId);
    if (!sessionId) {
      return { content: [{ type: "text" as const, text: `Error: No session ID found for pane ${ownPane.paneId}. Statusline may not have mapped it yet — wait a few seconds and retry.` }], isError: true };
    }

    // 3. Get model and construct flags
    const model = getWorkerModel();
    const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
    const extraFlags = `--model ${model} --dangerously-skip-permissions --add-dir ${workerDir}`;

    // 4. Split pane to the right (horizontal split)
    let childPaneId: string;
    try {
      const splitResult = execSync(
        `tmux split-window -h -t "${ownPane.paneTarget}" -d -P -F '#{pane_id}'`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      childPaneId = splitResult;
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error splitting pane: ${e.message}` }], isError: true };
    }

    if (!childPaneId || !childPaneId.startsWith("%")) {
      return { content: [{ type: "text" as const, text: `Error: unexpected child pane ID: ${childPaneId}` }], isError: true };
    }

    // 5. Register child in registry.json (parent/children tracking)
    const childWorkerName = `${WORKER_NAME}-child-${Date.now()}`;
    try {
      let childPaneTarget = "";
      try {
        childPaneTarget = execSync(
          `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${childPaneId}" '$1 == id {print $2}'`,
          { encoding: "utf-8", timeout: 5000 }
        ).trim();
      } catch {}

      withRegistryLocked((registry) => {
        // Create child entry
        ensureWorkerInRegistry(registry, childWorkerName);
        const childEntry = registry[childWorkerName] as RegistryWorkerEntry;
        childEntry.pane_id = childPaneId;
        childEntry.pane_target = childPaneTarget;
        childEntry.parent = WORKER_NAME;
        childEntry.model = getWorkerModel();
        childEntry.tmux_session = ownPane.paneTarget?.split(":")[0] || "w";

        // Add child to parent's children array
        const parentEntry = registry[WORKER_NAME] as RegistryWorkerEntry | undefined;
        if (parentEntry) {
          if (!parentEntry.children) parentEntry.children = [];
          if (!parentEntry.children.includes(childWorkerName)) {
            parentEntry.children.push(childWorkerName);
          }
        }
      });
    } catch (e: any) {
      // Non-fatal — child can still work without registration
    }

    // 6. Create a spawn script that launches Claude in the child pane
    const spawnScript = `/tmp/spawn-child-${WORKER_NAME}-${Date.now()}.sh`;
    const forkCmd = `bash ${join(CLAUDE_OPS, "scripts/fork-worker.sh")} ${ownPane.paneId} ${sessionId} ${extraFlags}`;

    let scriptContent = `#!/bin/bash
# Auto-generated spawn script for ${WORKER_NAME} child
set -uo pipefail
CHILD_PANE="${childPaneId}"

# Small delay for pane to be ready
sleep 1

# Send fork command to child pane
tmux send-keys -t "$CHILD_PANE" "${forkCmd}"
tmux send-keys -t "$CHILD_PANE" -H 0d
`;

    // If task provided, inject it after TUI ready
    if (task) {
      const taskFile = `/tmp/child-task-${WORKER_NAME}-${Date.now()}.txt`;
      writeFileSync(taskFile, task);

      scriptContent += `
# Wait for TUI ready (max 120s — fork-session loads full conversation)
# Use statusline as signal — more reliable than prompt character
WAIT=0
until tmux capture-pane -t "$CHILD_PANE" -p 2>/dev/null | grep -qE "bypass permissions|Context left"; do
  sleep 3; WAIT=\$((WAIT+3))
  [ "\$WAIT" -ge 120 ] && break
done
sleep 3

# Inject task using a named buffer (prevents race with other concurrent paste operations)
SPAWN_BUFFER_NAME="spawn-${WORKER_NAME}-$$"
tmux load-buffer -b "$SPAWN_BUFFER_NAME" "${taskFile}"
tmux paste-buffer -b "$SPAWN_BUFFER_NAME" -t "$CHILD_PANE" -d
sleep 2
tmux send-keys -t "$CHILD_PANE" -H 0d

# Cleanup
rm -f "${taskFile}"
`;
    }

    scriptContent += `\nrm -f "${spawnScript}"\n`;
    writeFileSync(spawnScript, scriptContent);

    // 7. Spawn in background
    try {
      execSync(`nohup bash "${spawnScript}" > /tmp/spawn-child-${WORKER_NAME}.log 2>&1 &`, {
        shell: "/bin/bash", timeout: 5000,
      });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error spawning child launcher: ${e.message}` }], isError: true };
    }

    const taskMsg = task ? `\nTask injected: "${task.slice(0, 80)}${task.length > 80 ? "..." : ""}"` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Spawned child in pane ${childPaneId} (split right of ${ownPane.paneTarget}).\n` +
          `Session fork from: ${sessionId}\n` +
          `Claude launching with: --model ${model} --fork-session${taskMsg}`,
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

        // 4. No parent — auto-fix by setting to mission_authority
        if (!myEntry.parent) {
          const config = reg._config as RegistryConfig;
          const auth = config?.mission_authority || "chief-of-staff";
          try {
            withRegistryLocked((r) => {
              const e = r[WORKER_NAME] as RegistryWorkerEntry;
              if (e && !e.parent) e.parent = auth;
            });
            autoFixed.push(`parent auto-set to '${auth}' (mission_authority)`);
          } catch {
            blocking.push(`No parent set for '${WORKER_NAME}' and auto-fix failed. Run update_state("parent", "${auth}") before continuing.`);
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

    return { content: [{ type: "text" as const, text: parts.join(" | ") }] };
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

interface CreateWorkerInput {
  name: string;
  mission: string;
  model?: "sonnet" | "opus" | "haiku";
  perpetual?: boolean;
  sleep_duration?: number;
  disallowed_tools?: string[];
  window?: string;
  parent?: string;
  permission_mode?: string;
  taskEntries?: Array<{ subject: string; description?: string; priority?: string }>;
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
  const { name, mission, model, perpetual, sleep_duration, disallowed_tools, window: windowGroup, parent, permission_mode, taskEntries = [] } = input;

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

  // Config (stored in registry.json, not permissions.json)
  const selectedModel = model || "sonnet";
  const defaultDisallowed = [
    "Bash(git checkout main*)",
    "Bash(git merge*)",
    "Bash(git push*)",
    "Bash(git reset --hard*)",
    "Bash(git clean*)",
    "Bash(rm -rf*)",
  ];
  const permissions = {
    model: selectedModel,
    permission_mode: permission_mode || "bypassPermissions",
    disallowedTools: disallowed_tools ?? defaultDisallowed,
    window: windowGroup || null,
    parent: parent || null,
  };

  // State (no longer written to state.json — stored in registry.json)
  const isPerpetual = perpetual || false;
  const state: Record<string, any> = {
    status: "idle",
    cycles_completed: 0,
    perpetual: isPerpetual,
  };
  if (isPerpetual) {
    state.sleep_duration = sleep_duration || 1800;
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
  { description: "Spin up a new persistent worker with its own mission, memory, and task list. Use when you've identified a domain of work that warrants a dedicated agent — ongoing monitoring, specialized repair, continuous optimization. Set launch=true to start it immediately in a new tmux pane.", inputSchema: {
    name: z.string().describe("Worker name in kebab-case (e.g. 'chatbot-fix')"),
    mission: z.string().describe("Full mission.md content (markdown)"),
    model: z.enum(["sonnet", "opus", "haiku"]).optional().describe("LLM model (default: sonnet)"),
    perpetual: z.boolean().optional().describe("Run in perpetual loop (default: false)"),
    sleep_duration: z.number().optional().describe("Seconds between cycles, only if perpetual (default: 1800)"),
    disallowed_tools: z.string().optional().describe("JSON array of disallowed tool patterns (default: safe git/rm guards). Example: [\"Bash(git push*)\",\"Edit\",\"Bash(*deploy*)\"]"),
    window: z.string().optional().describe("tmux window group name (e.g. 'optimizers', 'monitors'). Workers in the same group share a tiled layout."),
    parent: z.string().optional().describe("Parent worker name (default: auto-set to calling worker)"),
    permission_mode: z.string().optional().describe("Claude permission mode (default: bypassPermissions)"),
    launch: z.boolean().optional().describe("Auto-launch in tmux after creation (default: false)"),
    tasks: z.string().optional().describe("JSON array of tasks: [{subject, description?, priority?}]"),
  } },
  async ({ name, mission, model, perpetual, sleep_duration, disallowed_tools: disallowedToolsJson, window: windowGroup, parent, permission_mode, launch, tasks: tasksJson }) => {
    try {
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

      // Create files
      const result = createWorkerFiles({ name, mission, model, perpetual, sleep_duration, disallowed_tools: disallowedTools, window: windowGroup, parent, permission_mode, taskEntries });
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: `Error: ${result.error}` }], isError: true };
      }

      // Register in unified registry
      const { state, permissions, taskIds, model: selectedModel, perpetual: isPerpetual } = result as Required<CreateWorkerResult>;
      withRegistryLocked((registry) => {
        ensureWorkerInRegistry(registry, name);
        const entry = registry[name] as RegistryWorkerEntry;
        entry.model = permissions.model || "sonnet";
        entry.permission_mode = permissions.permission_mode || "bypassPermissions";
        entry.disallowed_tools = permissions.disallowedTools || [];
        entry.status = state.status || "idle";
        entry.perpetual = state.perpetual || false;
        entry.sleep_duration = state.sleep_duration || 1800;
        entry.cycles_completed = state.cycles_completed || 0;
        // Window group
        if (permissions.window) {
          entry.window = permissions.window;
        }
        // Parent: explicit param > calling worker > chief-of-staff
        if (permissions.parent) {
          entry.parent = permissions.parent;
        } else if (!entry.parent) {
          entry.parent = WORKER_NAME || "chief-of-staff";
        }
      });

      // Optional launch
      let launchInfo = "";
      if (launch) {
        const launchScript = join(CLAUDE_OPS, "scripts/launch-flat-worker.sh");
        if (!existsSync(launchScript)) {
          launchInfo = `\n  Launch: FAILED — script not found: ${launchScript}`;
        } else {
          const launchArgs = [launchScript, name, "--project", PROJECT_ROOT];
          if (permissions.window) {
            launchArgs.push("--window", permissions.window);
          }
          const launchResult = spawnSync("bash", launchArgs, {
            encoding: "utf-8",
            timeout: 120_000,
            env: { ...process.env, PROJECT_ROOT },
          });
          if (launchResult.status === 0) {
            const paneMatch = launchResult.stdout.match(/pane\s+(%\d+)/);
            const paneId = paneMatch ? paneMatch[1] : "unknown";
            launchInfo = `\n  Launched: pane ${paneId}`;
          } else {
            launchInfo = `\n  Launch: FAILED (exit ${launchResult.status}) — ${(launchResult.stderr || "").slice(0, 200)}`;
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
        `  Parent: ${permissions.parent || WORKER_NAME || "chief-of-staff"}`,
        permissions.disallowedTools.length > 0 ? `  Disallowed: ${permissions.disallowedTools.length} rules` : `  Disallowed: none (full access)`,
        `  Tasks: ${taskSummary}`,
        launchInfo.trim() ? `  ${launchInfo.trim()}` : null,
      ].filter(Boolean).join("\n");

      return { content: [{ type: "text" as const, text: summary }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════════

async function main() {
  // Auto-start local relay server (idempotent — skips if already running)
  startRelayServer();

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
  lintRegistry, _replaceMemorySection,
  WORKER_NAME, WORKERS_DIR, HARNESS_LOCK_DIR, REGISTRY_PATH,
  type Task, type InboxCursor, type DiagnosticIssue,
  type RegistryConfig, type RegistryWorkerEntry, type ProjectRegistry,
};
