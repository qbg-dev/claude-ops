#!/usr/bin/env bun
/**
 * worker-fleet MCP server — Tools for worker fleet coordination.
 *
 * 21 tools (fine-grained, one action per tool):
 *   Tasks (3):      task_create, task_update, task_list
 *   State (2):      get_worker_state, update_state
 *   Hooks (3):      add_hook, complete_hook, remove_hook
 *   Lifecycle (1):  recycle (gated on dynamic hooks, watchdog-deferred for perpetual workers)
 *   Fleet (7):      create_worker, register_worker, deregister_worker, move_worker, standby_worker, fleet_template, fleet_help
 *   Review (1):     deep_review
 *   Mail (4):       mail_send, mail_inbox, mail_read, mail_help
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
  readdirSync, statSync,
  lstatSync, rmSync, copyFileSync, cpSync,
} from "fs";
import { join, basename } from "path";
import { execSync, spawnSync, spawn } from "child_process";
import { randomUUID } from "crypto";
import { acquireLock, releaseLock } from "../shared/lock-utils.js";

// ── Configuration ────────────────────────────────────────────────────
const HOME = process.env.HOME!;
const PROJECT_ROOT = process.env.PROJECT_ROOT || process.cwd();
const CLAUDE_OPS = process.env.CLAUDE_OPS_DIR || join(HOME, ".claude-ops");
let WORKERS_DIR = join(PROJECT_ROOT, ".claude/workers");

/** For testing — override the workers directory */
function _setWorkersDir(dir: string) { WORKERS_DIR = dir; }
const HARNESS_LOCK_DIR = join(CLAUDE_OPS, "state/locks");

/** Load shared seed context template, interpolate placeholders */
function loadSeedContext(branch: string, missionAuthority: string): string {
  const tmplPath = join(CLAUDE_OPS, "templates/seed-context.md");
  try {
    return readFileSync(tmplPath, "utf-8")
      .replace(/\{\{WORKER_NAME\}\}/g, WORKER_NAME)
      .replace(/\{\{BRANCH\}\}/g, branch)
      .replace(/\{\{MISSION_AUTHORITY\}\}/g, missionAuthority);
  } catch {
    // Fallback if template missing — minimal reminder
    return `Use \`mcp__worker-fleet__*\` MCP tools. Call \`mail_inbox()\` first. Report to ${missionAuthority}.`;
  }
}

/** Project-level unified registry — replaces per-worker permissions.json, state.json, and pane-registry.json */
const REGISTRY_PATH = join(PROJECT_ROOT, ".claude/workers/registry.json");


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

// ── Stop Checks (in-memory + file-persisted) ────────────────────────
// ═══════════════════════════════════════════════════════════════════
// DYNAMIC HOOKS — unified gate + inject system
// ═══════════════════════════════════════════════════════════════════
// Agents register hooks at runtime. Each hook can block (gate) or inject context.
// Hook scripts read this file and apply matching hooks per event.
// File persistence: /tmp/claude-hooks-{WORKER_NAME}.json
// All 18 Claude Code hook events
type HookEvent =
  | "SessionStart" | "SessionEnd" | "InstructionsLoaded"
  | "UserPromptSubmit"
  | "PreToolUse" | "PermissionRequest" | "PostToolUse" | "PostToolUseFailure"
  | "Notification" | "Stop"
  | "SubagentStart" | "SubagentStop" | "TeammateIdle" | "TaskCompleted"
  | "ConfigChange" | "PreCompact"
  | "WorktreeCreate" | "WorktreeRemove";

interface DynamicHook {
  id: string;
  event: HookEvent;
  description: string;
  content?: string;              // inject: context text. gate: block reason (falls back to description)
  blocking: boolean;             // true = blocks until completed. false = injects and passes.
  condition?: {
    tool?: string;               // Tool name match (PreToolUse/PostToolUse/PermissionRequest)
    file_glob?: string;          // File path glob
    command_pattern?: string;    // Bash command regex
  };
  completed: boolean;
  completed_at?: string;
  result?: string;
  agent_id?: string;             // Subagent scoping + auto-complete on SubagentStop
  added_at: string;
}
const dynamicHooks: Map<string, DynamicHook> = new Map();
let _hookCounter = 0;
const HOOKS_FILE = `/tmp/claude-hooks-${WORKER_NAME}.json`;
// Legacy file for migration
const LEGACY_STOP_CHECKS_FILE = `/tmp/claude-stop-checks-${WORKER_NAME}.json`;

/** Persist hooks to file for hook scripts to read */
function _persistHooks(): void {
  try {
    const hooks = [...dynamicHooks.values()];
    if (hooks.length === 0) {
      try { rmSync(HOOKS_FILE); } catch {}
      return;
    }
    writeFileSync(HOOKS_FILE, JSON.stringify({ worker: WORKER_NAME, hooks }, null, 2));
  } catch {}
}

// On startup, restore from file (survives MCP restart via recycle resume)
try {
  if (existsSync(HOOKS_FILE)) {
    const data = JSON.parse(readFileSync(HOOKS_FILE, "utf-8"));
    if (data.worker === WORKER_NAME && Array.isArray(data.hooks)) {
      for (const h of data.hooks) {
        dynamicHooks.set(h.id, h);
        const num = parseInt(h.id.replace("dh-", ""), 10);
        if (!isNaN(num) && num > _hookCounter) _hookCounter = num;
      }
    }
  } else if (existsSync(LEGACY_STOP_CHECKS_FILE)) {
    // One-time migration from old stop-checks format
    const data = JSON.parse(readFileSync(LEGACY_STOP_CHECKS_FILE, "utf-8"));
    if (data.worker === WORKER_NAME && Array.isArray(data.checks)) {
      for (const c of data.checks) {
        const id = c.id.replace("sc-", "dh-");
        const hook: DynamicHook = {
          id, event: "Stop", blocking: true,
          description: c.description, content: c.description,
          completed: c.completed, added_at: c.added_at,
          ...(c.completed_at && { completed_at: c.completed_at }),
          ...(c.result && { result: c.result }),
          ...(c.agent_id && { agent_id: c.agent_id }),
        };
        dynamicHooks.set(id, hook);
        const num = parseInt(id.replace("dh-", ""), 10);
        if (!isNaN(num) && num > _hookCounter) _hookCounter = num;
      }
      _persistHooks();
      try { rmSync(LEGACY_STOP_CHECKS_FILE); } catch {}
    }
  }
} catch {}

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
  forked_from?: string | null;  // set when created with fork_from_session=true

  // Optional commit tracking
  last_commit_sha?: string;
  last_commit_msg?: string;
  last_commit_at?: string;
  issues_found?: number;
  issues_fixed?: number;

  // Boring Mail Server token (auto-provisioned)
  bms_token?: string;
}

interface ProjectRegistry {
  _config: RegistryConfig;
  [workerName: string]: RegistryWorkerEntry | RegistryConfig;
}

const LINT_ENABLED = process.env.WORKER_FLEET_LINT !== "0";

/** Resolve report_to (falls back to config.mission_authority) */
function getReportTo(w: RegistryWorkerEntry, config?: RegistryConfig): string | null {
  return w.report_to || config?.mission_authority || null;
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
    branch: `worker/${name}`,
    worktree: worktreeDir,
    window: null,
    pane_id: null,
    pane_target: null,
    tmux_session: registry._config?.tmux_session || "w",
    session_id: null,
    session_file: null,
    mission_file: `.claude/workers/${name}/mission.md`,
    custom: { runtime: "claude" },
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
      issues.push({ severity: "warning", check: "lint.dead_pane", message: `Dead pane ${w.pane_id} (worker: ${name})`, fix: "Auto-pruned on get_worker_state(name='all')" });
    }

    // worktree doesn't exist (only for non-main-branch workers)
    if (w.worktree && w.branch !== "main" && !existsSync(w.worktree)) {
      issues.push({ severity: "warning", check: "lint.worktree", message: `Worker '${name}' worktree doesn't exist: ${w.worktree}` });
    }

    // model empty
    if (!w.model) {
      issues.push({ severity: "warning", check: "lint.model", message: `Worker '${name}' has no model configured` });
    }

    // Missing required fields
    if (!w.status) {
      issues.push({ severity: "warning", check: "lint.missing_status", message: `Worker '${name}' has no status` });
    }
    if (!w.branch) {
      issues.push({ severity: "warning", check: "lint.missing_branch", message: `Worker '${name}' has no branch` });
    }
    if (!w.mission_file) {
      issues.push({ severity: "warning", check: "lint.missing_mission", message: `Worker '${name}' has no mission_file` });
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

// acquireLock + releaseLock imported from ../shared/lock-utils.ts

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

// generateMsgId removed — BMS generates message IDs

// inbox types, cursor, and jsonl functions removed — BMS handles all messaging

// readInboxFromCursor and writeToInbox removed — BMS handles all messaging

/** Write an escalation entry to the triage queue (.claude/triage/queue.jsonl) */
function writeToTriageQueue(
  content: string,
  summary: string | undefined,
  fromWorker: string,
  opts?: { options?: string[]; category?: string; urgency?: string },
): { ok: true; id: string } | { ok: false; error: string } {
  try {
    const triageDir = join(PROJECT_ROOT, ".claude/triage");
    if (!existsSync(triageDir)) mkdirSync(triageDir, { recursive: true });
    const triagePath = join(triageDir, "queue.jsonl");
    const id = `tq-${Date.now()}`;
    const entry: Record<string, any> = {
      id,
      category: opts?.category || (opts?.options?.length ? "worker-question" : "worker-escalation"),
      title: summary || content.slice(0, 60),
      detail: content,
      source: fromWorker,
      from_worker: fromWorker,
      added_at: new Date().toISOString(),
      status: "pending",
    };
    if (opts?.options?.length) entry.options = opts.options;
    if (opts?.urgency) entry.urgency = opts.urgency;
    appendFileSync(triagePath, JSON.stringify(entry) + "\n");
    return { ok: true, id };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

/** Build structured message body from content + optional context/options */
function buildMessageBody(content: string, context?: string, options?: string[]): string {
  let body = content;
  if (context) body += `\n\n---\n${context}`;
  if (options?.length) body += `\n\nOptions:\n${options.map((o, i) => `  ${i + 1}) ${o}`).join("\n")}`;
  return body;
}

/** Resolve recipient — worker name, "report", "direct_reports", or raw pane ID */
function resolveRecipient(to: string): {
  type: "worker" | "pane" | "multi_pane" | "multi_worker";
  workerName?: string;
  workerNames?: string[];
  paneId?: string;
  paneIds?: string[];
  error?: string;
} {
  // Raw pane ID
  if (to.startsWith("%")) {
    return { type: "pane", paneId: to };
  }

  // "report" — find who this worker reports to (report_to → assigned_by → parent → mission_authority)
  // Always returns worker type for durable inbox delivery
  if (to === "report") {
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      const myEntry = registry[WORKER_NAME] as RegistryWorkerEntry | undefined;
      const reportToName = myEntry ? getReportTo(myEntry, config) : config?.mission_authority;
      if (reportToName && reportToName !== WORKER_NAME) {
        return { type: "worker", workerName: reportToName };
      }
      return { type: "worker", error: `No report_to found for worker '${WORKER_NAME}'` };
    } catch {
      return { type: "worker", error: "Failed to read registry" };
    }
  }

  // "direct_reports" — find all workers who report_to this worker
  // Returns worker names for durable inbox delivery + best-effort tmux
  if (to === "direct_reports") {
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      const workerNames: string[] = [];
      const paneIds: string[] = [];
      for (const [name, entry] of Object.entries(registry)) {
        if (name === "_config") continue;
        const w = entry as RegistryWorkerEntry;
        const reportTo = getReportTo(w, config);
        if (reportTo === WORKER_NAME) {
          workerNames.push(name);
          if (w.pane_id && isPaneAlive(w.pane_id)) {
            paneIds.push(w.pane_id);
          }
        }
      }
      if (workerNames.length === 0) {
        return { type: "multi_worker", workerNames: [], paneIds: [], error: "No workers reporting to you" };
      }
      return { type: "multi_worker", workerNames, paneIds };
    } catch {
      return { type: "multi_worker", error: "Failed to read registry" };
    }
  }

  // Worker name
  return { type: "worker", workerName: to };
}

/** Check if a tmux pane is idle (at the Claude REPL prompt, not running tools).
 *  Captures the last visible line — if it contains "bypass permissions" without "(running)",
 *  the worker is waiting for input. Returns true on error (assume idle — safer to deliver). */
function isPaneIdle(paneId: string): boolean {
  try {
    const capture = spawnSync("tmux", ["capture-pane", "-t", paneId, "-p"], {
      encoding: "utf-8", timeout: 3000,
    });
    const lastLine = (capture.stdout || "").trim().split("\n").pop() || "";
    return lastLine.includes("bypass permissions") && !lastLine.includes("(running)");
  } catch {
    return true; // assume idle on error — better to deliver than silently drop
  }
}

/** Send text + Enter to a tmux pane. Uses -H 0d for Enter (not literal \n which tmux ignores).
 *  Uses spawnSync (no shell) to avoid backtick/dollar-sign interpretation that was
 *  silently truncating messages containing code references like `--service web`.
 *
 *  If the pane is busy (mid-response), writes the message to a tmpfile and spawns a
 *  background retry via deliver-tmux-msg.sh (15s delay, max 2 retries). The inbox.jsonl
 *  write already happened before this point, so no message is ever lost — this only
 *  controls when the tmux paste+Enter fires. */
