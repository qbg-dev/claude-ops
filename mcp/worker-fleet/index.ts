#!/usr/bin/env bun
/**
 * worker-fleet MCP server — Tools for worker fleet coordination.
 *
 * 18 tools in 8 categories:
 *   Messaging (3):  send_message, broadcast, read_inbox
 *   Tasks (4):      create_task, claim_task, complete_task, list_tasks
 *   State (2):      get_worker_state, update_state
 *   Fleet (1):      fleet_status
 *   Deploy (2):     deploy, health_check
 *   Lifecycle (4):  recycle, spawn_child, register_pane, check_config
 *   Git (1):        smart_commit
 *   External (1):   post_to_nexus
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
  readdirSync, openSync, fstatSync, readSync, closeSync, truncateSync,
} from "fs";
import { join } from "path";
import { execSync, spawnSync } from "child_process";

// ── Configuration ────────────────────────────────────────────────────
const HOME = process.env.HOME!;
const PROJECT_ROOT = process.env.PROJECT_ROOT || "/Users/wz/Desktop/zPersonalProjects/Wechat";
const CLAUDE_OPS = process.env.CLAUDE_OPS_DIR || join(HOME, ".claude-ops");
let WORKERS_DIR = join(PROJECT_ROOT, ".claude/workers");

/** For testing — override the workers directory */
function _setWorkersDir(dir: string) { WORKERS_DIR = dir; }
const BORING_DIR = process.env.BORING_DIR || join(HOME, ".boring");
const HARNESS_LOCK_DIR = join(BORING_DIR, "state/locks");
const PANE_REGISTRY_PATH = join(BORING_DIR, "state/pane-registry.json");

// Script paths (only for tools that still shell out)
const WORKER_MESSAGE_SH = join(CLAUDE_OPS, "scripts/worker-message.sh");
const WORKER_COMMIT_SH = join(PROJECT_ROOT, ".claude/scripts/worker-commit.sh");
const CHECK_WORKERS_SH = join(CLAUDE_OPS, "scripts/check-flat-workers.sh");
const REQUEST_MERGE_SH = join(PROJECT_ROOT, ".claude/scripts/request-merge.sh");

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