function tmuxSendMessage(paneId: string, text: string): void {
  if (!isPaneIdle(paneId)) {
    // Pane is busy — schedule background retry in 15s
    const tmpDir = join(HOME, ".claude-ops/tmp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const msgFile = join(tmpDir, `retry-${randomUUID()}.txt`);
    writeFileSync(msgFile, text);
    const deliverScript = join(CLAUDE_OPS, "mcp/worker-fleet/deliver-tmux-msg.sh");
    spawn("bash", [deliverScript, paneId, msgFile], {
      detached: true, stdio: "ignore",
    }).unref();
    return;
  }

  // Pane is idle — deliver immediately via paste-buffer
  const bufName = `msg-${paneId.replace("%", "")}-${Date.now()}`;
  const tmpFile = join(HOME, `.claude-ops/tmp/${bufName}.txt`);
  try {
    const tmpDir = join(HOME, ".claude-ops/tmp");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, text);
    spawnSync("tmux", ["load-buffer", "-b", bufName, tmpFile], { timeout: 5000 });
    spawnSync("tmux", ["paste-buffer", "-b", bufName, "-t", paneId, "-d"], { timeout: 5000 });
  } finally {
    try { rmSync(tmpFile); } catch {}
    try { spawnSync("tmux", ["delete-buffer", "-b", bufName], { timeout: 2000 }); } catch {}
  }
  // Wait for paste to register in the pane's input, then submit
  (globalThis as any).Bun.sleepSync(500);
  spawnSync("tmux", ["send-keys", "-t", paneId, "-H", "0d"], { timeout: 5000 });
}

/** Check if a tmux pane is alive (single tmux call — display-message fails if pane/session gone) */
function isPaneAlive(paneId: string): boolean {
  try {
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
  const _seedConfig = readRegistry()._config as RegistryConfig | undefined;
  const _missionAuth = _seedConfig?.mission_authority || "chief-of-staff";

  // Include persisted state in seed so workers resume where they left off
  let stateBlock = "";
  let proposalBlock = "";
  try {
    const reg = readRegistry();
    const entry = reg[WORKER_NAME] as RegistryWorkerEntry | undefined;
    if (entry?.custom && Object.keys(entry.custom).length > 0) {
      stateBlock = `\n\n## Persisted State\n\`\`\`json\n${JSON.stringify(entry.custom, null, 2)}\n\`\`\`\nThese values were saved by your previous instance via \`update_state()\`. Use them to resume context.`;
    }
    // Load proposal instructions if proposal_required is set
    if (entry?.custom?.proposal_required) {
      const instrPath = join(CLAUDE_OPS, "templates/proposal-instructions.md");
      const tmplPath = join(CLAUDE_OPS, "templates/proposal-template.html");
      try {
        let instrContent = readFileSync(instrPath, "utf-8");
        instrContent = instrContent
          .replace(/\{\{WORKER_NAME\}\}/g, WORKER_NAME)
          .replace(/\{\{MISSION_AUTHORITY\}\}/g, _missionAuth)
          .replace(/\{\{TEMPLATE_PATH\}\}/g, tmplPath);
        proposalBlock = "\n\n" + instrContent;
      } catch {}
    }
  } catch {}

  // Worker memory lives at project-level auto-memory subdirectory
  const projectSlug = PROJECT_ROOT.replace(/\//g, "-");
  const workerMemoryDir = join(HOME, ".claude", "projects", projectSlug, "memory", WORKER_NAME);

  let seed = `You are worker **${WORKER_NAME}**.
Worktree: ${worktreeDir} (branch: ${branch})
Worker config: ${workerDir}/

Read these files NOW in this order:
1. ${workerDir}/mission.md — your mission and goals (you own this file — update it as your mission evolves)
2. Call \`mail_inbox()\` — check for messages before anything else
3. Check \`.claude/scripts/${WORKER_NAME}/\` for existing scripts

**Your memory**: \`${workerMemoryDir}/MEMORY.md\`
Use Edit/Write to update it directly. Create topic files in that same directory for detailed notes.
This path is under the project-level auto-memory — it persists across recycles and is shared with other workers.

If your inbox has a message from the user or ${_missionAuth} (mission_authority), prioritize it over your current work.${stateBlock}${proposalBlock}

${loadSeedContext(branch, _missionAuth)}`;

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
      issues.push({ severity: "error", check: "registry_entry", message: `Worker '${WORKER_NAME}' not in registry.json`, fix: "Call register() to self-register with auto-detected pane info" });
    } else {
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
      issues.push({ severity: "error", check: "registry", message: `Worker '${WORKER_NAME}' not in registry.json — watchdog cannot monitor you.`, fix: "Call register() to self-register" });
    } else if (entry.pane_id !== process.env.TMUX_PANE) {
      issues.push({ severity: "error", check: "registry.pane_id", message: `Pane ${process.env.TMUX_PANE} not registered for '${WORKER_NAME}' in registry.json.`, fix: "Run update_state('pane_id', '" + process.env.TMUX_PANE + "') to fix" });
    }
  } else {
    issues.push({ severity: "error", check: "env.TMUX_PANE", message: "TMUX_PANE not set — not running in tmux. Messaging and watchdog will NOT work.", fix: "Launch via launch-flat-worker.sh" });
  }

  // ── Registry linter ──
  try {
    const registry = readRegistry();
    const lintIssues = lintRegistry(registry);
    issues.push(...lintIssues);
  } catch {}

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

function getCachedDiagnostics(): DiagnosticIssue[] {
  if (_diagCache && Date.now() - _diagCache.ts < DIAG_CACHE_TTL_MS) return _diagCache.issues;
  const issues = runDiagnostics();
  _diagCache = { issues, ts: Date.now() };
  return issues;
}

/** Append lint warnings/errors to every tool response (cached 10s) */
function withLint(result: { content: { type: "text"; text: string }[] }): typeof result {
  refreshBmsUnread(); // fire-and-forget
  let text = result.content[0]?.text || "";

  // 1. Diagnostics lint (errors only — warnings are noise)
  const issues = getCachedDiagnostics();
  const errors = issues.filter(i => i.severity === "error");
  if (errors.length > 0) {
    text += "\n\n⚠ LINT (" + errors.length + " issue" + (errors.length > 1 ? "s" : "") + "):\n" +
      errors.map(i => `  ✘ [${i.check}] ${i.message}${i.fix ? ` → ${i.fix}` : ""}`).join("\n");
  }

  // 2. BMS unread nudge (cached, non-blocking)
  if (_bmsUnreadCount > 0) {
    text += `\n\n📬 ${_bmsUnreadCount} unread mail — call mail_inbox() to read`;
  }

  return { content: [{ type: "text" as const, text }] };
}


// ── MCP Server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: "worker-fleet",
  version: "2.0.0",
});

// ═══════════════════════════════════════════════════════════════════
// MESSAGING — removed (replaced by mail_send / mail_inbox below)
// ═══════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════
// TASK TOOLS (3): task_create, task_update, task_list
// ═══════════════════════════════════════════════════════════════════

server.registerTool(
  "task_create",
  { description: "Add a new task to your queue.", inputSchema: {
    subject: z.string().describe("Task title in imperative form"),
    description: z.string().optional().describe("Task description or notes"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Execution priority (default: medium)"),
    active_form: z.string().optional().describe("Present-continuous label for status displays"),
    blocks: z.string().optional().describe("Comma-separated task IDs that cannot start until this completes"),
    blocked_by: z.string().optional().describe("Comma-separated task IDs that must complete first"),
    recurring: z.boolean().optional().describe("If true, auto-resets to pending after completion"),
  } },
  async ({ subject, description, priority, active_form, blocks, blocked_by, recurring }) => {
    try {
      const tasks = readTasks(WORKER_NAME);
      const id = nextTaskId(tasks);
      const now = new Date().toISOString();
      const blockedByList = blocked_by ? blocked_by.split(",").map(s => s.trim()).filter(Boolean) : [];
      const task: Task = {
        subject, description: description || "", activeForm: active_form || `Working on: ${subject}`,
        status: "pending", priority: (priority as Task["priority"]) || "medium",
        recurring: recurring || false, blocked_by: blockedByList, metadata: {},
        cycles_completed: 0, owner: null, created_at: now, completed_at: null,
      };
      tasks[id] = task;
      if (blocks) {
        for (const targetId of blocks.split(",").map(s => s.trim()).filter(Boolean)) {
          if (tasks[targetId]) {
            const existing = tasks[targetId].blocked_by || [];
            if (!existing.includes(id)) tasks[targetId].blocked_by = [...existing, id];
          }
        }
      }
      writeTasks(WORKER_NAME, tasks);
      let suffix = ` [${task.priority}]`;
      if (recurring) suffix += " (recurring)";
      if (blockedByList.length > 0) suffix += ` (after: ${blockedByList.join(",")})`;
      if (blocks) suffix += ` (blocks: ${blocks})`;
      return withLint({ content: [{ type: "text" as const, text: `Added ${id}: ${subject}${suffix}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "task_update",
  { description: "Update a task's status or fields.", inputSchema: {
    task_id: z.string().describe("Task identifier (e.g. 'T001')"),
    status: z.enum(["pending", "in_progress", "completed", "deleted"]).optional().describe("Target status"),
    subject: z.string().optional().describe("Updated task title"),
    description: z.string().optional().describe("Updated description or notes"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Updated priority"),
    active_form: z.string().optional().describe("Updated present-continuous label"),
    owner: z.string().optional().describe("Reassign to a different worker"),
    add_blocked_by: z.string().optional().describe("Comma-separated task IDs to add as blockers"),
    add_blocks: z.string().optional().describe("Comma-separated task IDs to block with this task"),
  } },
  async ({ task_id, status, subject, description, priority, active_form, owner, add_blocked_by, add_blocks }) => {
    try {
      const tasks = readTasks(WORKER_NAME);
      const task = tasks[task_id];
      if (!task) return { content: [{ type: "text" as const, text: `Error: Task ${task_id} not found` }], isError: true };
      const changes: string[] = [];
      const now = new Date().toISOString();
      if (status) {
        if (status === "in_progress") {
          if (task.status === "completed") return { content: [{ type: "text" as const, text: `Error: Task ${task_id} already completed` }], isError: true };
          if (task.status === "deleted") return { content: [{ type: "text" as const, text: `Error: Task ${task_id} has been deleted` }], isError: true };
          if (isTaskBlocked(tasks, task_id)) {
            const blockers = (task.blocked_by || []).filter(d => tasks[d]?.status !== "completed");
            return { content: [{ type: "text" as const, text: `Error: Task ${task_id} blocked by: ${blockers.join(", ")}` }], isError: true };
          }
          task.status = "in_progress"; task.owner = owner || WORKER_NAME; changes.push("claimed");
        } else if (status === "completed") {
          if (task.recurring) {
            task.status = "pending"; task.owner = null; task.completed_at = null;
            task.last_completed_at = now; task.cycles_completed = (task.cycles_completed || 0) + 1;
            changes.push(`completed (recurring — reset to pending, cycle #${task.cycles_completed})`);
          } else { task.status = "completed"; task.completed_at = now; changes.push("completed"); }
        } else if (status === "deleted") { task.status = "deleted"; task.deleted_at = now; changes.push("deleted"); }
        else if (status === "pending") { task.status = "pending"; changes.push("set to pending"); }
      }
      if (subject) { task.subject = subject; changes.push("subject updated"); }
      if (description !== undefined) { task.description = description; changes.push("description updated"); }
      if (active_form) { task.activeForm = active_form; changes.push("activeForm updated"); }
      if (priority) { task.priority = priority; changes.push(`priority → ${priority}`); }
      if (owner && !status) { task.owner = owner; changes.push(`owner → ${owner}`); }
      if (add_blocked_by) {
        const ids = add_blocked_by.split(",").map(s => s.trim()).filter(Boolean);
        task.blocked_by = [...new Set([...(task.blocked_by || []), ...ids])]; changes.push(`blocked by: ${ids.join(",")}`);
      }
      if (add_blocks) {
        const ids = add_blocks.split(",").map(s => s.trim()).filter(Boolean);
        for (const targetId of ids) {
          if (tasks[targetId]) { const existing = tasks[targetId].blocked_by || []; if (!existing.includes(task_id)) tasks[targetId].blocked_by = [...existing, task_id]; }
        }
        changes.push(`blocks: ${ids.join(",")}`);
      }
      if (changes.length === 0) return { content: [{ type: "text" as const, text: `No changes specified for ${task_id}` }] };
      writeTasks(WORKER_NAME, tasks);
      return withLint({ content: [{ type: "text" as const, text: `Updated ${task_id}: ${changes.join(", ")}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "task_list",
  { description: "View tasks with optional filtering.", inputSchema: {
    filter: z.enum(["all", "pending", "in_progress", "blocked"]).optional().describe("Filter by status (default: all)"),
    worker: z.string().optional().describe("Whose tasks (omit=self, 'all'=fleet-wide)"),
  } },
  async ({ filter, worker }) => {
    try {
      const targetWorkers: string[] = [];
      const wn = worker || WORKER_NAME;
      if (wn === "all") {
        targetWorkers.push(...readdirSync(WORKERS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
          .map(d => d.name));
      } else {
        targetWorkers.push(wn);
      }
      const results: string[] = [];
      let total = 0;
      for (const w of targetWorkers) {
        const tasks = readTasks(w);
        if (Object.keys(tasks).length === 0) continue;
        const entries = Object.entries(tasks) as [string, Task][];
        const filtered = entries.filter(([tid, t]) => {
          if (t.status === "deleted") return false;
          const blocked = isTaskBlocked(tasks, tid);
          if (filter === "pending") return t.status === "pending" && !blocked;
          if (filter === "in_progress") return t.status === "in_progress";
          if (filter === "blocked") return blocked && t.status !== "completed";
          return true;
        });
        if (filtered.length === 0) continue;
        results.push(`## ${w}`);
        for (const [id, t] of filtered) {
          const blocked = isTaskBlocked(tasks, id);
          const st = blocked ? "blocked" : t.status;
          const deps = (t.blocked_by || []).length > 0 ? ` [after:${t.blocked_by.join(",")}]` : "";
          const rec = t.recurring ? " (recurring)" : "";
          results.push(`  ${id} [${t.priority || "medium"}] ${st}: ${t.subject}${deps}${rec}`);
          total++;
        }
      }
      if (!results.length) return { content: [{ type: "text" as const, text: "No tasks found" }] };
      return withLint({ content: [{ type: "text" as const, text: `${total} tasks:\n${results.join("\n")}` }] });
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
  { description: "Read a worker's state from the central registry. Returns status, perpetual/sleep config, last commit info, issue counts, and any custom state keys. For a single worker, returns raw JSON. For name='all', returns a formatted fleet dashboard with a table of all workers showing runtime, status, pane health (alive/dead), and current in-progress task — plus a custom state section. The fleet view also auto-discovers workers from the filesystem and prunes dead panes.", inputSchema: {
    name: z.string().optional().describe("Worker name to query. Omit for your own state. Use 'all' for a fleet-wide dashboard showing every registered worker, pane health, and active tasks"),
  } },
  async ({ name }) => {
    try {
      // Fleet-wide overview
      if (name === "all") {
        // Cache pane liveness to avoid duplicate subprocess calls per worker
        const paneAliveCache = new Map<string, boolean>();
        const checkPaneAlive = (paneId: string): boolean => {
          const cached = paneAliveCache.get(paneId);
          if (cached !== undefined) return cached;
          const alive = isPaneAlive(paneId);
          paneAliveCache.set(paneId, alive);
          return alive;
        };

        const registry = withRegistryLocked((reg) => {
          // Auto-discover workers from filesystem (only if they have mission.md)
          try {
            const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true })
              .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
              .filter(d => existsSync(join(WORKERS_DIR, d.name, "mission.md")))
              .map(d => d.name);
            for (const n of dirs) ensureWorkerInRegistry(reg, n);
          } catch {}
          // Auto-prune dead panes
          for (const [key, entry] of Object.entries(reg)) {
            if (key === "_config" || typeof entry !== "object" || !entry) continue;
            const w = entry as RegistryWorkerEntry;
            if (w.pane_id && !checkPaneAlive(w.pane_id)) {
              w.pane_id = null; w.pane_target = null; w.session_id = null;
            }
          }
          return { ...reg };
        });

        const projectName = basename(PROJECT_ROOT);
        let output = `=== Fleet Status (${projectName}) ===\n${new Date().toISOString()}\n\n`;
        const header = `${"Worker".padEnd(22)} ${"Runtime".padEnd(9)} ${"Status".padEnd(10)} ${"Pane".padEnd(12)} ${"Active Task"}`;
        output += header + "\n" + `${"------".padEnd(22)} ${"-------".padEnd(9)} ${"------".padEnd(10)} ${"----".padEnd(12)} ${"-----------"}\n`;

        const entries = Object.entries(registry).filter(([k]) => k !== "_config").sort(([a], [b]) => a.localeCompare(b));
        for (const [n, entry] of entries) {
          const w = entry as RegistryWorkerEntry;
          let task = "";
          try {
            const tasks = readTasks(n);
            const ip = Object.entries(tasks).find(([_, t]) => t.status === "in_progress");
            if (ip) task = `${ip[0]}: ${ip[1].subject}`.slice(0, 40);
          } catch {}
          const paneStatus = w.pane_id ? (checkPaneAlive(w.pane_id) ? `${w.pane_id}` : `${w.pane_id} DEAD`) : "—";
          const runtime = String(w.custom?.runtime || "claude");
          output += `${n.padEnd(22)} ${runtime.padEnd(9)} ${String(w.status || "?").padEnd(10)} ${paneStatus.padEnd(12)} ${task}\n`;
        }

        // Custom state
        const stateLines: string[] = [];
        for (const [n, entry] of entries) {
          const w = entry as RegistryWorkerEntry;
          if (w.custom && Object.keys(w.custom).length > 0) {
            stateLines.push(`  ${n}: ${Object.entries(w.custom).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")}`);
          }
        }
        if (stateLines.length > 0) output += "\n=== State ===\n" + stateLines.join("\n") + "\n";

        return withLint({ content: [{ type: "text" as const, text: output }] });
      }

      // Single worker state
      const targetName = name || WORKER_NAME;
      const entry = getWorkerEntry(targetName);
      if (!entry) {
        return { content: [{ type: "text" as const, text: `No state for worker '${targetName}'` }], isError: true };
      }
      const state: Record<string, any> = {
        status: entry.status,
        perpetual: entry.perpetual,
        sleep_duration: entry.sleep_duration,
        ...entry.custom,
      };
      if (entry.last_commit_sha) state.last_commit_sha = entry.last_commit_sha;
      if (entry.last_commit_msg) state.last_commit_msg = entry.last_commit_msg;
      if (entry.last_commit_at) state.last_commit_at = entry.last_commit_at;
      if (entry.issues_found) state.issues_found = entry.issues_found;
      if (entry.issues_fixed) state.issues_fixed = entry.issues_fixed;
      return withLint({ content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "update_state",
  { description: "Write a key-value pair to the worker registry that persists across recycles. Use for sleep_duration, custom metrics, feature flags, or any state that must survive restarts. Known keys (status, perpetual, sleep_duration, last_commit_sha/msg/at, issues_found/fixed, report_to) are stored at the top level; all other keys go into the custom state bag. Cross-worker updates require authority — you must be the target's report_to or the mission_authority.", inputSchema: {
    key: z.string().describe("State key name. Known keys (status, perpetual, sleep_duration, report_to, last_commit_sha, last_commit_msg, last_commit_at, issues_found, issues_fixed) go top-level. Any other key goes into the custom state bag"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("Value to store. Must be a primitive (string, number, or boolean)"),
    worker: z.string().optional().describe("Target worker. Omit to update your own state. Cross-worker updates are authorized only if you are the target's report_to or the mission_authority"),
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
        const STATE_KEYS = new Set(["status","perpetual","sleep_duration",
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
      return withLint({ content: [{ type: "text" as const, text: `Updated ${prefix}${key} = ${JSON.stringify(value)}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// fleet_status removed — merged into get_worker_state(name="all")

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
// DYNAMIC HOOKS — unified gate + inject, agent-managed
// ═══════════════════════════════════════════════════════════════════

function _pendingHooksSummary(event?: string): string {
  const hooks = [...dynamicHooks.values()];
  const pending = hooks.filter(h => h.blocking && !h.completed && (!event || h.event === event));
  const injects = hooks.filter(h => !h.blocking && (!event || h.event === event));
  const parts: string[] = [];
  if (pending.length > 0) parts.push(`${pending.length} blocking`);
  if (injects.length > 0) parts.push(`${injects.length} inject`);
  return parts.join(", ") || "none";
}

server.registerTool(
  "add_hook",
  {
    description: "Register a dynamic hook that fires on a hook event. Can block the event (gate) or inject context. Use for self-governance: add verification gates before recycling, inject guidance before tool calls, or block specific tool usage until conditions are met. Hook scripts read these at runtime.",
    inputSchema: {
      event: z.enum([
        "SessionStart", "SessionEnd", "InstructionsLoaded",
        "UserPromptSubmit",
        "PreToolUse", "PermissionRequest", "PostToolUse", "PostToolUseFailure",
        "Notification", "Stop",
        "SubagentStart", "SubagentStop", "TeammateIdle", "TaskCompleted",
        "ConfigChange", "PreCompact",
        "WorktreeCreate", "WorktreeRemove",
      ]).describe("Which hook event to fire on. Common: Stop (blocks session exit), PreToolUse (fires before tool call), PreCompact (before context compaction), SubagentStop (when subagent finishes)"),
      description: z.string().describe("Human-readable purpose (e.g. 'verify build passes', 'ontology guidance')"),
      blocking: z.boolean().optional().describe("If true (default for Stop), blocks the event until complete_hook(id) is called. If false (default for PreToolUse), injects content as context and passes through"),
      content: z.string().optional().describe("For inject hooks: context text to add. For blocking hooks: block reason shown to agent. Falls back to description if omitted"),
      condition: z.object({
        tool: z.string().optional().describe("Only fire when this tool is called (e.g. 'Bash', 'Edit', 'Write')"),
        file_glob: z.string().optional().describe("Only fire when file path matches glob (e.g. 'src/ontology/**')"),
        command_pattern: z.string().optional().describe("Only fire when Bash command matches regex (e.g. 'git push.*')"),
      }).optional().describe("Condition for when this hook fires (PreToolUse only). Omit for unconditional"),
      agent_id: z.string().optional().describe("Scope to a specific subagent. Auto-completed on SubagentStop. Subagents: use the agent_id injected by pre-tool-context-injector"),
    },
  },
  async ({ event, description, blocking, content, condition, agent_id }) => {
    const id = `dh-${++_hookCounter}`;
    // Stop defaults to blocking, most others default to inject
    const isBlocking = blocking ?? (event === "Stop");
    const hook: DynamicHook = {
      id, event, description,
      blocking: isBlocking,
      completed: false,
      added_at: new Date().toISOString(),
    };
    if (content) hook.content = content;
    if (condition) hook.condition = condition;
    if (agent_id) hook.agent_id = agent_id;
    dynamicHooks.set(id, hook);
    _persistHooks();
    const agentNote = agent_id ? ` (scoped to subagent ${agent_id})` : "";
    const typeLabel = isBlocking ? "blocking" : "inject";
    const condNote = condition ? ` [condition: ${JSON.stringify(condition)}]` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Hook registered: [${id}] ${event}/${typeLabel} — ${description}${agentNote}${condNote}\nActive hooks: ${_pendingHooksSummary()}.`,
      }],
    };
  }
);

server.registerTool(
  "complete_hook",
  {
    description: "Mark a blocking hook as completed (unblocks the event). Call after performing the verification described in the hook. Pass 'all' to complete every pending blocking hook at once.",
    inputSchema: {
      id: z.string().describe("Hook ID (e.g. 'dh-1'). Use 'all' to complete all pending blocking hooks"),
      result: z.string().optional().describe("Brief outcome (e.g. 'PASS — 0 errors'). Stored for audit"),
    },
  },
  async ({ id, result }) => {
    if (id === "all") {
      const pending = [...dynamicHooks.values()].filter(h => h.blocking && !h.completed);
      if (pending.length === 0) {
        return { content: [{ type: "text" as const, text: "No pending blocking hooks to complete." }] };
      }
      const now = new Date().toISOString();
      for (const hook of pending) {
        hook.completed = true;
        hook.completed_at = now;
        if (result) hook.result = result;
      }
      _persistHooks();
      return {
        content: [{
          type: "text" as const,
          text: `Completed ${pending.length} hook(s). All blocking hooks cleared.`,
        }],
      };
    }
    const hook = dynamicHooks.get(id);
    if (!hook) {
      return { content: [{ type: "text" as const, text: `No hook with ID '${id}'.` }], isError: true };
    }
    hook.completed = true;
    hook.completed_at = new Date().toISOString();
    if (result) hook.result = result;
    _persistHooks();
    const pending = [...dynamicHooks.values()].filter(h => h.blocking && !h.completed);
    const resultNote = result ? ` (${result})` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Completed: [${id}] ${hook.description}${resultNote}\n${pending.length} blocking hook(s) remaining.`,
      }],
    };
  }
);

server.registerTool(
  "remove_hook",
  {
    description: "Remove a dynamic hook entirely. Use for inject hooks you no longer need, or to clean up completed gates.",
    inputSchema: {
      id: z.string().describe("Hook ID to remove (e.g. 'dh-2'). Use 'all' to remove all hooks"),
    },
  },
  async ({ id }) => {
    if (id === "all") {
      const count = dynamicHooks.size;
      dynamicHooks.clear();
      _persistHooks();
      return { content: [{ type: "text" as const, text: `Removed all ${count} hook(s).` }] };
    }
    const hook = dynamicHooks.get(id);
    if (!hook) {
      return { content: [{ type: "text" as const, text: `No hook with ID '${id}'.` }], isError: true };
    }
    dynamicHooks.delete(id);
    _persistHooks();
    return {
      content: [{
        type: "text" as const,
        text: `Removed: [${id}] ${hook.description}\nRemaining hooks: ${_pendingHooksSummary()}.`,
      }],
    };
  }
);

// add_stop_check / complete_stop_check aliases removed — use add_hook(event="Stop", blocking=true) / complete_hook() directly

// ═══════════════════════════════════════════════════════════════════
// LIFECYCLE TOOLS (4) — recycle, heartbeat, check_config, reload
// ═══════════════════════════════════════════════════════════════════

server.registerTool(
  "recycle",
  { description: "Restart yourself in the same tmux pane to get a fresh context window. Three modes: (1) Default (cold restart): exits current session, generates a new seed file with the handoff message, and launches a brand-new Claude session. (2) resume=true (hot restart): resume same session ID — preserves full conversation history but reloads MCP config. (3) Perpetual workers with sleep_duration: exits session and lets the watchdog respawn after sleep_duration seconds (no immediate relaunch). Use sleep_seconds to override sleep_duration for this cycle. Blocked by pending dynamic hooks unless force=true.", inputSchema: {
    message: z.string().optional().describe("Handoff context for the next instance. Include: what was accomplished, what remains, any blockers or decisions needed. Written to handoff.md and injected into the next session's seed"),
    resume: z.boolean().optional().describe("If true, hot-restart: resume the same session (keeps conversation history, reloads MCP/model config). If false (default), cold-restart with a fresh seed"),
    force: z.boolean().optional().describe("If true, bypass the stop-check gate. Use only when pending checks are genuinely not applicable to the current cycle"),
    sleep_seconds: z.number().optional().describe("Override sleep_duration for this recycle only. The watchdog will respawn after this many seconds. 0 = immediate restart (no sleep). Only applies to perpetual workers"),
    cancel: z.boolean().optional().describe("If true, cancel a pending sleep timer (clears status=sleeping). Use when you realize you have more work and don't need to restart yet"),
  } },
  async ({ message, resume, force, sleep_seconds, cancel }) => {
    // 0a. Cancel mode — abort a pending sleep timer
    if (cancel) {
      withRegistryLocked((registry) => {
        const w = registry[WORKER_NAME] as RegistryWorkerEntry;
        if (w && w.status === "sleeping") {
          w.status = "active";
          if (w.custom) w.custom.sleep_until = null;
        }
      });
      return { content: [{ type: "text" as const, text: "Sleep timer cancelled. Status restored to active." }] };
    }

    // 0. Gate on blocking hooks (unified: stop checks + any blocking gates)
    const pendingChecks = [...dynamicHooks.values()].filter(h => h.blocking && !h.completed);
    if (pendingChecks.length > 0 && !force) {
      const checkList = pendingChecks.map(h => `  [${h.id}] ${h.event}/${h.blocking ? "gate" : "inject"} — ${h.description}`).join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `BLOCKED: ${pendingChecks.length} pending hook(s) — complete these before recycling:\n\n${checkList}\n\nUse complete_hook(id) to mark each done, or recycle(force=true) to skip.`,
        }],
        isError: true,
      };
    }

    // 1. Find own pane
    const ownPane = findOwnPane();
    if (!ownPane) {
      return { content: [{ type: "text" as const, text: "Error: Could not find own pane in registry. Are you running in tmux?" }], isError: true };
    }

    // 1b. Check for unread mail (best-effort)
    let pendingWarning = "";
    try {
      const bmsToken = (getWorkerEntry(WORKER_NAME) as any)?.bms_token;
      if (bmsToken) {
        const resp = await fetch(`${BMS_URL}/api/messages?label=UNREAD&maxResults=1`, {
          headers: { Authorization: `Bearer ${bmsToken}` },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const data = await resp.json() as any;
          const unread = data?._diagnostics?.unread_count || 0;
          if (unread > 0) {
            pendingWarning = `\n\nWARNING: ${unread} unread mail — call mail_inbox() before recycling.`;
          }
        }
      }
    } catch {}

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
        ? `[${WORKER_NAME}] Cycle complete: ${message}`
        : `[${WORKER_NAME}] Cycle complete (no summary provided)`;

      // Notify mission_authority via BMS (best-effort)
      const operatorName = config?.mission_authority || null;
      if (operatorName && operatorName !== WORKER_NAME) {
        getBmsToken().then(async () => {
          const toIds = await resolveBmsRecipients([operatorName]);
          await bmsRequest("POST", "/api/messages/send", {
            to: toIds, subject: `${WORKER_NAME} cycle done`,
            body: cycleReport, cc: [], thread_id: null, in_reply_to: null,
            reply_by: null, labels: ["CYCLE-REPORT"], attachments: [],
          });
        }).catch(() => {});
      }
    } catch {
      // Best-effort notification — don't block recycle if it fails
    }

    // 4b. Resume mode — hot-restart, same session, no seed
    if (resume) {
      const sessionId = getSessionId(ownPane.paneId);
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Could not detect session ID — cannot resume." }], isError: true };
      }
      const model = getWorkerModel();
      const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
      const worktreeDir = getWorktreeDir();
      const rt = getWorkerRuntime();
      const resumeCmd = rt.buildResumeCmd({ model, permissionMode: "bypassPermissions", workerDir, sessionId });

      // Write resume command to temp file to avoid shell quoting issues
      const resumeCmdFile = `/tmp/resume-cmd-${WORKER_NAME}-${Date.now()}.txt`;
      writeFileSync(resumeCmdFile, `echo 'Continue from where you left off.' | ${resumeCmd}`);

      const reloadScript = `/tmp/reload-${WORKER_NAME}-${Date.now()}.sh`;
      writeFileSync(reloadScript, `#!/bin/bash
set -uo pipefail
PANE_ID="${ownPane.paneId}"
RESUME_CMD_FILE="${resumeCmdFile}"
sleep 3
tmux send-keys -t "$PANE_ID" "${rt.exitCommand}"
tmux send-keys -t "$PANE_ID" -H 0d
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && { echo "FATAL: pane gone"; exit 1; }
  AGENT_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *${rt.binary}* ]] && AGENT_RUNNING=true && break
  done
  [ "$AGENT_RUNNING" = "false" ] && break
done
sleep 2
tmux send-keys -t "$PANE_ID" "cd ${worktreeDir}"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 1
# Use load-buffer to avoid shell quoting issues with resume command
tmux load-buffer -b "resume-$$" "$RESUME_CMD_FILE"
tmux paste-buffer -b "resume-$$" -t "$PANE_ID" -d
tmux send-keys -t "$PANE_ID" -H 0d
rm -f "${reloadScript}" "$RESUME_CMD_FILE"
`);

      execSync(`nohup bash "${reloadScript}" > /dev/null 2>&1 &`, { shell: "/bin/bash", timeout: 5000 });

      return {
        content: [{
          type: "text" as const,
          text: `Hot-restarting — /exit in ~3s, then session ${sessionId} resumes.\nModel: ${model}\nDo NOT send any more tool calls — /exit is imminent.` + pendingWarning,
        }],
      };
    }

    // 5. Get config
    const model = getWorkerModel();
    const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
    const rt = getWorkerRuntime();

    // 6. Check if this is a perpetual worker that should defer to watchdog
    const entry = getWorkerEntry(WORKER_NAME);
    const isPerpetual = entry?.perpetual === true;
    const registrySleepDur = entry?.sleep_duration ?? 1800;
    // sleep_seconds param overrides registry sleep_duration for this cycle
    // sleep_seconds=0 means "immediate restart, no sleep"
    const effectiveSleep = sleep_seconds !== undefined ? sleep_seconds : registrySleepDur;
    const shouldDeferToWatchdog = isPerpetual && effectiveSleep > 0;

    if (shouldDeferToWatchdog) {
      // ── Deferred recycle: kill session, let watchdog respawn after sleep ──
      const sleepUntil = new Date(Date.now() + effectiveSleep * 1000).toISOString();

      // Set status=sleeping and sleep_until in registry
      withRegistryLocked((registry) => {
        const w = registry[WORKER_NAME] as RegistryWorkerEntry;
        if (w) {
          w.status = "sleeping";
          w.custom = w.custom || {};
          w.custom.sleep_until = sleepUntil;
          w.custom.last_recycle_at = new Date().toISOString();
        }
      });

      // Generate exit-only script (no relaunch — watchdog handles that)
      const recycleScript = `/tmp/recycle-${WORKER_NAME}-${Date.now()}.sh`;
      writeFileSync(recycleScript, `#!/bin/bash
# Auto-generated SLEEP recycle for ${WORKER_NAME} — watchdog will respawn after ${effectiveSleep}s
set -uo pipefail
PANE_ID="${ownPane.paneId}"
sleep 5
tmux send-keys -t "$PANE_ID" "${rt.exitCommand}"
tmux send-keys -t "$PANE_ID" -H 0d
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && break
  AGENT_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *${rt.binary}* ]] && AGENT_RUNNING=true && break
  done
  [ "$AGENT_RUNNING" = "false" ] && break
done
rm -f "${recycleScript}"
`);

      try {
        execSync(`nohup bash "${recycleScript}" > /tmp/recycle-${WORKER_NAME}.log 2>&1 &`, {
          shell: "/bin/bash", timeout: 5000,
        });
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error spawning recycle: ${e.message}` }], isError: true };
      }

      const wakeTime = new Date(Date.now() + effectiveSleep * 1000);
      const wakeStr = `${wakeTime.getHours().toString().padStart(2, "0")}:${wakeTime.getMinutes().toString().padStart(2, "0")}`;
      return {
        content: [{
          type: "text" as const,
          text: `Recycling initiated. Watchdog will respawn in ${effectiveSleep}s (~${wakeStr}).\n` +
            `Handoff: ${message ? "written to handoff.md" : "none"}\n` +
            `Transcript: ${transcriptPath || "unknown"}\n` +
            `Status: sleeping (until ${sleepUntil})\n` +
            `Do NOT send any more tool calls — /exit will be sent shortly.` +
            pendingWarning,
        }],
      };
    }

    // ── Immediate recycle (non-perpetual or sleep_seconds=0) ──

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
    const permMode = entry?.permission_mode || "bypassPermissions";
    const disallowed = Array.isArray(entry?.disallowed_tools) ? entry!.disallowed_tools.join(",") : "";
    const effort = entry?.custom?.reasoning_effort as ReasoningEffort | undefined;
    const agentLaunchCmd = rt.buildLaunchCmd({ model, permissionMode: permMode, disallowedTools: disallowed || undefined, workerDir, reasoningEffort: effort });
    const tuiPatternStr = rt.tuiReadyPattern.source;

    // Write launch command to a separate file to avoid shell quoting issues.
    // The command contains --disallowed-tools "Bash(git merge*),..." which has
    // nested double-quotes and parentheses that break bash if interpolated inline.
    const launchCmdFile = `/tmp/launch-cmd-${WORKER_NAME}-${Date.now()}.txt`;
    writeFileSync(launchCmdFile, agentLaunchCmd);

    writeFileSync(recycleScript, `#!/bin/bash
# Auto-generated recycle script for ${WORKER_NAME} (runtime: ${rt.type})
set -uo pipefail
PANE_ID="${ownPane.paneId}"
PANE_TARGET="${ownPane.paneTarget}"
SEED_FILE="${seedFile}"
LAUNCH_CMD_FILE="${launchCmdFile}"

# Wait for MCP tool response to propagate to TUI
sleep 5

# Send exit command (graceful — keeps pane alive with shell prompt)
tmux send-keys -t "$PANE_ID" "${rt.exitCommand}"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for agent to exit and shell prompt to return (max 30s)
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && { echo "FATAL: pane $PANE_ID gone"; exit 1; }
  AGENT_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *${rt.binary}* ]] && AGENT_RUNNING=true && break
  done
  [ "$AGENT_RUNNING" = "false" ] && break
done

# Small delay for shell prompt to stabilize
sleep 2

# Change to worktree directory
tmux send-keys -t "$PANE_ID" "cd ${worktreeDir}"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 1

# Launch agent via tmux buffer (avoids shell quoting issues with parens in --disallowed-tools)
LAUNCH_BUFFER="launch-${WORKER_NAME}-$$"
tmux load-buffer -b "$LAUNCH_BUFFER" "$LAUNCH_CMD_FILE"
tmux paste-buffer -b "$LAUNCH_BUFFER" -t "$PANE_ID" -d
sleep 1
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for TUI ready (poll for statusline, max 90s)
WAIT=0
until tmux capture-pane -t "$PANE_ID" -p 2>/dev/null | grep -qE "${tuiPatternStr}"; do
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
rm -f "${recycleScript}" "$LAUNCH_CMD_FILE"
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

// check_config removed — lint runs on every tool call via withLint()

// ═══════════════════════════════════════════════════════════════════
// WORKER MANAGEMENT (1)
// ═══════════════════════════════════════════════════════════════════

type WorkerType = "implementer" | "monitor" | "coordinator" | "optimizer" | "verifier";
type WorkerRuntime = "claude" | "codex";

type ReasoningEffort = "low" | "medium" | "high" | "extra_high";

// ── Runtime Configuration ─────────────────────────────────────────────
// Abstract interface for Claude vs Codex CLI differences.

interface RuntimeLaunchOpts {
  model: string;
  permissionMode: string;
  disallowedTools?: string;
  workerDir: string;
  reasoningEffort?: ReasoningEffort;
}

interface RuntimeResumeOpts {
  model: string;
  permissionMode: string;
  workerDir: string;
  sessionId: string;
}

interface RuntimeConfig {
  type: WorkerRuntime;
  binary: string;
  defaultModel: string;
  buildLaunchCmd(opts: RuntimeLaunchOpts): string;
  buildResumeCmd(opts: RuntimeResumeOpts): string;
  buildForkCmd(opts: RuntimeResumeOpts): string;
  exitCommand: string;
  processPattern: RegExp;
  tuiReadyPattern: RegExp;
  buildEnv(): Record<string, string>;
}

const CLAUDE_RUNTIME: RuntimeConfig = {
  type: "claude",
  binary: "claude",
  defaultModel: "opus",
  buildLaunchCmd({ model, permissionMode, disallowedTools, workerDir, reasoningEffort }) {
    let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model}`;
    if (permissionMode === "bypassPermissions") cmd += " --dangerously-skip-permissions";
    if (reasoningEffort) cmd += ` --effort ${reasoningEffort}`;
    if (disallowedTools) cmd += ` --disallowed-tools "${disallowedTools}"`;
    cmd += ` --add-dir ${workerDir}`;
    return cmd;
  },
  buildResumeCmd({ model, permissionMode, workerDir, sessionId }) {
    let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model}`;
    if (permissionMode === "bypassPermissions") cmd += " --dangerously-skip-permissions";
    cmd += ` --add-dir ${workerDir} --resume ${sessionId}`;
    return cmd;
  },
  buildForkCmd({ model, permissionMode, workerDir, sessionId }) {
    let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 claude --model ${model}`;
    if (permissionMode === "bypassPermissions") cmd += " --dangerously-skip-permissions";
    cmd += ` --add-dir ${workerDir} --resume ${sessionId} --fork-session`;
    return cmd;
  },
  exitCommand: "/exit",
  processPattern: /claude/,
  tuiReadyPattern: /bypass permissions|Context left/,
  buildEnv() {
    return { CLAUDE_CODE_SKIP_PROJECT_LOCK: "1" };
  },
};

const CODEX_RUNTIME: RuntimeConfig = {
  type: "codex",
  binary: "codex",
  defaultModel: "gpt-5.4",
  buildLaunchCmd({ model, permissionMode, reasoningEffort }) {
    let cmd = `codex -m ${model}`;
    if (permissionMode === "bypassPermissions") cmd += " --dangerously-bypass-approvals-and-sandbox";
    else cmd += " -s workspace-write -a on-request";
    if (reasoningEffort) cmd += ` -c model_reasoning_effort=${reasoningEffort}`;
    cmd += " --no-alt-screen";
    return cmd;
  },
  buildResumeCmd({ sessionId }) {
    return `codex resume ${sessionId}`;
  },
  buildForkCmd({ sessionId }) {
    return `codex fork ${sessionId}`;
  },
  exitCommand: "/exit",
  processPattern: /codex/,
  tuiReadyPattern: /codex|ready/i,
  buildEnv() {
    return {};
  },
};

const RUNTIMES: Record<WorkerRuntime, RuntimeConfig> = {
  claude: CLAUDE_RUNTIME,
  codex: CODEX_RUNTIME,
};

/** Get the RuntimeConfig for a worker by name. Reads custom.runtime from registry. */
function getWorkerRuntime(workerName?: string): RuntimeConfig {
  const name = workerName || WORKER_NAME;
  try {
    const entry = getWorkerEntry(name);
    const rt = (entry?.custom?.runtime as WorkerRuntime) || "claude";
    return RUNTIMES[rt] || CLAUDE_RUNTIME;
  } catch {
    return CLAUDE_RUNTIME;
  }
}

interface CreateWorkerInput {
  name: string;
  mission: string;
  type?: WorkerType;
  runtime?: WorkerRuntime;
  model?: string;
  reasoning_effort?: ReasoningEffort;
  perpetual?: boolean;
  sleep_duration?: number;
  disallowed_tools?: string[];
  window?: string;
  report_to?: string;
  permission_mode?: string;
  taskEntries?: Array<{ subject: string; description?: string; priority?: string }>;
  proposal_required?: boolean;
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
    const defaults = JSON.parse(readFileSync(join(typeDir, "defaults.json"), "utf-8"));
    if (typeof defaults.perpetual === "boolean") result.perpetual = defaults.perpetual;
    if (typeof defaults.sleep_duration === "number") result.sleep_duration = defaults.sleep_duration;
  } catch {}
  return result;
}

interface CreateWorkerResult {
  ok: boolean;
  error?: string;
  workerDir?: string;
  model?: string;
  runtime?: WorkerRuntime;
  perpetual?: boolean;
  taskIds?: string[];
  tasks?: Record<string, Task>;
  state?: Record<string, any>;
  permissions?: Record<string, any>;
}

/** Core logic for creating a worker's directory and files. Exported for testing. */
function createWorkerFiles(input: CreateWorkerInput): CreateWorkerResult {
  const { name, mission, type, runtime, model, reasoning_effort, perpetual, sleep_duration, disallowed_tools, window: windowGroup, report_to, permission_mode, taskEntries = [] } = input;
  const resolvedRuntime: WorkerRuntime = runtime || "claude";

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

  // MEMORY.md — project-level auto-memory subdirectory (shared across all workers)
  // Path: ~/.claude/projects/{project-slug}/memory/{worker-name}/MEMORY.md
  const projectSlug = PROJECT_ROOT.replace(/\//g, "-");
  const autoMemoryDir = join(HOME, ".claude", "projects", projectSlug, "memory", name);
  mkdirSync(autoMemoryDir, { recursive: true });
  const autoMemoryPath = join(autoMemoryDir, "MEMORY.md");
  // Remove stale symlink if present (legacy linkWorkerMemory artifact), then write real file
  try { if (lstatSync(autoMemoryPath).isSymbolicLink()) { rmSync(autoMemoryPath); } } catch {}
  if (!existsSync(autoMemoryPath)) {
    writeFileSync(autoMemoryPath, `# ${name} Memory\n\n`);
  }

  // mission.md
  writeFileSync(join(workerDir, "mission.md"), mission.trim() + "\n");

  // Config — override precedence: explicit param > type template > runtime default > hardcoded default
  const defaultDisallowed = [
    "Bash(git checkout main*)",
    "Bash(git merge*)",
    "Bash(git push*)",
    "Bash(git reset --hard*)",
    "Bash(git clean*)",
    "Bash(rm -rf*)",
  ];
  const runtimeModelDefault = resolvedRuntime === "codex" ? "gpt-5.4" : "opus";
  const selectedModel = model ?? tpl.model ?? runtimeModelDefault;
  const resolvedEffort: ReasoningEffort = reasoning_effort ?? "high";
  const resolvedDisallowed = disallowed_tools ?? tpl.disallowedTools ?? defaultDisallowed;
  const resolvedPermMode = permission_mode ?? tpl.permission_mode ?? "bypassPermissions";
  const permissions = {
    model: selectedModel,
    permission_mode: resolvedPermMode,
    reasoning_effort: resolvedEffort,
    disallowedTools: resolvedDisallowed,
    window: windowGroup || null,
    report_to: report_to || null,
    runtime: resolvedRuntime,
  };

  // State — override precedence: explicit param > type template > hardcoded default
  const isPerpetual = perpetual ?? tpl.perpetual ?? false;
  const state: Record<string, any> = {
    status: "idle",
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

  return { ok: true, workerDir, model: selectedModel, runtime: resolvedRuntime, perpetual: isPerpetual, taskIds, tasks: tasksObj, state, permissions };
}

// ── Shared pane-move logic ──────────────────────────────────────────────
/** Move a worker's tmux pane to a target window. Returns a status string. */
function moveWorkerPane(
  paneId: string,
  tmuxSession: string,
  targetWindow: string,
): string {
  try {
    // Normalize common typos
    if (targetWindow === "stand-by") targetWindow = "standby";
    spawnSync("tmux", ["rename-window", "-t", `${tmuxSession}:stand-by`, "standby"], { encoding: "utf-8" });

    // Ensure target window exists
    const windowCheck = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf-8" });
    const windows = (windowCheck.stdout || "").split("\n").map(w => w.trim());
    if (!windows.includes(targetWindow)) {
      spawnSync("tmux", ["new-window", "-t", tmuxSession, "-n", targetWindow, "-d"], { encoding: "utf-8" });
    }

    // Move the pane
    const moveRes = spawnSync("tmux", ["move-pane", "-s", paneId, "-t", `${tmuxSession}:${targetWindow}`], { encoding: "utf-8" });
    if (moveRes.status === 0) {
      spawnSync("tmux", ["select-layout", "-t", `${tmuxSession}:${targetWindow}`, "tiled"], { encoding: "utf-8" });
      return `Pane ${paneId}: moved to ${tmuxSession}:${targetWindow}`;
    } else {
      return `Pane ${paneId}: move failed — ${(moveRes.stderr || "").trim()}`;
    }
  } catch (e: any) {
    return `Pane move error: ${e.message}`;
  }
}

// ── Fleet handler functions ─────────────────────────────────────────────

type McpResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function handleFleetCreate(params: Record<string, any>): Promise<McpResult> {
  const { name, mission, type, runtime, model, reasoning_effort, perpetual, sleep_duration, disallowed_tools: disallowedToolsJson, window: windowGroup, window_index: windowIndex, report_to, permission_mode, launch, tasks: tasksJson, proposal_required, fork_from_session, direct_report } = params;

  if (!name) return { content: [{ type: "text" as const, text: `Error: 'name' is required for create` }], isError: true };
  if (!mission) return { content: [{ type: "text" as const, text: `Error: 'mission' is required for create` }], isError: true };

  try {
    // Enforce unique worker names
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
    const result = createWorkerFiles({ name, mission, type, runtime, model, reasoning_effort, perpetual, sleep_duration, disallowed_tools: disallowedTools, window: windowGroup, report_to, permission_mode, taskEntries, proposal_required });
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
    const { state, permissions, runtime: resolvedRuntime, taskIds, model: selectedModel, perpetual: isPerpetual } = result as Required<CreateWorkerResult>;
    withRegistryLocked((registry) => {
      ensureWorkerInRegistry(registry, name);
      const entry = registry[name] as RegistryWorkerEntry;
      entry.model = permissions.model || "opus";
      entry.permission_mode = permissions.permission_mode || "bypassPermissions";
      entry.disallowed_tools = permissions.disallowedTools || [];
      entry.status = state.status || "idle";
      entry.perpetual = state.perpetual || false;
      entry.sleep_duration = state.sleep_duration || 1800;
      if (permissions.window) {
        entry.window = permissions.window;
      }
      entry.report_to = reportTo;
      entry.custom = { ...entry.custom, runtime: resolvedRuntime || "claude", reasoning_effort: permissions.reasoning_effort || "high" };
      if (proposal_required) {
        entry.custom.proposal_required = true;
      }
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
      // Symlink gitignored essential files (.env, users.json, projects.json) from main repo
      const setupScript = join(PROJECT_ROOT, ".claude/scripts/worker/setup-worktree.sh");
      if (existsSync(setupScript)) {
        try { execSync(`bash "${setupScript}" "${worktreeDir}"`, { timeout: 5000 }); } catch {}
      }
    } catch {}

    // ── Launch helpers (shared by all placement modes) ──

    /** Create a tmux pane in the named window group. Returns pane ID or null. */
    function createPane(_pl: string, cwd: string): string | null {
      const ownPane = findOwnPane();
      const tmuxSession = ownPane?.paneTarget?.split(":")[0] || "w";
      const winName = windowGroup || "workers";
      const winCheck = spawnSync("tmux", ["list-windows", "-t", tmuxSession, "-F", "#{window_name}"], { encoding: "utf-8" });
      const windows = (winCheck.stdout || "").split("\n").map(w => w.trim());
      if (!windows.includes(winName)) {
        // Use explicit window index if provided, otherwise let tmux auto-assign
        const target = windowIndex != null ? `${tmuxSession}:${windowIndex}` : tmuxSession;
        return execSync(
          `tmux new-window -t "${target}" -n "${winName}" -d -P -F '#{pane_id}' -c "${cwd}"`,
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

    // ── Optional launch ──
    // ALL launches go through launch-flat-worker.sh (reliable: waits for TUI, paste-buffer, retries).
    // Fork uses fork-worker.sh (inherits conversation context).
    // Never use spawnInPane + tmux send-keys — it's fragile and breaks on escaping.
    let launchInfo = "";
    if (launch) {
      if (fork_from_session) {
        // Fork path: inherit caller's conversation context via fork-worker.sh
        const ownPane = findOwnPane();
        const sessionId = ownPane ? getSessionId(ownPane.paneId) : null;
        if (!ownPane) {
          launchInfo = `\n  Launch: SKIPPED — could not find own pane (not in tmux?). Run manually: bash fork-worker.sh`;
        } else if (!sessionId) {
          launchInfo = `\n  Launch: SKIPPED — no session ID for pane ${ownPane.paneId}. Run manually: bash fork-worker.sh`;
        } else {
          // Copy session data to new worktree's project dir.
          // Session JSONLs are stored under ~/.claude/projects/{cwd-slug}/.
          // The caller's session is under their WORKTREE's slug (process.cwd()), not PROJECT_ROOT.
          if (worktreeReady) {
            try {
              const callerCwd = process.cwd();
              const parentSlug = callerCwd.replace(/\//g, "-");
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

          // Fork needs a TTY (Claude runs interactively), so we must run inside the pane.
          // Write a self-contained wrapper script and send just "bash /tmp/wrapper.sh" to the pane.
          // The wrapper cleans up AFTER fork-worker.sh finishes (blocking), avoiding race conditions.
          try {
            const childPaneId = createPane("window", worktreeReady ? worktreeDir : PROJECT_ROOT);
            if (!childPaneId?.startsWith("%")) {
              launchInfo = `\n  Launch: SKIPPED — pane creation failed. Run manually.`;
            } else {
              registerPane(childPaneId);
              const forkScript = join(CLAUDE_OPS, "scripts/fork-worker.sh");
              const workerModel = selectedModel || "opus";
              const workerDir = join(PROJECT_ROOT, ".claude/workers", name);
              const cwdFlag = worktreeReady ? `--cwd ${worktreeDir}` : "";
              const wrapperPath = `/tmp/fork-launch-${name}-${Date.now()}.sh`;

              // Write wrapper script — fork-worker.sh blocks until Claude exits, so cleanup is safe
              const wrapperContent = [
                `#!/bin/bash`,
                `cd ${worktreeReady ? worktreeDir : PROJECT_ROOT}`,
                `bash ${forkScript} ${ownPane.paneId} ${sessionId} --name ${name} --no-worktree ${cwdFlag} --model ${workerModel} --dangerously-skip-permissions --add-dir ${workerDir}`,
                `rm -f "${wrapperPath}"`,
              ].join("\n");
              writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });

              // Send short command to pane — no escaping issues
              execSync(`tmux send-keys -t "${childPaneId}" "bash ${wrapperPath}" && tmux send-keys -t "${childPaneId}" -H 0d`, { timeout: 5000 });
              launchInfo = `\n  Launched (fork from ${sessionId}): pane ${childPaneId}`;
            }
          } catch (e: any) {
            launchInfo = `\n  Launch: FAILED — ${e.message}`;
          }
        }
      } else {
        // Non-fork: always delegate to launch-flat-worker.sh (reliable path)
        const launchScript = join(CLAUDE_OPS, "scripts/launch-flat-worker.sh");
        if (!existsSync(launchScript)) {
          launchInfo = `\n  Launch: FAILED — script not found: ${launchScript}`;
        } else {
          const launchArgs = [launchScript, name, "--project", PROJECT_ROOT];
          const winGroup = windowGroup || permissions.window;
          if (winGroup) launchArgs.push("--window", winGroup);
          if (windowIndex != null) launchArgs.push("--window-index", String(windowIndex));
          const launchResult = spawnSync("bash", launchArgs, {
            encoding: "utf-8", timeout: 120_000,
            env: { ...process.env, PROJECT_ROOT, WORKER_RUNTIME: resolvedRuntime || "claude" },
          });
          if (launchResult.status === 0) {
            const paneMatch = launchResult.stdout.match(/pane\s+(%\d+)/);
            launchInfo = `\n  Launched: pane ${paneMatch ? paneMatch[1] : "unknown"}`;
          } else {
            launchInfo = `\n  Launch: FAILED (exit ${launchResult.status}) — ${(launchResult.stderr || "").slice(0, 200)}`;
          }
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
      `  Runtime: ${resolvedRuntime} | Model: ${selectedModel} | Perpetual: ${isPerpetual}`,
      permissions.window ? `  Window: ${permissions.window}` : null,
      `  Reports to: ${reportTo}`,
      fork_from_session ? `  Forked from: ${WORKER_NAME}` : null,
      proposal_required ? `  Proposal: REQUIRED (worker produces HTML proposal before coding)` : null,
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

async function handleFleetTemplate(params: Record<string, any>): Promise<McpResult> {
  const { type } = params;
  if (!type) return { content: [{ type: "text" as const, text: `Error: 'type' is required for template` }], isError: true };

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
    const defaults = JSON.parse(readFileSync(join(typeDir, "defaults.json"), "utf-8"));
    sections.push("## Defaults (from defaults.json)\n" +
      `- **perpetual**: ${defaults.perpetual}\n` +
      `- **sleep_duration**: ${defaults.sleep_duration}s\n`);
  } catch { sections.push("## defaults.json\n_Not found_\n"); }
  sections.push("## Usage\n`create_worker(name=\"...\", type=\"" + type + "\", mission=\"# Your mission here\\n...\")`\nThe `type` sets model/permissions/perpetual/sleep defaults. You always write your own mission. Explicit params override type defaults.");
  return { content: [{ type: "text" as const, text: sections.join("\n") }] };
}

async function handleFleetMove(params: Record<string, any>): Promise<McpResult> {
  const { name, window: targetWindow, reason } = params;
  if (!targetWindow) return { content: [{ type: "text" as const, text: `Error: 'window' is required for move` }], isError: true };

  const targetName = name || WORKER_NAME;

  // Authorization: self or mission_authority
  const _mwRegistry = readRegistry();
  const _mwConfig = _mwRegistry._config as RegistryConfig | undefined;
  const _mwAuth = _mwConfig?.mission_authority || "chief-of-staff";
  if (targetName !== WORKER_NAME && WORKER_NAME !== _mwAuth) {
    return {
      content: [{
        type: "text" as const,
        text: `Only ${_mwAuth} (mission_authority) can move other workers. Contact ${_mwAuth}.`,
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

  const paneId = existing.pane_id;
  const tmuxSession = existing.tmux_session || "w";

  if (!paneId) {
    return {
      content: [{ type: "text" as const, text: `Worker '${targetName}' has no pane_id — cannot move.` }],
      isError: true,
    };
  }

  // Move the pane
  const moveResult = moveWorkerPane(paneId, tmuxSession, targetWindow);

  // Update registry
  const previousWindow = existing.window;
  const isMovingToStandby = targetWindow === "standby";
  const isMovingFromStandby = existing.status === "standby" && targetWindow !== "standby";

  withRegistryLocked((registry) => {
    const entry = registry[targetName] as RegistryWorkerEntry;
    if (entry) {
      entry.window = targetWindow;
      if (isMovingToStandby) {
        entry.status = "standby";
      } else if (isMovingFromStandby) {
        entry.status = "active";
      }
    }
  });

  // Write handoff if going to standby
  if (isMovingToStandby && reason) {
    try {
      const handoffPath = join(WORKERS_DIR, targetName, "handoff.md");
      const timestamp = new Date().toISOString();
      writeFileSync(handoffPath, `# Standby\n\n**At:** ${timestamp}\n**Reason:** ${reason}\n\nWorker is in standby — registered but not running. Call move_worker(name="${targetName}", window="${previousWindow || targetName}") to wake.\n`);
    } catch {}
  }

  const statusChange = isMovingToStandby
    ? " status=standby (watchdog will ignore)"
    : isMovingFromStandby
      ? " status=active (woken from standby)"
      : "";

  return {
    content: [{
      type: "text" as const,
      text: [
        `Worker '${targetName}' moved: ${previousWindow || "?"} → ${targetWindow}.${statusChange}`,
        `  ${moveResult}`,
        reason ? `  Reason: ${reason}` : null,
      ].filter(Boolean).join("\n"),
    }],
  };
}

async function handleFleetStandby(params: Record<string, any>): Promise<McpResult> {
  const { name, reason } = params;
  const targetName = name || WORKER_NAME;

  // Authorization: self-only unless mission_authority
  const _sbRegistry = readRegistry();
  const _sbConfig = _sbRegistry._config as RegistryConfig | undefined;
  const _sbAuth = _sbConfig?.mission_authority || "chief-of-staff";
  if (targetName !== WORKER_NAME && WORKER_NAME !== _sbAuth) {
    return {
      content: [{
        type: "text" as const,
        text: `Only ${_sbAuth} (mission_authority) can toggle standby for other workers. Contact ${_sbAuth}.`,
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

  const isStandby = existing.status === "standby";
  const tmuxSession = existing.tmux_session || "w";

  if (isStandby) {
    // ── WAKE UP: standby → active ──
    // Move the pane back to its original window
    const paneId = existing.pane_id;
    const originalWindow = existing.window || targetName;
    let moveResult = "";

    if (paneId) {
      moveResult = moveWorkerPane(paneId, tmuxSession, originalWindow);
    } else {
      moveResult = "No pane_id in registry — pane may have been killed";
    }

    withRegistryLocked((registry) => {
      const entry = registry[targetName] as RegistryWorkerEntry;
      if (entry) {
        entry.status = "active";
        // Restore window to original (move_window set it to "standby")
        if (originalWindow !== "standby") entry.window = originalWindow;
      }
    });

    return {
      content: [{
        type: "text" as const,
        text: [
          `Worker '${targetName}' → active (woken from standby).`,
          `  Registry: status=active`,
          reason ? `  Reason: ${reason}` : null,
          moveResult ? `  ${moveResult}` : null,
        ].filter(Boolean).join("\n"),
      }],
    };
  }

  // ── STANDBY: active → standby ──

  // Write handoff.md
  if (reason) {
    try {
      const handoffPath = join(WORKERS_DIR, targetName, "handoff.md");
      const timestamp = new Date().toISOString();
      writeFileSync(handoffPath, `# Standby\n\n**At:** ${timestamp}\n**Reason:** ${reason}\n\nWorker is in standby — registered but not running. Call standby_worker(name="${targetName}") again to wake.\n`);
    } catch {}
  }

  // Check for unread BMS mail (best-effort)
  let standbyPendingWarning = "";
  try {
    const targetEntry = getWorkerEntry(targetName);
    const bmsToken = (targetEntry as any)?.bms_token;
    if (bmsToken) {
      const resp = await fetch(`${BMS_URL}/api/messages?label=UNREAD&maxResults=1`, {
        headers: { Authorization: `Bearer ${bmsToken}` },
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        const data = await resp.json() as any;
        const unread = data?._diagnostics?.unread_count || 0;
        if (unread > 0) {
          standbyPendingWarning = `\n  WARNING: ${unread} unread mail in ${targetName}'s inbox`;
        }
      }
    }
  } catch {}

  // Set status = standby and move pane
  const paneId = existing.pane_id;
  let moveResult = "";

  withRegistryLocked((registry) => {
    const entry = registry[targetName] as RegistryWorkerEntry;
    if (entry) {
      entry.status = "standby";
    }
  });

  if (paneId) {
    moveResult = moveWorkerPane(paneId, tmuxSession, "standby");
  } else {
    moveResult = "No active pane to move";
  }

  return {
    content: [{
      type: "text" as const,
      text: [
        `Worker '${targetName}' → standby.`,
        `  Registry: status=standby (watchdog will ignore it)`,
        moveResult ? `  ${moveResult}` : null,
        reason ? `  Handoff: written to .claude/workers/${targetName}/handoff.md` : null,
        ``,
        standbyPendingWarning || null,
        ``,
        `To resume: call standby_worker(name="${targetName}") again, or: bash ~/.claude-ops/scripts/launch-flat-worker.sh ${targetName}`,
      ].filter(Boolean).join("\n"),
    }],
  };
}

async function handleFleetRegister(params: Record<string, any>): Promise<McpResult> {
  const { model, perpetual, sleep_duration, report_to } = params;

  try {
    const ownPane = findOwnPane();
    let paneTarget = "";
    let tmuxSession = "w";
    if (ownPane) {
      paneTarget = ownPane.paneTarget || "";
      tmuxSession = paneTarget.split(":")[0] || "w";
    }

    const registry = readRegistry();
    const config = registry._config as RegistryConfig | undefined;
    const defaultReportTo = config?.mission_authority || "chief-of-staff";

    withRegistryLocked((reg) => {
      const entry = ensureWorkerInRegistry(reg, WORKER_NAME);
      entry.status = "active";
      entry.model = model || entry.model || "opus";
      if (perpetual !== undefined) entry.perpetual = perpetual;
      if (sleep_duration !== undefined) entry.sleep_duration = sleep_duration;
      entry.report_to = report_to || entry.report_to || defaultReportTo;
      entry.custom = {
        ...(entry.custom || {}),
        runtime: entry.custom?.runtime || process.env.WORKER_RUNTIME || "claude",
      };
      if (ownPane) {
        entry.pane_id = ownPane.paneId;
        entry.pane_target = paneTarget;
        entry.tmux_session = tmuxSession;
      }
    });

    const paneInfo = ownPane ? `pane ${ownPane.paneId} (${paneTarget})` : "no pane detected";
    return {
      content: [{
        type: "text" as const,
        text: `Registered '${WORKER_NAME}' in registry.json — ${paneInfo}, model: ${model || "opus"}, report_to: ${report_to || defaultReportTo}`,
      }],
    };
  } catch (e: any) {
    return { content: [{ type: "text" as const, text: `Register failed: ${e.message}` }], isError: true };
  }
}

async function handleFleetDeregister(params: Record<string, any>): Promise<McpResult> {
  const { name, reason } = params;
  const targetName = name || WORKER_NAME;

  // Authorization: only self-deregister, OR mission_authority can deregister anyone
  const _drRegistry = readRegistry();
  const _drConfig = _drRegistry._config as RegistryConfig | undefined;
  const _drAuth = _drConfig?.mission_authority || "chief-of-staff";
  if (targetName !== WORKER_NAME && WORKER_NAME !== _drAuth) {
    return {
      content: [{
        type: "text" as const,
        text: `Only ${_drAuth} (mission_authority) can deregister other workers. Contact ${_drAuth} to deregister '${targetName}'.`,
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

  // Require HANDOFF.md before deregistration
  const handoffPath = join(WORKERS_DIR, targetName, "HANDOFF.md");
  let hasHandoff = false;
  try { hasHandoff = existsSync(handoffPath) && readFileSync(handoffPath, "utf-8").trim().length > 50; } catch {}
  if (!hasHandoff) {
    return {
      content: [{
        type: "text" as const,
        text: [
          `HANDOFF.md required before deregistering '${targetName}'.`,
          ``,
          `Before unregistering, write a HANDOFF.md at:`,
          `  .claude/workers/${targetName}/HANDOFF.md`,
          ``,
          `Include:`,
          `  - Generalizable learnings (patterns, gotchas, conventions discovered)`,
          `  - Business process details specific to this domain`,
          `  - Important repo/architecture details you learned`,
          `  - Any unfinished work or known issues`,
          `  - Recommendations for whoever picks this up next`,
          ``,
          `Then call deregister_worker() again.`,
        ].join("\n"),
      }],
      isError: true,
    };
  }

  // Append deregistration metadata to handoff
  if (reason) {
    try {
      const timestamp = new Date().toISOString();
      const appendix = `\n\n---\n## Deregistered\n\n**By:** ${WORKER_NAME}\n**At:** ${timestamp}\n**Reason:** ${reason}\n`;
      appendFileSync(handoffPath, appendix);
    } catch {
      // Best-effort
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

// spawn_feature removed — use Agent tool with isolation:"worktree" instead (zero infrastructure)

function handleFleetHelp(): McpResult {
  return {
    content: [{
      type: "text" as const,
      text: [
        `# Fleet Management Tools`,
        ``,
        `## Available Tools`,
        ``,
        `### create_worker — Create a new autonomous worker`,
        `Required: name (string), mission (string)`,
        `Optional: type, runtime, model, reasoning_effort, perpetual, sleep_duration,`,
        `  disallowed_tools (JSON string array), window, window_index, report_to,`,
        `  permission_mode, launch, tasks (JSON array), proposal_required,`,
        `  fork_from_session, direct_report`,
        ``,
        `### register_worker — Register yourself in the fleet registry`,
        `Optional: model, perpetual, sleep_duration, report_to`,
        `Auto-detects tmux pane, session, runtime. Call when lint warns you're not in registry.`,
        ``,
        `### deregister_worker — Remove a worker from the registry`,
        `Optional: name (default=self), reason`,
        `Requires HANDOFF.md (>50 chars) in worker directory. Files/worktree preserved.`,
        `Authorization: self or mission_authority.`,
        ``,
        `### move_worker — Move a worker's tmux pane to a different window`,
        `Required: window`,
        `Optional: name (default=self), reason`,
        `Moving to 'standby' sets status=standby. Moving out restores active.`,
        `Authorization: self or mission_authority.`,
        ``,
        `### standby_worker — Toggle worker between active and standby`,
        `Optional: name (default=self), reason`,
        `If active → standby (moves pane, stops watchdog). If standby → active (restores).`,
        `USER-ONLY — workers must never call this proactively.`,
        `Authorization: self or mission_authority.`,
        ``,
        `### fleet_template — Preview worker archetype defaults`,
        `Required: type (implementer|monitor|coordinator|optimizer|verifier)`,
        `Returns template mission.md, permissions, and state config.`,
        ``,
        `### fleet_help — Show this help text`,
      ].join("\n"),
    }],
  };
}

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "create_worker",
  {
    description: "Create a new worker: worktree, branch, registry entry, optional launch.",
    inputSchema: {
      name: z.string().describe("Worker name (alphanumeric + hyphens)"),
      mission: z.string().describe("Mission markdown content"),
      type: z.enum(["implementer", "monitor", "coordinator", "optimizer", "verifier"]).optional().describe("Worker archetype"),
      runtime: z.enum(["claude", "codex"]).optional().describe("Execution engine (default: claude)"),
      model: z.string().optional().describe("LLM model override"),
      reasoning_effort: z.enum(["low", "medium", "high", "extra_high"]).optional().describe("Depth of reasoning (default: high)"),
      perpetual: z.boolean().optional().describe("Run in infinite recycle loop"),
      sleep_duration: z.number().optional().describe("Seconds between perpetual cycles (default: 1800)"),
      disallowed_tools: z.string().optional().describe("JSON array of tool deny-list patterns"),
      window: z.string().optional().describe("Target tmux window name"),
      window_index: z.number().optional().describe("Explicit tmux window index for new windows"),
      report_to: z.string().optional().describe("Who this worker reports to"),
      permission_mode: z.string().optional().describe("Claude permission mode (default: bypassPermissions)"),
      launch: z.boolean().optional().describe("Launch immediately after creation"),
      tasks: z.string().optional().describe("JSON array of initial tasks"),
      proposal_required: z.boolean().optional().describe("Require HTML proposal before coding"),
      fork_from_session: z.boolean().optional().describe("Fork caller's session (requires launch=true)"),
      direct_report: z.boolean().optional().describe("Set report_to to calling worker"),
    },
  },
  // @ts-ignore — MCP SDK deep type instantiation with Zod
  async (params: Record<string, any>) => handleFleetCreate(params)
);

server.registerTool(
  "register_worker",
  {
    description: "Register yourself in the fleet registry. Auto-detects tmux pane, session, runtime.",
    inputSchema: {
      model: z.string().optional().describe("LLM model override"),
      perpetual: z.boolean().optional().describe("Run in infinite recycle loop"),
      sleep_duration: z.number().optional().describe("Seconds between perpetual cycles (default: 1800)"),
      report_to: z.string().optional().describe("Who this worker reports to"),
    },
  },
  async (params: Record<string, any>) => handleFleetRegister(params)
);

server.registerTool(
  "deregister_worker",
  {
    description: "Remove a worker from the registry. Requires HANDOFF.md (>50 chars). Files/worktree preserved.",
    inputSchema: {
      name: z.string().optional().describe("Worker name (default: self)"),
      reason: z.string().optional().describe("Reason for deregistration"),
    },
  },
  async (params: Record<string, any>) => handleFleetDeregister(params)
);

server.registerTool(
  "move_worker",
  {
    description: "Move a worker's tmux pane to a different window. Moving to 'standby' sets status=standby.",
    inputSchema: {
      window: z.string().describe("Target tmux window name"),
      name: z.string().optional().describe("Worker name (default: self)"),
      reason: z.string().optional().describe("Reason for the move"),
    },
  },
  async (params: Record<string, any>) => handleFleetMove(params)
);

server.registerTool(
  "standby_worker",
  {
    description: "Toggle worker between active and standby. If active → standby (moves pane, stops watchdog). If standby → active (restores).",
    inputSchema: {
      name: z.string().optional().describe("Worker name (default: self)"),
      reason: z.string().optional().describe("Reason for standby/wake"),
    },
  },
  async (params: Record<string, any>) => handleFleetStandby(params)
);

server.registerTool(
  "fleet_template",
  {
    description: "Preview worker archetype defaults (mission.md template, permissions, state config).",
    inputSchema: {
      type: z.enum(["implementer", "monitor", "coordinator", "optimizer", "verifier"]).describe("Worker archetype"),
    },
  },
  async (params: Record<string, any>) => handleFleetTemplate(params)
);

server.registerTool(
  "fleet_help",
  {
    description: "Show fleet management documentation and available operations.",
    inputSchema: {},
  },
  async () => handleFleetHelp()
);

// reload removed — merged into recycle(resume=true)

// ═══════════════════════════════════════════════════════════════════
// DEEP REVIEW — Multi-pass review (code diffs OR content/plans/docs)
// ═══════════════════════════════════════════════════════════════════

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "deep_review",
  {
    description:
      "Launch a multi-pass deep review pipeline. Two modes: DIFF MODE (default) reviews git diffs — code changes, commits, PRs. CONTENT MODE reviews any files — plans, docs, designs, proposals. Total workers = passes × focus areas. Diff default: 2×8=16 workers (security, logic, error-handling, data-integrity, architecture, performance, ux-impact, completeness). Content default: 2×4=8 workers (correctness, completeness, feasibility, risks). Creates DEDICATED tmux session with coordinator + worker panes. Voting within focus groups (≥2/passes). Use `content` param for plans/docs, `spec` to guide the review focus.",
    inputSchema: {
      commit: z
        .string()
        .optional()
        .describe("Specific commit SHA to review. Default: HEAD (current commit)"),
      base_branch: z
        .string()
        .optional()
        .describe("Review all changes since this branch (e.g. 'main'). Overrides commit."),
      uncommitted: z
        .boolean()
        .optional()
        .describe("Review staged + unstaged + untracked changes. Overrides commit and base_branch."),
      pr_number: z
        .string()
        .optional()
        .describe("Review a pull request by number (uses gh pr diff). Overrides other modes."),
      content: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("File path(s) to review instead of a diff. For plans, docs, or any text. Comma-separated string or array. Overrides all diff params."),
      spec: z
        .string()
        .optional()
        .describe("What to review for — guides worker focus. E.g., 'check this plan for logical gaps and missing edge cases'. Used with content mode or as additional context for diff mode."),
      passes: z
        .number()
        .optional()
        .describe("Passes PER focus area (default: 2). Total workers = passes × focus areas. E.g. passes:3 + 2 focus = 6 workers."),
      session_name: z
        .string()
        .optional()
        .describe("Custom tmux session name (overrides auto-naming from worktree+commit)"),
      notify: z
        .string()
        .optional()
        .describe("Worker name or 'user' to notify on completion. Desktop notification always fires."),
      focus: z
        .array(z.string())
        .optional()
        .describe("Custom focus areas. Each focus gets `passes` independent workers. Diff default: 8 areas. Content default: 4 areas (correctness, completeness, feasibility, risks). Override with e.g. ['security', 'auth', 'scope-bypass']."),
    },
  },
  async ({
    commit,
    base_branch,
    uncommitted,
    pr_number,
    content,
    spec,
    passes,
    session_name,
    notify,
    focus,
  }: {
    commit?: string;
    base_branch?: string;
    uncommitted?: boolean;
    pr_number?: string;
    content?: string | string[];
    spec?: string;
    passes?: number;
    session_name?: string;
    notify?: string;
    focus?: string[];
  }) => {
    try {
      const scriptPath = join(CLAUDE_OPS, "scripts", "deep-review.sh");
      if (!existsSync(scriptPath)) {
        throw new Error(`deep-review.sh not found at ${scriptPath}`);
      }

      // Build args — content mode takes priority over diff modes
      const args: string[] = [];
      if (content) {
        const contentPaths = Array.isArray(content) ? content.join(",") : content;
        args.push("--content", contentPaths);
      } else if (pr_number) {
        args.push("--pr", pr_number);
      } else if (uncommitted) {
        args.push("--uncommitted");
      } else if (base_branch) {
        args.push("--base", base_branch);
      } else if (commit) {
        args.push("--commit", commit);
      } else {
        const headSha = execSync("git rev-parse HEAD", {
          encoding: "utf-8",
          cwd: PROJECT_ROOT,
        }).trim();
        args.push("--commit", headSha);
      }

      if (spec) {
        args.push("--spec", spec);
      }
      if (passes) {
        args.push("--passes", String(passes));
      }
      if (session_name) {
        args.push("--session-name", session_name);
      }
      if (notify) {
        args.push("--notify", notify);
      }
      if (focus?.length) {
        args.push("--focus", focus.join(","));
      }

      const launchResult = spawnSync("bash", [scriptPath, ...args], {
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        env: { ...process.env, PROJECT_ROOT },
        timeout: 60_000,
      });

      if (launchResult.status !== 0) {
        const stderr = launchResult.stderr?.slice(0, 1000) || "";
        throw new Error(`deep-review.sh failed (exit ${launchResult.status}): ${stderr}`);
      }

      const stdout = launchResult.stdout || "";
      // Parse session name and dir from output
      const tmuxSessionMatch = stdout.match(/Session:\s+(\S+)/);
      const sessionDir = tmuxSessionMatch ? tmuxSessionMatch[1] : "unknown";
      const reviewSessionMatch = stdout.match(/tmux switch-client -t (\S+)/);
      const reviewSession = reviewSessionMatch ? reviewSessionMatch[1] : session_name || "dr-unknown";
      const passesPerFocus = passes || 2;
      const isContentMode = !!content;
      const numFocus = focus?.length || (isContentMode ? 4 : 8);
      const totalWorkers = passesPerFocus * numFocus;
      const numWorkerWindows = Math.ceil(totalWorkers / 4);

      const windowLines: string[] = [];
      windowLines.push(`  Window 0: coordinator (1 pane, ${process.env.DEEP_REVIEW_COORD_MODEL || "sonnet"})`);
      for (let w = 1; w <= numWorkerWindows; w++) {
        const first = (w - 1) * 4 + 1;
        const last = Math.min(w * 4, totalWorkers);
        const count = last - first + 1;
        windowLines.push(`  Window ${w}: workers-${w} (${count} panes tiled, ${process.env.DEEP_REVIEW_WORKER_MODEL || "opus"})`);
      }

      return {
        content: [{
          type: "text" as const,
          text: [
            `Deep review pipeline launched.`,
            ``,
            `tmux session: ${reviewSession}`,
            ...windowLines,
            ``,
            `Session dir: ${sessionDir}`,
            `Workers: ${totalWorkers} (${numFocus} focus × ${passesPerFocus} passes)`,
            `Focus: ${focus?.length ? focus.join(", ") : "security, logic, error-handling, data-integrity, architecture, performance, ux-impact, completeness"}`,
            `Completion: sentinel files at ${sessionDir}/pass-{1..${totalWorkers}}.done`,
            notify ? `Notify: ${notify} (on completion)` : `Notify: desktop only`,
            ``,
            `Attach: tmux switch-client -t ${reviewSession}`,
            `        tmux a -t ${reviewSession}`,
            ``,
            `Pipeline: ${totalWorkers} workers -> bucket -> majority vote (>=2/${passesPerFocus} per focus group) -> validate -> dedup -> autofix -> report + notify`,
            `Report: ${sessionDir}/report.md`,
          ].join("\n"),
        }],
      };
    } catch (e: any) {
      const msg = `Deep review launch failed: ${e.message?.slice(0, 500) || String(e)}`;
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// BORING MAIL SERVER — Gmail-conformant inter-agent email
// ═══════════════════════════════════════════════════════════════════
// HTTP proxy to boring-mail-server (Rust + Dolt, runs on kevinster via SSH tunnel).
// Each worker auto-provisions an account on first use. Tokens cached in /tmp/bms-dogfood/tokens.json.

const BMS_URL = process.env.BMS_URL || "http://127.0.0.1:8025";

/** Cached BMS unread count — refreshed by mail_inbox calls and background poll */
let _bmsUnreadCount = 0;
let _bmsUnreadLastCheck = 0;

/** Refresh BMS unread count (fire-and-forget, non-blocking) */
function refreshBmsUnread(): void {
  const now = Date.now();
  if (now - _bmsUnreadLastCheck < 30_000) return; // throttle to 30s
  _bmsUnreadLastCheck = now;

  const entry = getWorkerEntry(WORKER_NAME);
  const bmsToken = (entry as any)?.bms_token;
  if (!bmsToken) return;

  fetch(`${BMS_URL}/api/messages?label=UNREAD&maxResults=1`, {
    headers: { Authorization: `Bearer ${bmsToken}` },
    signal: AbortSignal.timeout(3000),
  }).then(r => r.ok ? r.json() : null).then((data: any) => {
    if (data) _bmsUnreadCount = data?._diagnostics?.unread_count || data?.messages?.length || 0;
  }).catch(() => {});
}

/** Get or auto-provision a BMS bearer token for the current worker.
 *  Tokens are stored in registry.json under each worker's `bms_token` field. */
async function getBmsToken(): Promise<string> {
  // Check registry first
  const registry = readRegistry();
  const entry = registry[WORKER_NAME] as RegistryWorkerEntry | undefined;
  if (entry?.bms_token) return entry.bms_token;

  // Auto-register with the mail server
  const resp = await fetch(`${BMS_URL}/api/accounts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: WORKER_NAME, bio: `Fleet worker: ${WORKER_NAME}` }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    // 409 = already registered but we lost the token
    if (resp.status === 409) {
      throw new Error(`BMS account '${WORKER_NAME}' exists but token is not in registry. Ask operator to add bms_token to registry.json.`);
    }
    throw new Error(`BMS register failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as any;
  const token = data.bearerToken as string;

  // Persist to registry — do NOT silently swallow errors here.
  // If this fails, the token works for this session but is lost on restart,
  // leading to an unrecoverable 409 on next getBmsToken() call.
  try {
    withRegistryLocked((reg) => {
      if (!reg[WORKER_NAME]) ensureWorkerInRegistry(reg, WORKER_NAME);
      (reg[WORKER_NAME] as any).bms_token = token;
    });
  } catch (e) {
    console.error(`[getBmsToken] WARN: Failed to persist bms_token for ${WORKER_NAME} to registry.json: ${e}`);
    console.error(`[getBmsToken] Token works for this session but will be lost on restart — 409 on next call.`);
  }

  return token;
}

/** HTTP helper for BMS API calls */
async function bmsRequest(method: string, path: string, body?: any): Promise<any> {
  const token = await getBmsToken();
  const url = `${BMS_URL}${path}`;
  const opts: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  const resp = await fetch(url, opts);
  const text = await resp.text();

  if (!resp.ok) {
    throw new Error(`BMS ${method} ${path} failed (${resp.status}): ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function bmsTextResult(data: any): { content: { type: "text"; text: string }[] } {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

/** Cache: name → account UUID. Populated lazily from /api/directory. */
let _bmsDirectoryCache: Record<string, string> | null = null;
let _bmsDirectoryCacheTime = 0;
const BMS_DIR_CACHE_TTL = 60_000; // 1 minute

async function resolveBmsAccountId(name: string): Promise<string> {
  // If it looks like a UUID already, pass through
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(name)) return name;
  // If it's a list: prefix, pass through
  if (name.startsWith("list:")) return name;

  const now = Date.now();
  if (!_bmsDirectoryCache || now - _bmsDirectoryCacheTime > BMS_DIR_CACHE_TTL) {
    const token = await getBmsToken();
    const resp = await fetch(`${BMS_URL}/api/directory`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json() as any;
      _bmsDirectoryCache = {};
      for (const acct of data.directory || []) {
        _bmsDirectoryCache[acct.name] = acct.id;
      }
      _bmsDirectoryCacheTime = now;
    }
  }

  const id = _bmsDirectoryCache?.[name];
  if (id) return id;

  // Auto-provision "user" account if it doesn't exist
  if (name === "user") {
    try {
      const provResp = await fetch(`${BMS_URL}/api/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "user", display_name: "operator", bio: "Human operator" }),
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
        if (!_bmsDirectoryCache) _bmsDirectoryCache = {};
        _bmsDirectoryCache["user"] = acct.id;
        return acct.id;
      }
      // 409 = already exists but not in cache — refresh
      if (provResp.status === 409) {
        _bmsDirectoryCache = null;
        _bmsDirectoryCacheTime = 0;
        return resolveBmsAccountId(name);
      }
    } catch {}
  }

  throw new Error(`BMS account '${name}' not found in directory`);
}

async function resolveBmsRecipients(names: string[]): Promise<string[]> {
  return Promise.all(names.map(resolveBmsAccountId));
}

// ── mail_send — unified messaging (BMS durable + tmux instant) ──────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_send",
  {
    description: `Send a message to another worker, the human operator, or the entire fleet. Messages are durably stored in boring-mail-server (persist across restarts, searchable, threaded) and delivered instantly via tmux overlay if the recipient's pane is live.

Routing:
- Worker name (e.g. "merger"): direct message via BMS email + tmux push.
- "report": message whoever you report_to (resolved from registry).
- "direct_reports": fan-out to all workers who report_to you.
- "all": broadcast to every registered worker (expensive — use sparingly).
- "user": escalate to the human operator (triage queue + desktop notification, NOT via BMS).
- Raw pane ID (e.g. "%42"): tmux-only delivery, no durable storage.

Escalate to user when: (1) design/architecture decisions need human judgment, (2) security or auth changes arise, (3) business logic changes affect end users, (4) new product surface area, (5) removing functionality, (6) external coordination needed, (7) blocked and need product direction. When in doubt, escalate.`,
    inputSchema: {
      to: z.string().describe('Recipient: worker name, "report", "direct_reports", "all", "user", or raw pane ID "%NN"'),
      subject: z.string().describe("Email subject line (5-15 words)"),
      body: z.string().describe("Message body"),
      cc: z.array(z.string()).optional().describe("CC recipients (worker names)"),
      thread_id: z.string().optional().describe("Thread ID to reply in (continues a conversation)"),
      in_reply_to: z.string().optional().describe("Message ID being replied to (marks it acknowledged)"),
      reply_by: z.string().optional().describe("ISO timestamp deadline for reply"),
      labels: z.array(z.string()).optional().describe("Additional labels (e.g. URGENT, MERGE-REQUEST)"),
    },
  },
  async ({ to, subject, body, cc, thread_id, in_reply_to, reply_by, labels }: {
    to: string; subject: string; body: string; cc?: string[]; thread_id?: string;
    in_reply_to?: string; reply_by?: string; labels?: string[];
  }) => {
    // User escalation path: send via BMS to "user" account + desktop notification
    if (to === "user") {
      let msgId = "";
      try {
        const toIds = await resolveBmsRecipients(["user"]);
        const ccIds = cc ? await resolveBmsRecipients(cc) : [];
        const result = await bmsRequest("POST", "/api/messages/send", {
          to: toIds, subject, body,
          cc: ccIds, thread_id: thread_id || null, in_reply_to: in_reply_to || null,
          reply_by: reply_by || null, labels: [...(labels || []), "ESCALATION"], attachments: [],
        });
        msgId = result?.id || "";
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error sending to user via BMS: ${e.message}` }], isError: true };
      }
      // Desktop notification (best-effort)
      try {
        execSync(
          `terminal-notifier -title "Worker Escalation" -message ${JSON.stringify(`[${WORKER_NAME}] ${subject}`)} -sound default 2>/dev/null || osascript -e 'display notification ${JSON.stringify(`[${WORKER_NAME}] ${subject}`)} with title "Worker Escalation" sound name "default"'`,
          { timeout: 5000, shell: "/bin/bash" }
        );
      } catch {}
      return withLint({ content: [{ type: "text" as const, text: `Sent to user via BMS [${msgId}] + desktop notification` }] });
    }

    // Raw pane ID — tmux-only, no BMS
    if (to.startsWith("%")) {
      if (!isPaneAlive(to)) {
        return { content: [{ type: "text" as const, text: `Error: Pane ${to} is dead` }], isError: true };
      }
      try {
        tmuxSendMessage(to, `[msg from ${WORKER_NAME}] ${body}`);
        return { content: [{ type: "text" as const, text: `Sent to pane ${to} (tmux-only, no BMS)` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
      }
    }

    // Resolve fleet routing → list of worker names
    let recipientNames: string[] = [];
    if (to === "all") {
      try {
        recipientNames = readdirSync(WORKERS_DIR, { withFileTypes: true })
          .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
          .map(d => d.name)
          .filter(name => name !== WORKER_NAME);
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error listing workers: ${e.message}` }], isError: true };
      }
    } else if (to === "report" || to === "direct_reports") {
      const resolved = resolveRecipient(to);
      if (resolved.error) {
        return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }], isError: true };
      }
      if (resolved.type === "multi_worker") {
        recipientNames = resolved.workerNames || [];
      } else if (resolved.workerName) {
        recipientNames = [resolved.workerName];
      }
    } else {
      recipientNames = [to];
    }

    if (recipientNames.length === 0) {
      return { content: [{ type: "text" as const, text: "No recipients resolved" }], isError: true };
    }

    // Send via BMS (durable delivery)
    const bmsSuccesses: string[] = [];
    const bmsFailures: string[] = [];
    const tmuxDelivered: string[] = [];
    let lastMsgId = "";

    for (const name of recipientNames) {
      try {
        const toIds = await resolveBmsRecipients([name]);
        const ccIds = cc ? await resolveBmsRecipients(cc) : [];
        const result = await bmsRequest("POST", "/api/messages/send", {
          to: toIds, subject, body,
          cc: ccIds, thread_id: thread_id || null, in_reply_to: in_reply_to || null,
          reply_by: reply_by || null, labels: labels || [], attachments: [],
        });
        lastMsgId = result?.id || "";
        bmsSuccesses.push(name);
      } catch (e: any) {
        bmsFailures.push(`${name}: ${e.message?.slice(0, 80)}`);
      }
    }

    // Tmux instant delivery (best-effort overlay)
    const registry = (() => { try { return readRegistry(); } catch { return {} as any; } })();
    for (const name of bmsSuccesses) {
      try {
        const entry = registry[name] as RegistryWorkerEntry | undefined;
        const paneId = entry?.pane_id;
        if (paneId && isPaneAlive(paneId)) {
          const prefix = recipientNames.length > 1 ? `[broadcast from ${WORKER_NAME}]` : `[mail from ${WORKER_NAME}]`;
          tmuxSendMessage(paneId, `${prefix} ${subject}: ${body}`);
          tmuxDelivered.push(name);
        }
      } catch {}
    }

    // Build result
    if (bmsSuccesses.length === 0) {
      return { content: [{ type: "text" as const, text: `Failed to send to all recipients:\n${bmsFailures.join("\n")}` }], isError: true };
    }

    const parts: string[] = [];
    if (recipientNames.length === 1) {
      let paneWarning = "";
      const entry = registry[recipientNames[0]] as RegistryWorkerEntry | undefined;
      if (entry && (!entry.pane_id || !isPaneAlive(entry.pane_id))) {
        paneWarning = ` (WARNING: no active pane — queued in BMS inbox)`;
      }
      parts.push(`Sent to ${recipientNames[0]} [${lastMsgId}]${paneWarning}`);
    } else {
      parts.push(`Sent to ${bmsSuccesses.length}/${recipientNames.length} workers`);
      if (tmuxDelivered.length > 0) parts.push(`Tmux overlay: ${tmuxDelivered.join(", ")}`);
      if (bmsFailures.length > 0) parts.push(`Failed: ${bmsFailures.join(", ")}`);
    }

    return withLint({ content: [{ type: "text" as const, text: parts.join("\n") }] });
  }
);

// ── mail_inbox — read from BMS ──────────────────────────────────────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_inbox",
  {
    description: "Read messages from your BMS inbox. Call at the start of every cycle — messages may contain instructions, merge notifications, or approval requests that should be acted on before starting new work. Returns messages with sender, subject, labels, and timestamps. Use label='UNREAD' for unread-only.",
    inputSchema: {
      label: z.string().optional().describe("Label filter (default: UNREAD). Common: INBOX, UNREAD, SENT, STARRED, TRASH"),
      maxResults: z.number().optional().describe("Max messages to return (default: 20)"),
      pageToken: z.string().optional().describe("Pagination token from previous response"),
    },
  },
  async ({ label, maxResults, pageToken }: { label?: string; maxResults?: number; pageToken?: string }) => {
    try {
      let path = `/api/messages?label=${label || "UNREAD"}&maxResults=${maxResults || 20}`;
      if (pageToken) path += `&pageToken=${encodeURIComponent(pageToken)}`;
      const result = await bmsRequest("GET", path);
      return withLint(bmsTextResult(result));
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

// ── mail_read — get full message by ID ──────────────────────────────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_read",
  {
    description: "Get full email details by ID. Auto-removes UNREAD label.",
    inputSchema: {
      id: z.string().describe("Message ID"),
    },
  },
  async ({ id }: { id: string }) => {
    try {
      const result = await bmsRequest("GET", `/api/messages/${encodeURIComponent(id)}`);
      return bmsTextResult(result);
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: e.message }], isError: true };
    }
  }
);

// mail_search + mail_thread — REMOVED (documented in mail_help with curl examples)

// ── Management reference (1) — on-demand CLI docs ───────────────────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_help",
  {
    description: "Get BMS CLI docs for search, threads, labels, trash, directory, mailing lists, and raw curl. Call this for any mail operation beyond send/inbox/read.",
    inputSchema: {},
  },
  async () => {
    const token = await getBmsToken().catch(() => "<your-bms-token>");
    return bmsTextResult(`# Boring Mail Server — Management CLI

Server: ${BMS_URL}
Your account: ${WORKER_NAME}
Your token: ${token}

## Search (replaces mail_search tool)

  # Gmail-style query syntax: from:, to:, subject:, has:attachment, label:, date ranges
  curl -sf "${BMS_URL}/api/search?q=from:merger&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Threads (replaces mail_thread tool)

  # Get full conversation thread
  curl -sf "${BMS_URL}/api/threads/<thread-id>" \\
    -H "Authorization: Bearer $TOKEN"

  # List threads by label
  curl -sf "${BMS_URL}/api/threads?label=INBOX&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Token Management

  # Reset your bearer token (invalidates old one, returns new)
  curl -sf -X POST "${BMS_URL}/api/accounts/me/reset-token" \\
    -H "Authorization: Bearer $TOKEN"
  # Response: {"bearerToken":"<new-uuid>","id":"...","name":"..."}
  # After reset, update registry.json: bms_token field for your worker

## Label Operations

  # List labels with counts
  curl -sf "${BMS_URL}/api/labels" -H "Authorization: Bearer $TOKEN"

  # Add/remove labels on a message
  curl -sf -X POST "${BMS_URL}/api/messages/<msg-id>/modify" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"addLabelIds":["STARRED"],"removeLabelIds":["UNREAD"]}'

  # Create custom label
  curl -sf -X POST "${BMS_URL}/api/labels" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"name":"MY-LABEL"}'

  # Delete custom label
  curl -sf -X DELETE "${BMS_URL}/api/labels/MY-LABEL" \\
    -H "Authorization: Bearer $TOKEN"

## Message Management

  # Trash a message
  curl -sf -X POST "${BMS_URL}/api/messages/<msg-id>/trash" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

  # Permanently delete
  curl -sf -X DELETE "${BMS_URL}/api/messages/<msg-id>" \\
    -H "Authorization: Bearer $TOKEN"

  # Batch modify labels
  curl -sf -X POST "${BMS_URL}/api/messages/batchModify" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"ids":["id1","id2"],"addLabelIds":["STARRED"],"removeLabelIds":[]}'

## Threads

  # List threads by label
  curl -sf "${BMS_URL}/api/threads?label=INBOX&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Directory & Profile

  # List all accounts
  curl -sf "${BMS_URL}/api/directory" -H "Authorization: Bearer $TOKEN"

  # Search accounts
  curl -sf "${BMS_URL}/api/directory?q=merger" -H "Authorization: Bearer $TOKEN"

  # View own profile
  curl -sf "${BMS_URL}/api/accounts/me" -H "Authorization: Bearer $TOKEN"

  # Update bio
  curl -sf -X PUT "${BMS_URL}/api/accounts/me" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"bio":"I handle code reviews"}'

## Mailing Lists

  # Create list
  curl -sf -X POST "${BMS_URL}/api/lists" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"name":"team-all","description":"All team members"}'

  # Subscribe (self)
  curl -sf -X POST "${BMS_URL}/api/lists/<list-id>/subscribe" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

  # Send to list (use list:name in to field)
  # mail_send(to=["list:team-all"], subject="...", body="...")

## Blob Attachments

  # Upload blob
  curl -sf -X POST "${BMS_URL}/api/blobs" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \\
    --data-binary @file.txt

  # Download blob
  curl -sf "${BMS_URL}/api/blobs/<sha256-hash>" -H "Authorization: Bearer $TOKEN" -o file.txt

## Health & Analytics

  curl -sf "${BMS_URL}/health"
  curl -sf "${BMS_URL}/api/analytics" -H "Authorization: Bearer $TOKEN"
`);
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
  writeToTriageQueue, buildMessageBody,
  resolveRecipient, isPaneAlive, readJsonFile, acquireLock, releaseLock,
  findOwnPane, getSessionId, getWorkerModel, getWorktreeDir, generateSeedContent,
  runDiagnostics, createWorkerFiles, _setWorkersDir,
  readRegistry, getWorkerEntry, withRegistryLocked, ensureWorkerInRegistry,
  lintRegistry, _replaceMemorySection, getReportTo, canUpdateWorker,
  WORKER_NAME, WORKERS_DIR, HARNESS_LOCK_DIR, REGISTRY_PATH,
  type Task, type DiagnosticIssue,
  type RegistryConfig, type RegistryWorkerEntry, type ProjectRegistry,
  type WorkerRuntime, type ReasoningEffort, type RuntimeConfig,
  getWorkerRuntime, RUNTIMES,
};