/** mkdir-based spinlock matching harness-jq.sh convention */
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
  const path = getTasksPath(worker);
  try {
    const data = JSON.parse(readFileSync(path, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

function writeTasks(worker: string, tasks: Record<string, Task>): void {
  const lockPath = join(HARNESS_LOCK_DIR, `worker-tasks-${worker}`);
  acquireLock(lockPath);
  try {
    const path = getTasksPath(worker);
    // Ensure worker directory exists
    const dir = join(WORKERS_DIR, worker);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(tasks, null, 2) + "\n");
  } finally {
    releaseLock(lockPath);
  }
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

    if (opts.limit && opts.limit > 0) {
      entries = entries.slice(-opts.limit);
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

/** Resolve recipient — worker name, "parent", or raw pane ID */
function resolveRecipient(to: string): {
  type: "worker" | "pane";
  workerName?: string;
  paneId?: string;
  error?: string;
} {
  // Raw pane ID
  if (to.startsWith("%")) {
    return { type: "pane", paneId: to };
  }

  // "parent" — look up in pane registry
  if (to === "parent") {
    try {
      const registry = readJsonFile(PANE_REGISTRY_PATH);
      if (!registry) return { type: "worker", error: "Pane registry not found" };

      // Find our pane by matching harness to WORKER_NAME
      for (const [paneId, entry] of Object.entries(registry) as [string, any][]) {
        if (entry.harness === `worker/${WORKER_NAME}` && entry.parent_pane) {
          const parentEntry = registry[entry.parent_pane];
          if (parentEntry?.harness) {
            const parentName = parentEntry.harness.replace(/^worker\//, "");
            return { type: "worker", workerName: parentName };
          }
        }
      }
      return { type: "worker", error: `No parent found for worker '${WORKER_NAME}'` };
    } catch {
      return { type: "worker", error: "Failed to read pane registry" };
    }
  }

  // Worker name
  return { type: "worker", workerName: to };
}

// ── Pane & Session Helpers ───────────────────────────────────────────

/** Find this worker's pane. Prefers TMUX_PANE env (exact), falls back to registry search. */
function findOwnPane(): { paneId: string; paneTarget: string } | null {
  // Best: TMUX_PANE env var — exact pane ID
  const tmuxPane = process.env.TMUX_PANE;
  if (tmuxPane) {
    // Try registry for pane_target
    const registry = readJsonFile(PANE_REGISTRY_PATH);
    if (registry?.[tmuxPane]?.pane_target) {
      return { paneId: tmuxPane, paneTarget: registry[tmuxPane].pane_target };
    }
    // Not in registry — resolve pane_target from tmux directly
    try {
      const target = execSync(
        `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${tmuxPane}" '$1 == id {print $2}'`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      if (target) return { paneId: tmuxPane, paneTarget: target };
    } catch {}
    // Last resort — just return the pane ID without target
    return { paneId: tmuxPane, paneTarget: "" };
  }

  // Fallback: search registry by worker name (excludes children)
  const registry = readJsonFile(PANE_REGISTRY_PATH);
  if (!registry) return null;

  for (const [paneId, entry] of Object.entries(registry) as [string, any][]) {
    if (entry.harness === `worker/${WORKER_NAME}` &&
        entry.task !== "child" &&
        entry.project_root === PROJECT_ROOT) {
      return { paneId, paneTarget: entry.pane_target || "" };
    }
  }
  return null;
}

/** Read Claude session ID from the pane-map (written by statusline-command.sh) */
function getSessionId(paneId: string): string | null {
  const paneMapPath = join(HOME, ".claude/pane-map/by-pane", paneId);
  try { return readFileSync(paneMapPath, "utf-8").trim(); } catch { return null; }
}

/** Read worker's model from permissions.json */
function getWorkerModel(): string {
  try {
    const perms = readJsonFile(join(WORKERS_DIR, WORKER_NAME, "permissions.json"));
    return perms?.model || "sonnet";
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
2. ${workerDir}/state.json — current cycle count and status
3. ${workerDir}/MEMORY.md — what you learned in previous cycles

Then begin your cycle immediately.

## Cycle Pattern

Every cycle follows this sequence:

1. **Drain inbox** — \`read_inbox(clear=true)\` — act on messages before anything else
2. **Check tasks** — \`list_tasks(filter="pending")\` — find highest-priority unblocked work
3. **Claim** — \`claim_task("T00N")\` — mark what you're working on
4. **Do the work** — investigate, fix, test, commit, deploy, verify
5. **Complete** — \`complete_task("T00N")\` — only after fully verified
6. **Update state** — \`update_state("cycles_completed", N+1)\` then \`update_state("last_cycle_at", ISO)\`
7. **Perpetual?** — if \`perpetual: true\`, sleep for \`sleep_duration\` seconds, then loop

If your inbox has a message from Warren or chief-of-staff, prioritize it over your current task list.

## MCP Tools (\`mcp__worker-fleet__*\`)

| Tool | What it does |
|------|-------------|
| \`send_message(to, content, summary)\` | Send to a worker, "parent", or raw pane ID "%NN" |
| \`broadcast(content, summary)\` | Send to ALL workers (use sparingly) |
| \`read_inbox(limit?, since?, clear?)\` | Read your inbox; \`clear=true\` truncates after reading |
| \`create_task(subject, priority?, ...)\` | Add a task to your task list |
| \`claim_task(task_id)\` | Assign a task to yourself, set in_progress |
| \`complete_task(task_id)\` | Mark done (recurring tasks auto-reset) |
| \`list_tasks(filter?, worker?)\` | List tasks; \`worker="all"\` for cross-worker view |
| \`get_worker_state(name?)\` | Read any worker's state.json |
| \`update_state(key, value)\` | Update your state.json + emit bus event |
| \`fleet_status()\` | Full fleet overview (all workers) |
| \`deploy(service?)\` | Deploy to TEST server + auto health check |
| \`health_check(target?)\` | Check server health: \`test\`, \`prod\`, or \`both\` |
| \`smart_commit(message, files?, ...)\` | Commit with format validation; \`merge_request=true\` to signal chief-of-staff |
| \`post_to_nexus(message, room?)\` | Post to Nexus chat (prefixed with your name) |
| \`recycle(message?)\` | Self-recycle: write handoff, restart fresh with new context |
| \`spawn_child(task?)\` | Fork yourself into a new pane to the right |
| \`register_pane()\` | Register this pane in pane-registry (after recycle/manual launch) |
| \`check_config()\` | Run diagnostics on worker config — fix issues it reports |

These are native MCP tool calls — no bash wrappers needed.

## Rules
- **Fix everything.** Never just report issues — investigate, fix, deploy, document in MEMORY.md.
- **Git discipline**: Stage only specific files (\`git add src/foo.ts\`). NEVER \`git add -A\`. Commit to branch **${branch}** only. Never checkout main.
- **Deploy**: TEST only. \`smart_commit\` then \`deploy(service="static")\`. The deploy tool auto-checks health. Never \`core\` without Warren approval.
- **Verify before completing**: Tests pass + TypeScript clean + deploy succeeds + endpoint/UI verified.
- **Perpetual workers**: Read ${PROJECT_ROOT}/.claude/workers/PERPETUAL-PROTOCOL.md on your first cycle for self-optimization guidance.`;

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
  if (!process.env.TMUX_PANE) {
    issues.push({ severity: "warning", check: "env.TMUX_PANE", message: "TMUX_PANE not set — recycle/spawn_child/register_pane won't work", fix: "Launch via launch-flat-worker.sh or set TMUX_PANE manually" });
  }

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

    // state.json
    const statePath = join(workerDir, "state.json");
    if (!existsSync(statePath)) {
      issues.push({ severity: "error", check: "state.json", message: "state.json missing", fix: `echo '{"status":"idle","cycles_completed":0}' > ${statePath}` });
    } else {
      const state = readJsonFile(statePath);
      if (!state) {
        issues.push({ severity: "error", check: "state.json", message: "state.json is invalid JSON", fix: `Fix JSON syntax in ${statePath}` });
      } else {
        if (typeof state.cycles_completed !== "number") {
          issues.push({ severity: "warning", check: "state.cycles_completed", message: "state.json missing 'cycles_completed' field", fix: `update_state("cycles_completed", 0)` });
        }
        if (!state.status) {
          issues.push({ severity: "warning", check: "state.status", message: "state.json missing 'status' field", fix: `update_state("status", "idle")` });
        }
      }
    }

    // permissions.json
    const permsPath = join(workerDir, "permissions.json");
    if (!existsSync(permsPath)) {
      issues.push({ severity: "warning", check: "permissions.json", message: "permissions.json missing — using default model (sonnet)", fix: `echo '{"model":"sonnet"}' > ${permsPath}` });
    } else {
      const perms = readJsonFile(permsPath);
      if (!perms) {
        issues.push({ severity: "error", check: "permissions.json", message: "permissions.json is invalid JSON", fix: `Fix JSON syntax in ${permsPath}` });
      } else if (!perms.model) {
        issues.push({ severity: "warning", check: "permissions.model", message: "permissions.json missing 'model' field — defaulting to sonnet", fix: "Add \"model\": \"sonnet\" to permissions.json" });
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

  // ── Pane registry ──
  if (process.env.TMUX_PANE) {
    const registry = readJsonFile(PANE_REGISTRY_PATH);
    if (!registry?.[process.env.TMUX_PANE]) {
      issues.push({ severity: "warning", check: "pane_registry", message: `Pane ${process.env.TMUX_PANE} not in pane-registry — spawn_child/recycle may fail`, fix: "Call register_pane() to fix" });
    }
  }

  // ── Required scripts ──
  const requiredScripts: [string, string][] = [
    [WORKER_COMMIT_SH, "smart_commit"],
    [CHECK_WORKERS_SH, "fleet_status"],
  ];
  for (const [scriptPath, toolName] of requiredScripts) {
    if (!existsSync(scriptPath)) {
      issues.push({ severity: "warning", check: `script.${toolName}`, message: `Script missing for ${toolName}: ${scriptPath}`, fix: `Ensure file exists at ${scriptPath}` });
    }
  }

  return issues;
}

// ── Cached diagnostics — 3 min TTL, lazy on first tool call ─────────
let _diagCache: { issues: DiagnosticIssue[]; ts: number } | null = null;
const DIAG_CACHE_TTL_MS = 3 * 60_000; // 3 minutes
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

server.tool(
  "send_message",
  `Send a direct message to a specific worker (durable inbox + tmux instant delivery)`,
  {
    to: z.string().describe("Worker name (e.g. 'chief-of-staff', 'chatbot-tools')"),
    content: z.string().describe("Message content"),
    summary: z.string().describe("Short preview (5-10 words)"),
  },
  async ({ to, content, summary }) => {
    const resolved = resolveRecipient(to);

    if (resolved.error) {
      return { content: [{ type: "text" as const, text: `Error: ${resolved.error}` }], isError: true };
    }

    // Raw pane ID — tmux-only delivery (no inbox)
    if (resolved.type === "pane") {
      try {
        execSync(
          `tmux send-keys -t "${resolved.paneId}" ${JSON.stringify(`\n[msg from ${WORKER_NAME}] ${content}\n`)} ""`,
          { timeout: 5000 }
        );
        return { content: [{ type: "text" as const, text: `Sent to pane ${resolved.paneId} (tmux-only, no inbox)` }] };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error sending to pane: ${e.message}` }], isError: true };
      }
    }

    // Worker name — durable inbox + best-effort bus
    const recipientName = resolved.workerName!;

    // Step 1: Write to inbox (critical — must succeed)
    const inboxResult = writeToInbox(recipientName, { content, summary, from_name: WORKER_NAME });
    if (!inboxResult.ok) {
      return { content: [{ type: "text" as const, text: `Error: ${inboxResult.error}` }], isError: true };
    }

    // Step 2: Fire bus for tmux instant delivery (best-effort)
    try {
      const args = ["send", recipientName, content];
      if (summary) args.push("--summary", summary);
      runScript(WORKER_MESSAGE_SH, args, { timeout: 10_000 });
    } catch {
      // Bus failed — inbox already delivered, that's fine
    }

    return { content: [{ type: "text" as const, text: `Message sent to ${recipientName}` }] };
  }
);

server.tool(
  "broadcast",
  "Send a message to all workers (use sparingly — costs scale with team size)",
  {
    content: z.string().describe("Message content"),
    summary: z.string().describe("Short preview (5-10 words)"),
  },
  async ({ content, summary }) => {
    // Write to every worker's inbox (durable)
    const failures: string[] = [];
    const successes: string[] = [];

    try {
      const dirs = readdirSync(WORKERS_DIR, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
        .map(d => d.name)
        .filter(name => name !== WORKER_NAME); // Don't broadcast to self

      for (const name of dirs) {
        const result = writeToInbox(name, { content, summary, from_name: WORKER_NAME });
        if (result.ok) {
          successes.push(name);
        } else {
          failures.push(`${name}: ${result.error}`);
        }
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

    const msg = `Broadcast to ${successes.length} workers` +
      (failures.length > 0 ? `\nFailed: ${failures.join(", ")}` : "");
    return { content: [{ type: "text" as const, text: msg }] };
  }
);

server.tool(
  "read_inbox",
  "Read your inbox messages (durable messages from other workers)",
  {
    limit: z.number().optional().describe("Max messages to return (default: all)"),
    since: z.string().optional().describe("ISO timestamp — only messages after this time"),
    clear: z.boolean().optional().describe("If true, clear inbox after reading (replaces clear_inbox)"),
  },
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
// TASK TOOLS (4) — native TS, no shell subprocess
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "create_task",
  "Create a new task in your worker's task list",
  {
    subject: z.string().describe("Task title (imperative form)"),
    description: z.string().optional().describe("Detailed description"),
    priority: z.enum(["critical", "high", "medium", "low"]).optional().describe("Priority level (default: medium)"),
    active_form: z.string().optional().describe("Present continuous label for spinner (e.g. 'Running tests')"),
    blocks: z.string().optional().describe("Comma-separated task IDs that this task blocks (e.g. 'T003,T004')"),
    blocked_by: z.string().optional().describe("Comma-separated task IDs that block this (e.g. 'T001,T002')"),
    recurring: z.boolean().optional().describe("If true, resets to pending when completed"),
  },
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

server.tool(
  "claim_task",
  "Claim a task (assign it to yourself and set status to in_progress)",
  {
    task_id: z.string().describe("Task ID (e.g. 'T001')"),
  },
  async ({ task_id }) => {
    try {
      const tasks = readTasks(WORKER_NAME);
      const task = tasks[task_id];

      if (!task) {
        return { content: [{ type: "text" as const, text: `Error: Task ${task_id} not found` }], isError: true };
      }
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
      if (task.owner && task.owner !== "null" && task.owner !== WORKER_NAME) {
        return { content: [{ type: "text" as const, text: `Error: Task ${task_id} already claimed by ${task.owner}` }], isError: true };
      }

      task.status = "in_progress";
      task.owner = WORKER_NAME;
      writeTasks(WORKER_NAME, tasks);

      return { content: [{ type: "text" as const, text: `Claimed ${task_id}: ${task.subject}` }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "complete_task",
  "Mark a task as completed (recurring tasks auto-reset to pending)",
  {
    task_id: z.string().describe("Task ID (e.g. 'T001')"),
  },
  async ({ task_id }) => {
    try {
      const tasks = readTasks(WORKER_NAME);
      const task = tasks[task_id];

      if (!task) {
        return { content: [{ type: "text" as const, text: `Error: Task ${task_id} not found` }], isError: true };
      }

      const now = new Date().toISOString();

      if (task.recurring) {
        task.status = "pending";
        task.owner = null;
        task.completed_at = null;
        task.last_completed_at = now;
        task.cycles_completed = (task.cycles_completed || 0) + 1;
        writeTasks(WORKER_NAME, tasks);
        return { content: [{ type: "text" as const, text: `Completed ${task_id} (recurring — reset to pending, cycle #${task.cycles_completed})` }] };
      }

      task.status = "completed";
      task.completed_at = now;
      writeTasks(WORKER_NAME, tasks);

      return { content: [{ type: "text" as const, text: `Completed ${task_id}` }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "list_tasks",
  "List tasks across workers — unified cross-worker view or filtered to one worker",
  {
    filter: z.enum(["all", "pending", "in_progress", "blocked"]).optional()
      .describe("Filter by status (default: all non-deleted)"),
    worker: z.string().optional()
      .describe("Specific worker name, or 'all' for cross-worker view (default: self)"),
  },
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

      return { content: [{ type: "text" as const, text: `${totalCount} tasks:\n${results.join("\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// STATE & FLEET TOOLS (3)
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "get_worker_state",
  "Read a worker's state.json (default: your own)",
  {
    name: z.string().optional().describe("Worker name (default: self)"),
  },
  async ({ name }) => {
    try {
      const targetName = name || WORKER_NAME;
      const statePath = join(WORKERS_DIR, targetName, "state.json");
      if (!existsSync(statePath)) {
        return { content: [{ type: "text" as const, text: `No state.json for worker '${targetName}'` }], isError: true };
      }
      const state = readJsonFile(statePath);
      return { content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "update_state",
  "Update a key in your own state.json and emit a bus event",
  {
    key: z.string().describe("State key to update (e.g. 'status', 'cycles_completed')"),
    value: z.union([z.string(), z.number(), z.boolean()]).describe("New value"),
  },
  async ({ key, value }) => {
    try {
      const statePath = join(WORKERS_DIR, WORKER_NAME, "state.json");
      const lockPath = statePath + ".lock";

      if (!existsSync(statePath)) {
        return { content: [{ type: "text" as const, text: `No state.json for worker '${WORKER_NAME}'` }], isError: true };
      }

      acquireLock(lockPath);
      try {
        const state = readJsonFile(statePath) || {};
        state[key] = value;
        writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
      } finally {
        releaseLock(lockPath);
      }

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

server.tool(
  "fleet_status",
  "Get full fleet status (same output as check-flat-workers.sh)",
  {},
  async () => {
    try {
      const result = runScript(CHECK_WORKERS_SH, ["--project", PROJECT_ROOT], { timeout: 15_000 });
      if (result.exitCode !== 0) {
        return { content: [{ type: "text" as const, text: `Error: ${result.stderr || result.stdout}` }], isError: true };
      }
      return { content: [{ type: "text" as const, text: result.stdout }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// DEPLOY & HEALTH TOOLS (2)
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "deploy",
  "Deploy to test server (workers cannot deploy to prod). Runs deploy.sh with --skip-langfuse, then auto-checks health.",
  {
    service: z.enum(["static", "web", "core", "all"]).optional()
      .describe("Which service to deploy (default: static). 'static' = zero downtime UI only. 'core' requires Warren approval."),
  },
  async ({ service }) => {
    const svc = service || "static";

    // Guard: workers cannot deploy to prod
    if (WORKER_NAME === "chief-of-staff" || WORKER_NAME === "quick-fixer") {
      // These workers have special deploy permissions but still only test via this tool
    }

    // Guard: core deploy needs Warren approval
    if (svc === "core") {
      return {
        content: [{ type: "text" as const, text: "Error: --service core restarts the WeChat callback handler. Message Warren for approval first, then use bash directly." }],
        isError: true,
      };
    }

    try {
      // Step 1: Deploy to test
      const deployArgs = ["--skip-langfuse"];
      if (svc !== "all") deployArgs.push("--service", svc);
      const deployScript = join(PROJECT_ROOT, "scripts/deploy.sh");

      const result = runScript(deployScript, deployArgs, { timeout: 300_000 }); // 5 min timeout

      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `Deploy failed (service=${svc}):\n${result.stderr || result.stdout}` }],
          isError: true,
        };
      }

      // Step 2: Auto health check
      let healthOutput = "";
      try {
        const healthResult = spawnSync("curl", ["-sf", "--max-time", "10", "https://test.baoyuansmartlife.com/health"], {
          encoding: "utf-8", timeout: 15_000,
        });
        if (healthResult.status === 0) {
          healthOutput = `\nHealth check: PASS`;
        } else {
          healthOutput = `\nHealth check: FAIL (${healthResult.stderr || "no response"})`;
        }
      } catch {
        healthOutput = "\nHealth check: FAIL (timeout)";
      }

      return {
        content: [{ type: "text" as const, text: `Deployed service=${svc} to test${healthOutput}\n\n${result.stdout.slice(-500)}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.tool(
  "health_check",
  "Check test and/or prod server health (curl /health endpoint)",
  {
    target: z.enum(["test", "prod", "both"]).optional().describe("Which server to check (default: test)"),
  },
  async ({ target }) => {
    const t = target || "test";
    const results: string[] = [];

    const checkHealth = (label: string, url: string): string => {
      try {
        const result = spawnSync("curl", ["-sf", "--max-time", "10", url], {
          encoding: "utf-8", timeout: 15_000,
        });
        if (result.status === 0) {
          // Parse health response for detail
          try {
            const data = JSON.parse(result.stdout);
            const version = data.version || data.commit || "";
            return `${label}: PASS${version ? ` (${version})` : ""}`;
          } catch {
            return `${label}: PASS`;
          }
        }
        return `${label}: FAIL (status ${result.status})`;
      } catch (e: any) {
        return `${label}: FAIL (${e.message})`;
      }
    };

    if (t === "test" || t === "both") {
      results.push(checkHealth("test", "https://test.baoyuansmartlife.com/health"));
    }
    if (t === "prod" || t === "both") {
      results.push(checkHealth("prod", "https://wx.baoyuansmartlife.com/health"));
    }

    return { content: [{ type: "text" as const, text: results.join("\n") }] };
  }
);

// ═══════════════════════════════════════════════════════════════════
// LIFECYCLE TOOLS (2) — recycle & spawn_child
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "recycle",
  "Self-recycle: write handoff context, then restart as a fresh Claude session in the same pane. Use at end of a cycle or when context is stale.",
  {
    message: z.string().optional().describe("Handoff message for the next instance (what's done, what's next, blockers)"),
  },
  async ({ message }) => {
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

    // 4. Get config
    const model = getWorkerModel();
    const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);

    // 5. Generate seed file (includes handoff + transcript path)
    const seedHandoff = message || "";
    const seedTranscript = transcriptPath
      ? `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
      : "";
    const seedContent = generateSeedContent((seedHandoff + seedTranscript).trim() || undefined);
    const seedFile = `/tmp/worker-${WORKER_NAME}-seed.txt`;
    writeFileSync(seedFile, seedContent);

    // 6. Create recycle script
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
until tmux capture-pane -t "$PANE_ID" -p 2>/dev/null | grep -q "Context left"; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 90 ] && break
done
sleep 3

# Inject seed
tmux load-buffer "$SEED_FILE"
tmux paste-buffer -t "$PANE_ID"
sleep 2
tmux send-keys -t "$PANE_ID" -H 0d

# Cleanup
rm -f "${recycleScript}"
`);

    // 7. Spawn recycle script in background (detached)
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

server.tool(
  "spawn_child",
  "Fork yourself into a new pane split to the right. The child inherits your full conversation context and can work independently.",
  {
    task: z.string().optional().describe("Task/instruction to inject into the child after it starts"),
  },
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

    // 5. Register child via worker-register-child.sh
    const registerScript = join(CLAUDE_OPS, "scripts/worker-register-child.sh");
    try {
      execSync(`bash "${registerScript}" "${childPaneId}" "${ownPane.paneId}"`, {
        timeout: 10_000, encoding: "utf-8",
      });
    } catch (e: any) {
      // Non-fatal — child can still work without registration
      // But log the error
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
# Use "Context left" from statusline as signal — more reliable than prompt character
WAIT=0
until tmux capture-pane -t "$CHILD_PANE" -p 2>/dev/null | grep -q "Context left"; do
  sleep 3; WAIT=\$((WAIT+3))
  [ "\$WAIT" -ge 120 ] && break
done
sleep 3

# Inject task
tmux load-buffer "${taskFile}"
tmux paste-buffer -t "$CHILD_PANE"
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

server.tool(
  "register_pane",
  "Register this pane in pane-registry as a worker pane. Call this after recycle or manual launch when spawn_child/recycle can't find your pane.",
  {},
  async () => {
    const tmuxPane = process.env.TMUX_PANE;
    if (!tmuxPane) {
      return { content: [{ type: "text" as const, text: "Error: TMUX_PANE env var not set. Are you running in tmux?" }], isError: true };
    }

    // Resolve pane_target from tmux
    let paneTarget = "";
    let tmuxSession = "";
    try {
      const raw = execSync(
        `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index} #{session_name}' | awk -v id="${tmuxPane}" '$1 == id {print $2, $3}'`,
        { encoding: "utf-8", timeout: 5000 }
      ).trim();
      const parts = raw.split(" ");
      paneTarget = parts[0] || "";
      tmuxSession = parts[1] || "";
    } catch {}

    // Write to pane-registry.json
    const registryPath = PANE_REGISTRY_PATH;
    if (!existsSync(registryPath)) {
      writeFileSync(registryPath, "{}");
    }

    const entry = {
      harness: `worker/${WORKER_NAME}`,
      session_name: WORKER_NAME,
      display: WORKER_NAME,
      task: "worker",
      done: 0,
      total: 0,
      pane_target: paneTarget,
      project_root: PROJECT_ROOT,
      tmux_session: tmuxSession,
      registered_at: new Date().toISOString(),
    };

    try {
      const registry = readJsonFile(registryPath) || {};
      registry[tmuxPane] = entry;
      writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error writing registry: ${e.message}` }], isError: true };
    }

    return {
      content: [{
        type: "text" as const,
        text: `Registered pane ${tmuxPane} (${paneTarget}) as worker/${WORKER_NAME}\n` +
          `Project: ${PROJECT_ROOT}\n` +
          `Registry: ${registryPath}`,
      }],
    };
  }
);

server.tool(
  "check_config",
  "Run diagnostics on worker configuration. Checks: env vars, worker dir, mission.md, state.json, permissions.json, tasks.json, inbox, git branch, worktree, pane registry, required scripts. Returns issues with fix suggestions.",
  {},
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
// GIT TOOL (1)
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "smart_commit",
  "Commit staged changes with structured metadata + optional merge request signal",
  {
    message: z.string().describe("Commit message in type(scope): description format"),
    files: z.string().optional().describe("Space-separated files to git add before committing"),
    verified_test: z.boolean().optional().describe("Skip test run (pre-verified)"),
    verified_tsc: z.boolean().optional().describe("Skip tsc check (pre-verified)"),
    merge_request: z.boolean().optional().describe("Signal chief-of-staff to merge after commit"),
    service_hint: z.string().optional().describe("Deploy service hint for merge (static|web|core)"),
  },
  async ({ message, files, verified_test, verified_tsc, merge_request, service_hint }) => {
    try {
      const args = [message];
      if (files) args.push("--add", files);
      if (verified_test) args.push("--verified-test");
      if (verified_tsc) args.push("--verified-tsc");

      const result = runScript(WORKER_COMMIT_SH, args, { timeout: 60_000 });
      let output = result.stdout;

      if (result.exitCode !== 0) {
        return { content: [{ type: "text" as const, text: `Commit failed: ${result.stderr || result.stdout}` }], isError: true };
      }

      if (merge_request && existsSync(REQUEST_MERGE_SH)) {
        const mrArgs: string[] = [];
        if (service_hint) mrArgs.push("--service", service_hint);
        const mrResult = runScript(REQUEST_MERGE_SH, mrArgs);
        output += "\n" + (mrResult.stdout || mrResult.stderr);
      }

      return { content: [{ type: "text" as const, text: output }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════════════════════════
// NEXUS TOOL (1)
// ═══════════════════════════════════════════════════════════════════

server.tool(
  "post_to_nexus",
  "Post a status message to a Nexus room with [worker-name] prefix",
  {
    message: z.string().describe("Message content"),
    room: z.string().optional().describe("Nexus room (default: nexus-qbg-zhu)"),
  },
  async ({ message, room }) => {
    try {
      const targetRoom = room || "nexus-qbg-zhu";
      const prefixedMessage = `[${WORKER_NAME}] ${message}`;

      const nexusConfig = join(HOME, ".nexus-config");
      let accessToken = process.env.NEXUS_ACCESS_TOKEN || "";
      let homeserver = process.env.NEXUS_HOMESERVER || "https://footemp.bar";

      if (!accessToken && existsSync(nexusConfig)) {
        try {
          const config = readJsonFile(nexusConfig);
          accessToken = config?.access_token || config?.accessToken || "";
          homeserver = config?.homeserver || homeserver;
        } catch {}
      }

      if (!accessToken) {
        return {
          content: [{ type: "text" as const, text: `Nexus token not configured. Message not sent.\nIntended: [${WORKER_NAME}] ${message} → ${targetRoom}` }],
          isError: true,
        };
      }

      const txnId = `m${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
      const roomAlias = targetRoom.startsWith("#") ? targetRoom : `#${targetRoom}:footemp.bar`;

      const resolveResult = spawnSync("curl", [
        "-sf", "-H", `Authorization: Bearer ${accessToken}`,
        `${homeserver}/_matrix/client/v3/directory/room/${encodeURIComponent(roomAlias)}`,
      ], { encoding: "utf-8", timeout: 10_000 });

      let roomId: string;
      try { roomId = JSON.parse(resolveResult.stdout).room_id; } catch {
        return { content: [{ type: "text" as const, text: `Failed to resolve room '${targetRoom}'` }], isError: true };
      }

      const sendResult = spawnSync("curl", [
        "-sf", "-X", "PUT",
        "-H", `Authorization: Bearer ${accessToken}`,
        "-H", "Content-Type: application/json",
        "-d", JSON.stringify({ msgtype: "m.text", body: prefixedMessage }),
        `${homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      ], { encoding: "utf-8", timeout: 10_000 });

      if (sendResult.status !== 0) {
        return { content: [{ type: "text" as const, text: `Failed to send to Nexus: ${sendResult.stderr}` }], isError: true };
      }

      return { content: [{ type: "text" as const, text: `Posted to ${targetRoom}: [${WORKER_NAME}] ${message}` }] };
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
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
  resolveRecipient, readJsonFile, acquireLock, releaseLock,
  findOwnPane, getSessionId, getWorkerModel, getWorktreeDir, generateSeedContent,
  runDiagnostics, _setWorkersDir,
  WORKER_NAME, WORKERS_DIR, HARNESS_LOCK_DIR,
  type Task, type InboxCursor, type DiagnosticIssue,
};
