#!/usr/bin/env bun
/**
 * worker-fleet MCP server — Tools for worker fleet coordination.
 *
 * 20 tools (fine-grained, one action per tool):
 *   Tasks:          REMOVED — use LKML (mail threads with TASK labels)
 *   State (2):      get_worker_state, update_state
 *   Hooks (4):      add_hook, complete_hook, remove_hook, list_hooks
 *   Lifecycle (1):  recycle (gated on dynamic hooks, watchdog-deferred for perpetual workers)
 *   Checkpoint (1): save_checkpoint
 *   Fleet (7):      create_worker, register_worker, deregister_worker, move_worker, standby_worker, fleet_template, fleet_help
 *   Review (1):     deep_review
 *   Mail (4):       mail_send, mail_inbox, mail_read, mail_help
 *
 * All messaging via Fleet Mail (formerly BMS). Tasks tracked as TASK-labeled mail threads (LKML model).
 *
 * Runtime: bun run ~/.claude-ops/mcp/worker-fleet/index.ts (stdio transport)
 * Identity: auto-detected from WORKER_NAME env or git branch (worker/* → name)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync,
  readdirSync, statSync, unlinkSync, symlinkSync, renameSync,
  lstatSync, rmSync, copyFileSync, cpSync, realpathSync,
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

// ── Shared Helpers ───────────────────────────────────────────────────

/** Capture current git branch, SHA, dirty/staged counts */
function _captureGitState(cwd?: string): { branch?: string; sha?: string; dirty_count: number; staged_count: number } {
  try {
    const opts = { encoding: "utf-8" as const, timeout: 5000, cwd: cwd || getWorktreeDir() };
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
    const sha = execSync("git rev-parse --short HEAD", opts).trim();
    const porcelain = execSync("git status --porcelain", opts).trim();
    const lines = porcelain ? porcelain.split("\n") : [];
    const staged = lines.filter((l: string) => /^[MADRC]/.test(l)).length;
    const dirty = lines.filter((l: string) => /^.[MADRC?]/.test(l)).length;
    return { branch, sha, dirty_count: dirty, staged_count: staged };
  } catch {
    return { dirty_count: 0, staged_count: 0 };
  }
}

/** Capture dynamic hooks snapshot for checkpoint */
function _captureHooksSnapshot(): Array<{ id: string; event: string; description: string; blocking: boolean; completed: boolean }> {
  return [...dynamicHooks.values()].map(h => ({
    id: h.id, event: h.event, description: h.description,
    blocking: h.blocking, completed: h.completed,
  }));
}

/** Generate timestamp-based filename with millisecond precision to avoid same-second collisions.
 *  Format: checkpoint-20260309T143022123Z.json */
function _timestampFilename(): string {
  return `checkpoint-${new Date().toISOString().replace(/[:.]/g, "").slice(0, 18)}Z.json`;
}

/** Write checkpoint, update latest symlink atomically, GC to keep last N */
function _writeCheckpoint(
  checkpointDir: string,
  checkpoint: Record<string, unknown>,
  keepCount = 5,
): string {
  mkdirSync(checkpointDir, { recursive: true });
  const filename = _timestampFilename();
  const filepath = join(checkpointDir, filename);
  writeFileSync(filepath, JSON.stringify(checkpoint, null, 2) + "\n");

  // Update latest symlink atomically: write to temp then rename (avoids brief ENOENT window).
  const latestLink = join(checkpointDir, "latest.json");
  const latestTmp = join(checkpointDir, "latest.json.tmp");
  try {
    try { unlinkSync(latestTmp); } catch {}
    symlinkSync(filename, latestTmp);
    renameSync(latestTmp, latestLink);
  } catch {
    // Fallback: non-atomic (original behavior)
    try { unlinkSync(latestLink); } catch {}
    try { symlinkSync(filename, latestLink); } catch {}
  }

  // GC: keep last N. Note: checkpoint-*.json glob never matches 'latest.json' (different prefix).
  try {
    const all = readdirSync(checkpointDir)
      .filter(f => f.startsWith("checkpoint-") && f.endsWith(".json"))
      .sort();
    if (all.length > keepCount) {
      for (const old of all.slice(0, all.length - keepCount)) {
        try { unlinkSync(join(checkpointDir, old)); } catch {}
      }
    }
  } catch {}

  return filepath;
}

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

/** Derive canonical project name — strips worktree suffix (-w-*) */
function resolveProjectName(): string {
  return basename(PROJECT_ROOT).replace(/-w-.*$/, '');
}

/** Single-source registry outside git — no symlinks needed across worktrees */
const FLEET_DIR = join(HOME, ".claude/fleet", resolveProjectName());
const REGISTRY_PATH = join(FLEET_DIR, "registry.json");
const LEGACY_REGISTRY_PATH = join(PROJECT_ROOT, ".claude/workers/registry.json");

/** Auto-migrate registry from legacy per-worktree path to fleet-global path */
function migrateRegistryIfNeeded(): void {
  mkdirSync(FLEET_DIR, { recursive: true });
  if (existsSync(REGISTRY_PATH)) return;

  // Resolve legacy path (may be a symlink to main repo)
  let legacyPath = LEGACY_REGISTRY_PATH;
  try { legacyPath = realpathSync(LEGACY_REGISTRY_PATH); } catch {}
  if (!existsSync(legacyPath)) return;

  // Validate it's actual registry content, not a migration stub
  try {
    const raw = JSON.parse(readFileSync(legacyPath, "utf-8"));
    if (raw._migrated_to) return; // Already a stub
  } catch { return; }

  copyFileSync(legacyPath, REGISTRY_PATH);
}
migrateRegistryIfNeeded();


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
const HOOKS_DIR = process.env.CLAUDE_HOOKS_DIR || join(HOME, ".claude/ops/hooks/dynamic");
try { mkdirSync(HOOKS_DIR, { recursive: true }); } catch {}
const HOOKS_FILE = join(HOOKS_DIR, `${WORKER_NAME}.json`);

/** Persist hooks to file for hook scripts to read */
function _persistHooks(): void {
  try {
    const hooks = [...dynamicHooks.values()];
    if (hooks.length === 0) {
      try { rmSync(HOOKS_FILE); } catch {}
      return;
    }
    writeFileSync(HOOKS_FILE, JSON.stringify({ worker: WORKER_NAME, hooks }, null, 2));
  } catch (e) {
    console.error(`[_persistHooks] Failed to write ${HOOKS_FILE}: ${e}`);
  }
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
  mission_authority: string | string[];
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

/** Check if a worker name is in the mission_authority group (supports string or string[]) */
function isMissionAuthority(name: string, config?: RegistryConfig): boolean {
  if (!config?.mission_authority) return false;
  const ma = config.mission_authority;
  return Array.isArray(ma) ? ma.includes(name) : ma === name;
}

/** Get the first mission authority name (for display/fallback purposes) */
function getMissionAuthorityLabel(config?: RegistryConfig): string {
  const ma = config?.mission_authority;
  if (!ma) return "chief-of-staff";
  return Array.isArray(ma) ? ma.join(", ") : ma;
}

/** Resolve report_to (falls back to first mission_authority) */
function getReportTo(w: RegistryWorkerEntry, config?: RegistryConfig): string | null {
  if (w.report_to) return w.report_to;
  const ma = config?.mission_authority;
  if (!ma) return null;
  return Array.isArray(ma) ? ma[0] : ma;
}

/** Check if caller has authority to update target worker's state */
function canUpdateWorker(callerName: string, targetName: string, registry: ProjectRegistry): boolean {
  if (callerName === targetName) return true;
  const config = registry._config as RegistryConfig;
  if (isMissionAuthority(callerName, config)) return true;
  const target = registry[targetName] as RegistryWorkerEntry | undefined;
  if (target && getReportTo(target, config) === callerName) return true;
  return false;
}

/** Read project registry from disk (no locking — caller handles concurrency) */
function readRegistry(): ProjectRegistry {
  let raw = readJsonFile(REGISTRY_PATH);

  // Fallback: try legacy path if new location doesn't exist yet
  if ((!raw || raw._migrated_to) && existsSync(LEGACY_REGISTRY_PATH)) {
    const legacy = readJsonFile(LEGACY_REGISTRY_PATH);
    if (legacy && legacy._config && !legacy._migrated_to) {
      raw = legacy;
      // Auto-migrate on next read
      migrateRegistryIfNeeded();
    }
  }

  if (!raw || !raw._config || raw._migrated_to) {
    // Bootstrap empty registry
    return {
      _config: {
        commit_notify: ["merger"],
        merge_authority: "merger",
        deploy_authority: "merger",
        mission_authority: "chief-of-staff",
        tmux_session: "w",
        project_name: resolveProjectName(),
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

  const projectName = resolveProjectName();
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

// syncTasksToFilesystem — REMOVED (LKML model)

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

// ── Task CRUD Helpers — REMOVED (LKML model) ────────────────────────
// Tasks are now TASK-labeled mail threads. See seed-context.md for conventions.

// ── Inbox Helpers ────────────────────────────────────────────────────

// generateMsgId removed — Fleet Mail generates message IDs

// inbox types, cursor, and jsonl functions removed — Fleet Mail handles all messaging

// readInboxFromCursor and writeToInbox removed — Fleet Mail handles all messaging

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
      const reportToName = myEntry ? getReportTo(myEntry, config) : getMissionAuthorityLabel(config);
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

/** Find this worker's pane. Priority: TMUX_PANE env → session_id pane-map → registry. */
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

  // Session-based fallback: if we have a session_id in registry, look up its pane from pane-map
  const entry = getWorkerEntry(WORKER_NAME);
  if (entry?.session_id) {
    const paneMapPath = join(HOME, ".claude/pane-map", entry.session_id);
    try {
      const mappedPane = readFileSync(paneMapPath, "utf-8").trim();
      if (mappedPane && isPaneAlive(mappedPane)) {
        // Resolve target
        try {
          const target = execSync(
            `tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="${mappedPane}" '$1 == id {print $2}'`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
          return { paneId: mappedPane, paneTarget: target };
        } catch {}
        return { paneId: mappedPane, paneTarget: "" };
      }
    } catch {}
  }

  // Final fallback: registry pane_id
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
  const _missionAuth = getMissionAuthorityLabel(_seedConfig);

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

  // ── Build handoff/checkpoint block FIRST (most important context for resuming) ──
  let handoffBlock = "";
  if (handoff) {
    handoffBlock = `\n## HANDOFF FROM PREVIOUS CYCLE — READ FIRST\n\n${handoff}`;
  } else {
    // Read checkpoint from previous cycle (replaces handoff.md)
    const checkpointLatest = join(WORKERS_DIR, WORKER_NAME, "checkpoints", "latest.json");
    if (existsSync(checkpointLatest)) {
      try {
        const cpRaw = readFileSync(checkpointLatest, "utf-8").trim();
        const cp = JSON.parse(cpRaw);
        let cpBlock = `\n## HANDOFF FROM PREVIOUS CYCLE — READ FIRST\n\n`;
        cpBlock += `**Summary**: ${cp.summary || "No summary"}\n`;
        if (cp.git_state?.branch) {
          cpBlock += `**Git**: ${cp.git_state.branch} @ ${cp.git_state.sha || "?"} (${cp.git_state.dirty_count || 0} dirty, ${cp.git_state.staged_count || 0} staged)\n`;
        }
        if (cp.key_facts?.length > 0) {
          cpBlock += `**Key facts**:\n${cp.key_facts.map((f: string) => `- ${f}`).join("\n")}\n`;
        }
        if (cp.dynamic_hooks?.length > 0) {
          const pending = cp.dynamic_hooks.filter((h: any) => !h.completed);
          if (pending.length > 0) {
            cpBlock += `**Pending hooks**: ${pending.map((h: any) => `${h.id} (${h.event}: ${h.description})`).join(", ")}\n`;
          }
        }
        if (cp.transcript_ref) {
          cpBlock += `**Transcript**: ${cp.transcript_ref} — Read this if you need details from before recycling\n`;
        }
        handoffBlock = cpBlock;
      } catch {
        // Fall back to legacy handoff.md
        const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
        if (existsSync(handoffPath)) {
          try {
            const handoffContent = readFileSync(handoffPath, "utf-8").trim();
            if (handoffContent) {
              handoffBlock = `\n## HANDOFF FROM PREVIOUS CYCLE — READ FIRST\n\n${handoffContent}`;
            }
          } catch {}
        }
      }
    } else {
      // Legacy fallback: read handoff.md if no checkpoint exists
      const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
      if (existsSync(handoffPath)) {
        try {
          const handoffContent = readFileSync(handoffPath, "utf-8").trim();
          if (handoffContent) {
            handoffBlock = `\n## HANDOFF FROM PREVIOUS CYCLE — READ FIRST\n\n${handoffContent}`;
          }
        } catch {}
      }
    }
  }

  // ── Assemble seed: identity → handoff (FIRST) → instructions → context ──
  let seed = `You are worker **${WORKER_NAME}**.
Worktree: ${worktreeDir} (branch: ${branch})
Worker config: ${workerDir}/
${handoffBlock}
Read these files NOW in this order:
1. ${workerDir}/mission.md — your mission and goals (you own this file — update it as your mission evolves)
2. Call \`mail_inbox()\` — check for messages before anything else
3. Check \`.claude/scripts/${WORKER_NAME}/\` for existing scripts

**Your memory**: \`${workerMemoryDir}/MEMORY.md\`
Use Edit/Write to update it directly. Create topic files in that same directory for detailed notes.
This path is under the project-level auto-memory — it persists across recycles and is shared with other workers.

If your inbox has a message from the user or ${_missionAuth} (mission_authority), prioritize it over your current work.${stateBlock}${proposalBlock}

${loadSeedContext(branch, _missionAuth)}`;

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
  refreshFleetMailUnread(); // fire-and-forget
  let text = result.content[0]?.text || "";

  // 1. Diagnostics lint (errors only — warnings are noise)
  const issues = getCachedDiagnostics();
  const errors = issues.filter(i => i.severity === "error");
  if (errors.length > 0) {
    text += "\n\n⚠ LINT (" + errors.length + " issue" + (errors.length > 1 ? "s" : "") + "):\n" +
      errors.map(i => `  ✘ [${i.check}] ${i.message}${i.fix ? ` → ${i.fix}` : ""}`).join("\n");
  }

  // 2. Fleet Mail unread nudge (cached, non-blocking)
  if (_fleetMailUnreadCount > 0) {
    text += `\n\n📬 ${_fleetMailUnreadCount} unread mail — call mail_inbox() to read`;
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
// TASK TOOLS — REMOVED (LKML model: tasks are TASK-labeled mail threads)
// Use mail_send(to="self", subject="[TASK] ...", labels=["TASK","PENDING"]) to create tasks.
// Use mail_inbox(label="TASK") to list tasks.
// ═══════════════════════════════════════════════════════════════════
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
          const task = ""; // Tasks are now LKML mail threads — no local lookup
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
    key: z.string().describe("State key name. Known keys (status, perpetual, sleep_duration, report_to, model, permission_mode, disallowed_tools, branch, worktree, mission_file, pane_id, pane_target, tmux_session, window, session_id, session_file, bms_token, forked_from, last_commit_sha, last_commit_msg, last_commit_at, issues_found, issues_fixed) go top-level. Any other key goes into the custom state bag"),
    value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]).describe("Value to store. Primitives, null, or string arrays (for disallowed_tools)"),
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
        // Allowlist of top-level fields (all worker entry fields are now editable)
        const STATE_KEYS = new Set(["status","perpetual","sleep_duration",
          "last_commit_sha","last_commit_msg","last_commit_at","issues_found","issues_fixed","report_to",
          "model","permission_mode","disallowed_tools","branch","worktree","mission_file",
          "pane_id","pane_target","tmux_session","window","session_id","session_file","bms_token","forked_from"]);
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

server.registerTool(
  "update_config",
  { description: "Update fleet-wide _config fields in the registry (commit_notify, merge_authority, deploy_authority, mission_authority, tmux_session, project_name, window_groups). Only mission_authority or operator can call this.", inputSchema: {
    key: z.string().describe("Config key: commit_notify, merge_authority, deploy_authority, mission_authority, tmux_session, project_name, window_groups"),
    value: z.union([z.string(), z.array(z.string()), z.record(z.string(), z.array(z.string()))]).describe("Value. mission_authority and commit_notify accept string or string[]; window_groups accepts Record<string, string[]>; others accept strings"),
  } },
  async ({ key, value }) => {
    try {
      const validKeys = new Set(["commit_notify", "merge_authority", "deploy_authority",
        "mission_authority", "tmux_session", "project_name", "window_groups"]);
      if (!validKeys.has(key)) {
        return { content: [{ type: "text" as const, text: `Invalid config key '${key}'. Valid: ${[...validKeys].join(", ")}` }], isError: true };
      }

      withRegistryLocked((registry) => {
        const config = registry._config as RegistryConfig;
        // Authorization: only mission_authority or operator
        if (!isMissionAuthority(WORKER_NAME, config) && WORKER_NAME !== "operator" && WORKER_NAME !== "user") {
          throw new Error(`Only ${getMissionAuthorityLabel(config)} (mission_authority) or operator can update _config`);
        }
        (config as any)[key] = value;
      });

      return { content: [{ type: "text" as const, text: `Updated _config.${key} = ${JSON.stringify(value)}` }] };
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
  "list_hooks",
  {
    description: "List all active hooks (static infrastructure + dynamic runtime hooks). Shows what fires on each event, whether it blocks or injects, and its current status.",
    inputSchema: {
      event: z.string().optional().describe("Filter to a specific event (e.g. 'Stop', 'PreToolUse'). Omit for all events"),
      include_static: z.boolean().optional().describe("Include static infrastructure hooks from manifest (default: true)"),
    },
  },
  async ({ event, include_static }) => {
    const showStatic = include_static !== false;
    const lines: string[] = ["# Active Hooks\n"];

    // ── Dynamic hooks (runtime-registered by this worker) ──
    const dynamicList = [...dynamicHooks.values()]
      .filter(h => !event || h.event === event)
      .sort((a, b) => a.event.localeCompare(b.event) || a.id.localeCompare(b.id));

    if (dynamicList.length > 0) {
      lines.push(`## Dynamic Hooks (${dynamicList.length})\n`);
      for (const h of dynamicList) {
        const type = h.blocking ? "GATE" : "INJECT";
        const status = h.blocking
          ? (h.completed ? `DONE${h.result ? ` (${h.result})` : ""}` : "PENDING")
          : "active";
        const cond = h.condition ? ` [${Object.entries(h.condition).map(([k,v]) => `${k}=${v}`).join(", ")}]` : "";
        const scope = h.agent_id ? ` (agent: ${h.agent_id})` : "";
        lines.push(`- **[${h.id}]** ${h.event}/${type} — ${h.description}${cond}${scope}`);
        lines.push(`  Status: ${status} | Added: ${h.added_at.slice(0, 16)}`);
        if (h.content && h.content !== h.description) {
          const preview = h.content.length > 100 ? h.content.slice(0, 97) + "..." : h.content;
          lines.push(`  Content: "${preview}"`);
        }
      }
    } else {
      lines.push("## Dynamic Hooks\nNone registered. Use `add_hook()` to add verification gates or context injectors.\n");
    }

    // ── Static hooks (infrastructure, from manifest) ──
    if (showStatic) {
      try {
        const manifestPath = join(CLAUDE_OPS, "hooks", "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const staticHooks = (manifest.hooks || []).filter((h: any) =>
          h.id && h.event && (!event || h.event === event) && !h._comment
        );

        if (staticHooks.length > 0) {
          // Group by category
          const byCategory: Record<string, any[]> = {};
          for (const h of staticHooks) {
            const cat = h.category || "other";
            if (!byCategory[cat]) byCategory[cat] = [];
            byCategory[cat].push(h);
          }

          lines.push(`\n## Static Hooks (${staticHooks.length} from manifest)\n`);
          for (const [cat, hooks] of Object.entries(byCategory)) {
            lines.push(`### ${cat}`);
            for (const h of hooks) {
              lines.push(`- **${h.id}** (${h.event}) — ${h.description}`);
            }
          }
        }
      } catch {
        lines.push("\n## Static Hooks\n_Could not read manifest.json_");
      }
    }

    // Summary
    const blocking = [...dynamicHooks.values()].filter(h => h.blocking && !h.completed);
    const inject = [...dynamicHooks.values()].filter(h => !h.blocking);
    lines.push(`\n---\n**Summary:** ${dynamicHooks.size} dynamic (${blocking.length} blocking pending, ${inject.length} inject active)`);

    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
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
    let hasUnreadMail = false;
    try {
      const mailToken =(getWorkerEntry(WORKER_NAME) as any)?.bms_token;
      if (mailToken) {
        const resp = await fetch(`${FLEET_MAIL_URL}/api/messages?label=UNREAD&maxResults=1`, {
          headers: { Authorization: `Bearer ${mailToken}` },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const data = await resp.json() as any;
          const unread = data?._diagnostics?.unread_count || 0;
          if (unread > 0) {
            hasUnreadMail = true;
            pendingWarning = `\n\nWARNING: ${unread} unread mail — call mail_inbox() before recycling.`;
          }
        }
      }
    } catch {}

    // 1c. Idle detection for perpetual workers — sleep instead of full recycle when idle
    const entry0 = getWorkerEntry(WORKER_NAME);
    const isPerpetual0 = entry0?.perpetual === true;
    if (isPerpetual0 && !hasUnreadMail && !resume) {
      const hasSubstantiveHandoff = message && message.trim().length > 20;
      if (!hasSubstantiveHandoff) {
        // No work to do — go to sleep directly, skip expensive recycle
        const registrySleepDur0 = entry0?.sleep_duration ?? 1800;
        const effectiveSleep0 = sleep_seconds !== undefined ? sleep_seconds : registrySleepDur0;
        if (effectiveSleep0 > 0) {
          const sleepUntil0 = new Date(Date.now() + effectiveSleep0 * 1000).toISOString();

          // Write checkpoint before sleeping
          try {
            const checkpointDir = join(WORKERS_DIR, WORKER_NAME, "checkpoints");
            const gitState = _captureGitState();
            const hooks = _captureHooksSnapshot();
            const checkpoint = {
              timestamp: new Date().toISOString(),
              type: "idle-sleep" as const,
              summary: message || "Idle — no pending work, sleeping",
              git_state: gitState,
              dynamic_hooks: hooks,
              key_facts: [] as string[],
              transcript_ref: "",
            };
            _writeCheckpoint(checkpointDir, checkpoint);
          } catch {}

          withRegistryLocked((registry) => {
            const w = registry[WORKER_NAME] as RegistryWorkerEntry;
            if (w) {
              w.status = "sleeping";
              w.custom = w.custom || {};
              w.custom.sleep_until = sleepUntil0;
              w.custom.last_recycle_at = new Date().toISOString();
              w.custom.last_recycle_reason = "idle";
            }
          });

          // Generate exit-only script
          const rt0 = getWorkerRuntime();
          const recycleScript0 = `/tmp/recycle-${WORKER_NAME}-${Date.now()}.sh`;
          writeFileSync(recycleScript0, `#!/bin/bash
# Auto-generated IDLE SLEEP for ${WORKER_NAME} — no pending work, watchdog will wake on mail or timer
set -uo pipefail
PANE_ID="${ownPane.paneId}"
sleep 5
tmux send-keys -t "$PANE_ID" "${rt0.exitCommand}"
tmux send-keys -t "$PANE_ID" -H 0d
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && break
  AGENT_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *${rt0.binary}* ]] && AGENT_RUNNING=true && break
  done
  [ "$AGENT_RUNNING" = "false" ] && break
done
rm -f "${recycleScript0}"
`);
          try {
            execSync(`nohup bash "${recycleScript0}" > /tmp/recycle-${WORKER_NAME}.log 2>&1 &`, {
              shell: "/bin/bash", timeout: 5000,
            });
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error spawning idle sleep: ${e.message}` }], isError: true };
          }

          const wakeTime0 = new Date(Date.now() + effectiveSleep0 * 1000);
          const wakeStr0 = `${wakeTime0.getHours().toString().padStart(2, "0")}:${wakeTime0.getMinutes().toString().padStart(2, "0")}`;
          return {
            content: [{
              type: "text" as const,
              text: `IDLE SLEEP — no pending work detected. Sleeping for ${effectiveSleep0}s (~${wakeStr0}).\n` +
                `Watchdog will wake early if mail arrives.\n` +
                `Status: sleeping (until ${sleepUntil0})\n` +
                `Do NOT send any more tool calls — /exit will be sent shortly.`,
            }],
          };
        }
      }
    }

    // 2. Get session ID for transcript reference
    const sessionId = getSessionId(ownPane.paneId);
    const worktreeDir = getWorktreeDir();
    const pathSlug = worktreeDir.replace(/\//g, "-").replace(/^-/, "-");
    const transcriptPath = sessionId
      ? join(HOME, ".claude/projects", pathSlug, `${sessionId}.jsonl`)
      : null;

    // 3. Write checkpoint (replaces handoff.md)
    try {
      const checkpointDir = join(WORKERS_DIR, WORKER_NAME, "checkpoints");
      const gitState = _captureGitState();
      const hooks = _captureHooksSnapshot();
      const checkpoint = {
        timestamp: new Date().toISOString(),
        type: "recycle" as const,
        summary: message || "Recycle without summary",
        git_state: gitState,
        dynamic_hooks: hooks,
        key_facts: [] as string[],
        transcript_ref: transcriptPath || "",
      };
      _writeCheckpoint(checkpointDir, checkpoint);

      // Legacy compat: also write handoff.md for any tools that still read it
      const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
      if (message) {
        let handoffContent = message;
        if (transcriptPath) {
          handoffContent += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
        }
        writeFileSync(handoffPath, handoffContent.trim() + "\n");
      }
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error writing checkpoint: ${e.message}` }], isError: true };
    }

    // 4. Notify parent/operator of cycle completion
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      // Build cycle report
      const cycleReport = message
        ? `[${WORKER_NAME}] Cycle complete: ${message}`
        : `[${WORKER_NAME}] Cycle complete (no summary provided)`;

      // Notify mission_authority via Fleet Mail (best-effort)
      const maList = config?.mission_authority;
      const operatorNames: string[] = !maList ? [] : Array.isArray(maList) ? maList : [maList];
      const filteredOps = operatorNames.filter(n => n !== WORKER_NAME);
      if (filteredOps.length > 0) {
        getFleetMailToken().then(async () => {
          const toIds = await resolveFleetMailRecipients(filteredOps);
          await fleetMailRequest("POST", "/api/messages/send", {
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
            `Checkpoint: ${message ? "saved to checkpoints/" : "none"}\n` +
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
          `Checkpoint: ${message ? "saved to checkpoints/" : "none"}\n` +
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
  taskEntries?: Array<{ subject: string; description?: string; priority?: string }>;
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

  // Tasks are now LKML mail threads — store task entries for caller to mail_send
  const taskIds: string[] = taskEntries.map((_, i) => `TASK-${i + 1}`);

  return { ok: true, workerDir, model: selectedModel, runtime: resolvedRuntime, perpetual: isPerpetual, taskIds, taskEntries, state, permissions };
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
    // For report_to, use first mission_authority name as default
    const firstMa = config?.mission_authority;
    const defaultReportTo = Array.isArray(firstMa) ? firstMa[0] : (firstMa || "chief-of-staff");
    const reportTo = direct_report
      ? WORKER_NAME
      : (report_to || defaultReportTo);

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

    // Send initial tasks as LKML mail threads (best-effort, non-blocking)
    const sentTaskIds: string[] = [];
    if (result.taskEntries && result.taskEntries.length > 0) {
      for (const task of result.taskEntries) {
        try {
          const toIds = await resolveFleetMailRecipients([name]);
          const priority = task.priority || "medium";
          const priorityLabel = priority === "critical" ? "P0" : priority === "high" ? "P1" : priority === "low" ? "P3" : "P2";
          const sent = await fleetMailRequest("POST", "/api/messages/send", {
            to: toIds, subject: `[TASK] ${task.subject}`,
            body: task.description || task.subject,
            cc: [], thread_id: null, in_reply_to: null,
            reply_by: null, labels: ["TASK", priorityLabel, "PENDING"], attachments: [],
          });
          sentTaskIds.push(sent?.id || "?");
        } catch {
          sentTaskIds.push("FAILED");
        }
      }
    }

    // Return summary
    const taskSummary = sentTaskIds.length > 0
      ? `${sentTaskIds.length} sent via Fleet Mail`
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
  const _mwAuth = getMissionAuthorityLabel(_mwConfig);
  if (targetName !== WORKER_NAME && !isMissionAuthority(WORKER_NAME, _mwConfig)) {
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
  const _sbAuth = getMissionAuthorityLabel(_sbConfig);
  if (targetName !== WORKER_NAME && !isMissionAuthority(WORKER_NAME, _sbConfig)) {
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

  // Check for unread Fleet Mail (best-effort)
  let standbyPendingWarning = "";
  try {
    const targetEntry = getWorkerEntry(targetName);
    const mailToken =(targetEntry as any)?.bms_token;
    if (mailToken) {
      const resp = await fetch(`${FLEET_MAIL_URL}/api/messages?label=UNREAD&maxResults=1`, {
        headers: { Authorization: `Bearer ${mailToken}` },
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
    const maVal = config?.mission_authority;
    const defaultReportTo = Array.isArray(maVal) ? maVal[0] : (maVal || "chief-of-staff");

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
        // Session-based identity: capture session_id from pane-map (primary identity)
        const sid = getSessionId(ownPane.paneId);
        if (sid) entry.session_id = sid;
      }
    });

    const sessionId = ownPane ? getSessionId(ownPane.paneId) : null;
    const paneInfo = ownPane ? `pane ${ownPane.paneId} (${paneTarget})` : "no pane detected";
    const sessionInfo = sessionId ? `, session: ${sessionId.slice(0, 8)}…` : "";
    return {
      content: [{
        type: "text" as const,
        text: `Registered '${WORKER_NAME}' in registry.json — ${paneInfo}${sessionInfo}, model: ${model || "opus"}, report_to: ${report_to || defaultReportTo}`,
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
  const _drAuth = getMissionAuthorityLabel(_drConfig);
  if (targetName !== WORKER_NAME && !isMissionAuthority(WORKER_NAME, _drConfig)) {
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
// DEEP REVIEW — Multi-pass review (diffs + content, additive)
// ═══════════════════════════════════════════════════════════════════

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "deep_review",
  {
    description:
      "Launch a multi-pass deep review pipeline (v3). Workers follow investigation protocols with structured attack vectors, confidence scoring, and chain-of-thought evidence. Context pre-pass gathers static analysis, dependency graphs, test coverage, and git blame context. Judge agent does adversarial validation. Reads REVIEW.md for project-specific 'Always Flag'/'Never Flag' rules. Material is ADDITIVE — combine scope (git diff) and content (files). `scope` auto-detects: branch=diff since branch, SHA=commit, 'uncommitted'=working changes, 'pr:N'=PR. Graduated voting uses confidence + votes. Auto-skips trivial changes (lockfile-only, <5 lines). Smart focus auto-detects claude-md and silent-failure specializations. Emoji severity markers (🔴🟡🔵🟣) in reports. Pre-existing issues tracked separately via blame context. Creates dedicated tmux session.",
    inputSchema: {
      scope: z
        .string()
        .optional()
        .describe("Git diff scope. Auto-detects: branch name (e.g. 'main'), commit SHA, 'uncommitted', 'pr:42'. Default: HEAD if no content. Additive with content."),
      content: z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe("File path(s) to review. Comma-separated string or array. Additive with scope."),
      spec: z
        .string()
        .optional()
        .describe("What to review for — guides all workers. E.g., 'verify implementation matches the plan'."),
      passes: z
        .number()
        .optional()
        .describe("Passes PER focus area (default: 2). Total workers = passes × focus areas."),
      session_name: z
        .string()
        .optional()
        .describe("Custom tmux session name (overrides auto-naming)"),
      notify: z
        .string()
        .optional()
        .describe("Worker name or 'user' to notify on completion."),
      focus: z
        .array(z.string())
        .optional()
        .describe("Custom focus areas. Overrides auto-detect. Diff: 8 areas, content: 4 areas, mixed: 6 areas. Extra specializations: 'silent-failure' (error swallowing), 'claude-md' (CLAUDE.md compliance). Smart focus auto-includes these when patterns detected."),
      no_judge: z
        .boolean()
        .optional()
        .describe("Skip the adversarial judge validation stage (faster but less precise). Default: false."),
      no_context: z
        .boolean()
        .optional()
        .describe("Skip context pre-pass (static analysis, dependency graph, test coverage). Default: false."),
      force: z
        .boolean()
        .optional()
        .describe("Force review even if auto-skip would trigger (lockfile-only changes, <5 substantive lines). Default: false."),
    },
  },
  async ({
    scope,
    content,
    spec,
    passes,
    session_name,
    notify,
    focus,
    no_judge,
    no_context,
    force,
  }: {
    scope?: string;
    content?: string | string[];
    spec?: string;
    passes?: number;
    session_name?: string;
    notify?: string;
    focus?: string[];
    no_judge?: boolean;
    no_context?: boolean;
    force?: boolean;
  }) => {
    try {
      const scriptPath = join(CLAUDE_OPS, "scripts", "deep-review.sh");
      if (!existsSync(scriptPath)) {
        throw new Error(`deep-review.sh not found at ${scriptPath}`);
      }

      const args: string[] = [];

      // Scope and content are additive
      if (scope) {
        args.push("--scope", scope);
      }
      if (content) {
        const contentPaths = Array.isArray(content) ? content.join(",") : content;
        args.push("--content", contentPaths);
      }
      // If neither provided, shell script defaults to HEAD

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
      if (no_judge) {
        args.push("--no-judge");
      }
      if (no_context) {
        args.push("--no-context");
      }
      if (force) {
        args.push("--force");
      }

      // Validate content files exist before spawning (fast fail with clear message)
      if (content) {
        const paths = Array.isArray(content) ? content : content.split(",");
        for (const p of paths) {
          const resolved = p.trim().replace(/^~/, HOME);
          const abs = resolved.startsWith("/") ? resolved : join(PROJECT_ROOT, resolved);
          if (!existsSync(abs)) {
            throw new Error(`Content file not found: ${p.trim()} (resolved: ${abs})`);
          }
        }
      }

      const launchResult = spawnSync("bash", [scriptPath, ...args], {
        encoding: "utf-8",
        cwd: PROJECT_ROOT,
        env: { ...process.env, PROJECT_ROOT },
        timeout: 120_000, // 2 min — context pre-pass (tsc + deps) can be slow
      });

      if (launchResult.status !== 0 && launchResult.status !== null) {
        const stderr = launchResult.stderr?.slice(0, 1000) || "";
        throw new Error(`deep-review.sh failed (exit ${launchResult.status}): ${stderr}`);
      }
      if (launchResult.status === null) {
        // Killed by signal (timeout or OOM)
        const signal = launchResult.signal || "unknown";
        const stderr = launchResult.stderr?.slice(0, 500) || "";
        throw new Error(`deep-review.sh killed by ${signal} (likely timeout — try --no-context to skip static analysis, or reduce scope). ${stderr}`);
      }

      const stdout = launchResult.stdout || "";
      const tmuxSessionMatch = stdout.match(/Session:\s+(\S+)/);
      const sessionDir = tmuxSessionMatch ? tmuxSessionMatch[1] : "unknown";
      const reviewSessionMatch = stdout.match(/tmux switch-client -t (\S+)/);
      const reviewSession = reviewSessionMatch ? reviewSessionMatch[1] : session_name || "dr-unknown";
      const passesPerFocus = passes || 2;
      const hasContent = !!content;
      const hasScope = !!scope;
      const defaultFocus = hasContent && !hasScope ? 4 : hasContent && hasScope ? 6 : 8;
      const numFocus = focus?.length || defaultFocus;
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
// CHECKPOINT TOOLS (1) — save_checkpoint
// ═══════════════════════════════════════════════════════════════════

server.registerTool(
  "save_checkpoint",
  {
    description: "Save a checkpoint of your current working state. Automatically captures git state and dynamic hooks. Use before complex operations, when context is getting long, or to preserve state across recycles. Checkpoints are auto-saved before context compaction and on recycle.",
    inputSchema: {
      summary: z.string().describe("Brief description of what you're working on and current progress"),
      key_facts: z.array(z.string()).optional().describe("Important facts to preserve across context boundaries (max 10)"),
    },
  },
  async ({ summary, key_facts }) => {
    const checkpointDir = join(WORKERS_DIR, WORKER_NAME, "checkpoints");
    const gitState = _captureGitState();
    const hooks = _captureHooksSnapshot();

    // Get transcript reference
    let transcriptRef = "";
    try {
      const worktreeDir = getWorktreeDir();
      const pathSlug = worktreeDir.replace(/\//g, "-").replace(/^-/, "-");
      const projectDir = join(HOME, ".claude/projects", pathSlug);
      if (existsSync(projectDir)) {
        const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl")).sort().reverse();
        if (files.length > 0) {
          transcriptRef = join(projectDir, files[0]);
        }
      }
    } catch {}

    const checkpoint = {
      timestamp: new Date().toISOString(),
      type: "manual" as const,
      summary,
      git_state: gitState,
      dynamic_hooks: hooks,
      key_facts: (key_facts || []).slice(0, 10),
      transcript_ref: transcriptRef,
    };

    const filepath = _writeCheckpoint(checkpointDir, checkpoint);

    return {
      content: [{
        type: "text" as const,
        text: `Checkpoint saved: ${filepath}\nGit: ${gitState.branch || "?"} @ ${gitState.sha || "?"} (${gitState.dirty_count || 0} dirty, ${gitState.staged_count || 0} staged)\nHooks: ${hooks.length} active\nFacts: ${(key_facts || []).length} saved`,
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════
// FLEET MAIL — Gmail-conformant inter-agent email
// ═══════════════════════════════════════════════════════════════════
// HTTP proxy to Fleet Mail server (Rust + Dolt, centralized on Hetzner).
// Each worker auto-provisions an account on first use. Tokens cached in registry.json.
// Account names are namespaced by project: "{project}/{worker}" to avoid collisions
// when multiple projects share the same mail server.

const FLEET_MAIL_URL = process.env.FLEET_MAIL_URL ?? "http://127.0.0.1:8025";
const FLEET_MAIL_PROJECT = resolveProjectName().toLowerCase();

/** Namespace a local worker name for Fleet Mail: "merger" → "merger@wechat" */
function mailAccountName(localName: string): string {
  // Already namespaced (has @) or special — pass through
  if (localName.includes("@") || localName.startsWith("list:")) return localName;
  return `${localName}@${FLEET_MAIL_PROJECT}`;
}

/** Strip project namespace from a Fleet Mail account name: "merger@wechat" → "merger" */
function stripMailNamespace(mailName: string): string {
  const suffix = `@${FLEET_MAIL_PROJECT}`;
  if (mailName.endsWith(suffix)) return mailName.slice(0, -suffix.length);
  return mailName;
}

/** Cached Fleet Mail unread count — refreshed by mail_inbox calls and background poll */
let _fleetMailUnreadCount = 0;
let _fleetMailUnreadLastCheck = 0;

/** Refresh Fleet Mail unread count (fire-and-forget, non-blocking) */
function refreshFleetMailUnread(): void {
  const now = Date.now();
  if (now - _fleetMailUnreadLastCheck < 30_000) return; // throttle to 30s
  _fleetMailUnreadLastCheck = now;

  const entry = getWorkerEntry(WORKER_NAME);
  const mailToken =(entry as any)?.bms_token;
  if (!mailToken) return;

  fetch(`${FLEET_MAIL_URL}/api/messages?label=UNREAD&maxResults=1`, {
    headers: { Authorization: `Bearer ${mailToken}` },
    signal: AbortSignal.timeout(3000),
  }).then(r => r.ok ? r.json() : null).then((data: any) => {
    if (data) _fleetMailUnreadCount = data?._diagnostics?.unread_count || data?.messages?.length || 0;
  }).catch(() => {});
}

/** Get or auto-provision a Fleet Mail bearer token for the current worker.
 *  Tokens are stored in registry.json under each worker's `bms_token` field (legacy name). */
async function getFleetMailToken(): Promise<string> {
  // Check registry first
  const registry = readRegistry();
  const entry = registry[WORKER_NAME] as RegistryWorkerEntry | undefined;
  if (entry?.bms_token) return entry.bms_token;

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
          // Re-read registry — daemon should have repaired our token
          const refreshed = readRegistry();
          const newToken = (refreshed[WORKER_NAME] as any)?.bms_token;
          if (newToken) return newToken;
        }
      } catch {}
      throw new Error(`Fleet Mail account '${nsName}' exists but token is not in registry. Auto-repair via fleet-relay daemon failed.`);
    }
    throw new Error(`Fleet Mail register failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json() as any;
  const token = data.bearerToken as string;

  // Persist to registry — do NOT silently swallow errors here.
  // If this fails, the token works for this session but is lost on restart,
  // leading to an unrecoverable 409 on next getFleetMailToken() call.
  try {
    withRegistryLocked((reg) => {
      if (!reg[WORKER_NAME]) ensureWorkerInRegistry(reg, WORKER_NAME);
      (reg[WORKER_NAME] as any).bms_token = token;
    });
  } catch (e) {
    console.error(`[getFleetMailToken] WARN: Failed to persist bms_token for ${WORKER_NAME} to registry.json: ${e}`);
    console.error(`[getFleetMailToken] Token works for this session but will be lost on restart — 409 on next call.`);
  }

  return token;
}

/** HTTP helper for Fleet Mail API calls */
async function fleetMailRequest(method: string, path: string, body?: any): Promise<any> {
  const token = await getFleetMailToken();
  const url = `${FLEET_MAIL_URL}${path}`;
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
    throw new Error(`Fleet Mail ${method} ${path} failed (${resp.status}): ${text.slice(0, 500)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Strip project namespace from account names in Fleet Mail responses so workers see
 *  clean names ("merger") instead of namespaced ones ("merger@wechat"). */
function stripMailNamespaceFromResult(data: any): any {
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

function fleetMailTextResult(data: any): { content: { type: "text"; text: string }[] } {
  const cleaned = stripMailNamespaceFromResult(data);
  const text = typeof cleaned === "string" ? cleaned : JSON.stringify(cleaned, null, 2);
  return { content: [{ type: "text" as const, text }] };
}

/** Cache: name → account UUID. Populated lazily from /api/directory. */
let _fleetMailDirectoryCache: Record<string, string> | null = null;
let _fleetMailDirCacheTime = 0;
const FLEET_MAIL_DIR_CACHE_TTL = 60_000; // 1 minute

async function resolveFleetMailAccountId(name: string): Promise<string> {
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
  const id = _fleetMailDirectoryCache?.[nsName];
  if (id) return id;

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
        return acct.id;
      }
      // 409 = already exists but not in cache — refresh
      if (provResp.status === 409) {
        _fleetMailDirectoryCache = null;
        _fleetMailDirCacheTime = 0;
        return resolveFleetMailAccountId(name);
      }
    } catch {}
  }

  throw new Error(`Fleet Mail account '${nsName}' not found in directory`);
}

async function resolveFleetMailRecipients(names: string[]): Promise<string[]> {
  return Promise.all(names.map(resolveFleetMailAccountId));
}

// ── mail_send — unified messaging (Fleet Mail durable + tmux instant) ──────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_send",
  {
    description: `Send a message to another worker, the human operator, or the entire fleet. Messages are durably stored in Fleet Mail (persist across restarts, searchable, threaded) and delivered instantly via tmux overlay if the recipient's pane is live.

Routing:
- Worker name (e.g. "merger"): direct message via Fleet Mail + tmux push.
- "report": message whoever you report_to (resolved from registry).
- "direct_reports": fan-out to all workers who report_to you.
- "all": broadcast to every registered worker (expensive — use sparingly).
- "user": escalate to the human operator (triage queue + desktop notification, NOT via Fleet Mail).
- Raw pane ID (e.g. "%42"): tmux-only delivery, no durable storage.

Escalate to operator when: (1) design/architecture decisions need human judgment, (2) security or auth changes arise, (3) business logic changes affect end users, (4) new product surface area, (5) removing functionality, (6) external coordination needed, (7) blocked and need product direction. When in doubt, escalate.`,
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
    // Operator escalation path: send via Fleet Mail to "user" account + desktop notification
    if (to === "user") {
      let msgId = "";
      try {
        const toIds = await resolveFleetMailRecipients(["user"]);
        const ccIds = cc ? await resolveFleetMailRecipients(cc) : [];
        const result = await fleetMailRequest("POST", "/api/messages/send", {
          to: toIds, subject, body,
          cc: ccIds, thread_id: thread_id || null, in_reply_to: in_reply_to || null,
          reply_by: reply_by || null, labels: [...(labels || []), "ESCALATION"], attachments: [],
        });
        msgId = result?.id || "";
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error sending to operator via Fleet Mail: ${e.message}` }], isError: true };
      }
      // Desktop notification (best-effort)
      try {
        execSync(
          `terminal-notifier -title "Worker Escalation" -message ${JSON.stringify(`[${WORKER_NAME}] ${subject}`)} -sound default 2>/dev/null || osascript -e 'display notification ${JSON.stringify(`[${WORKER_NAME}] ${subject}`)} with title "Worker Escalation" sound name "default"'`,
          { timeout: 5000, shell: "/bin/bash" }
        );
      } catch {}
      return withLint({ content: [{ type: "text" as const, text: `Sent to operator via Fleet Mail [${msgId}] + desktop notification` }] });
    }

    // Raw pane ID — tmux-only, no Fleet Mail
    if (to.startsWith("%")) {
      if (!isPaneAlive(to)) {
        return { content: [{ type: "text" as const, text: `Error: Pane ${to} is dead` }], isError: true };
      }
      try {
        tmuxSendMessage(to, `[msg from ${WORKER_NAME}] ${body}`);
        return { content: [{ type: "text" as const, text: `Sent to pane ${to} (tmux-only, no Fleet Mail)` }] };
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

    // Send via Fleet Mail (durable delivery)
    const mailSuccesses: string[] = [];
    const mailFailures: string[] = [];
    const tmuxDelivered: string[] = [];
    let lastMsgId = "";

    for (const name of recipientNames) {
      try {
        const toIds = await resolveFleetMailRecipients([name]);
        const ccIds = cc ? await resolveFleetMailRecipients(cc) : [];
        const result = await fleetMailRequest("POST", "/api/messages/send", {
          to: toIds, subject, body,
          cc: ccIds, thread_id: thread_id || null, in_reply_to: in_reply_to || null,
          reply_by: reply_by || null, labels: labels || [], attachments: [],
        });
        lastMsgId = result?.id || "";
        mailSuccesses.push(name);
      } catch (e: any) {
        mailFailures.push(`${name}: ${e.message?.slice(0, 80)}`);
      }
    }

    // Tmux instant delivery (best-effort overlay)
    const registry = (() => { try { return readRegistry(); } catch { return {} as any; } })();
    for (const name of mailSuccesses) {
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
    if (mailSuccesses.length === 0) {
      return { content: [{ type: "text" as const, text: `Failed to send to all recipients:\n${mailFailures.join("\n")}` }], isError: true };
    }

    const parts: string[] = [];
    if (recipientNames.length === 1) {
      let paneWarning = "";
      const entry = registry[recipientNames[0]] as RegistryWorkerEntry | undefined;
      if (entry && (!entry.pane_id || !isPaneAlive(entry.pane_id))) {
        paneWarning = ` (WARNING: no active pane — queued in Fleet Mail inbox)`;
      }
      parts.push(`Sent to ${recipientNames[0]} [${lastMsgId}]${paneWarning}`);
    } else {
      parts.push(`Sent to ${mailSuccesses.length}/${recipientNames.length} workers`);
      if (tmuxDelivered.length > 0) parts.push(`Tmux overlay: ${tmuxDelivered.join(", ")}`);
      if (mailFailures.length > 0) parts.push(`Failed: ${mailFailures.join(", ")}`);
    }

    return withLint({ content: [{ type: "text" as const, text: parts.join("\n") }] });
  }
);

// ── mail_inbox — read from Fleet Mail ──────────────────────────────────────

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "mail_inbox",
  {
    description: "Read messages from your Fleet Mail inbox. Call at the start of every cycle — messages may contain instructions, merge notifications, or approval requests that should be acted on before starting new work. Returns messages with sender, subject, labels, and timestamps. Use label='UNREAD' for unread-only.",
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
      const result = await fleetMailRequest("GET", path);
      return withLint(fleetMailTextResult(result));
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
      const result = await fleetMailRequest("GET", `/api/messages/${encodeURIComponent(id)}`);
      return fleetMailTextResult(result);
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
    description: "Get Fleet Mail CLI docs for search, threads, labels, trash, directory, mailing lists, and raw curl. Call this for any mail operation beyond send/inbox/read.",
    inputSchema: {},
  },
  async () => {
    const token = await getFleetMailToken().catch(() => "<your-token>");
    return fleetMailTextResult(`# Fleet Mail — Management CLI

Server: ${FLEET_MAIL_URL}
Your account: ${mailAccountName(WORKER_NAME)}
Your token: ${token}

## Search (replaces mail_search tool)

  # Gmail-style query syntax: from:, to:, subject:, has:attachment, label:, date ranges
  curl -sf "${FLEET_MAIL_URL}/api/search?q=from:merger&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Threads (replaces mail_thread tool)

  # Get full conversation thread
  curl -sf "${FLEET_MAIL_URL}/api/threads/<thread-id>" \\
    -H "Authorization: Bearer $TOKEN"

  # List threads by label
  curl -sf "${FLEET_MAIL_URL}/api/threads?label=INBOX&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Token Management

  # Reset your bearer token (invalidates old one, returns new)
  curl -sf -X POST "${FLEET_MAIL_URL}/api/accounts/me/reset-token" \\
    -H "Authorization: Bearer $TOKEN"
  # Response: {"bearerToken":"<new-uuid>","id":"...","name":"..."}
  # After reset, update registry.json: bms_token field for your worker

## Label Operations

  # List labels with counts
  curl -sf "${FLEET_MAIL_URL}/api/labels" -H "Authorization: Bearer $TOKEN"

  # Add/remove labels on a message
  curl -sf -X POST "${FLEET_MAIL_URL}/api/messages/<msg-id>/modify" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"addLabelIds":["STARRED"],"removeLabelIds":["UNREAD"]}'

  # Create custom label
  curl -sf -X POST "${FLEET_MAIL_URL}/api/labels" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"name":"MY-LABEL"}'

  # Delete custom label
  curl -sf -X DELETE "${FLEET_MAIL_URL}/api/labels/MY-LABEL" \\
    -H "Authorization: Bearer $TOKEN"

## Message Management

  # Trash a message
  curl -sf -X POST "${FLEET_MAIL_URL}/api/messages/<msg-id>/trash" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

  # Permanently delete
  curl -sf -X DELETE "${FLEET_MAIL_URL}/api/messages/<msg-id>" \\
    -H "Authorization: Bearer $TOKEN"

  # Batch modify labels
  curl -sf -X POST "${FLEET_MAIL_URL}/api/messages/batchModify" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"ids":["id1","id2"],"addLabelIds":["STARRED"],"removeLabelIds":[]}'

## Threads

  # List threads by label
  curl -sf "${FLEET_MAIL_URL}/api/threads?label=INBOX&maxResults=20" \\
    -H "Authorization: Bearer $TOKEN"

## Directory & Profile

  # List all accounts
  curl -sf "${FLEET_MAIL_URL}/api/directory" -H "Authorization: Bearer $TOKEN"

  # Search accounts
  curl -sf "${FLEET_MAIL_URL}/api/directory?q=merger" -H "Authorization: Bearer $TOKEN"

  # View own profile
  curl -sf "${FLEET_MAIL_URL}/api/accounts/me" -H "Authorization: Bearer $TOKEN"

  # Update bio
  curl -sf -X PUT "${FLEET_MAIL_URL}/api/accounts/me" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"bio":"I handle code reviews"}'

## Mailing Lists

  # Create list
  curl -sf -X POST "${FLEET_MAIL_URL}/api/lists" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \\
    -d '{"name":"team-all","description":"All team members"}'

  # Subscribe (self)
  curl -sf -X POST "${FLEET_MAIL_URL}/api/lists/<list-id>/subscribe" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'

  # Send to list (use list:name in to field)
  # mail_send(to=["list:team-all"], subject="...", body="...")

## Blob Attachments

  # Upload blob
  curl -sf -X POST "${FLEET_MAIL_URL}/api/blobs" \\
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/octet-stream" \\
    --data-binary @file.txt

  # Download blob
  curl -sf "${FLEET_MAIL_URL}/api/blobs/<sha256-hash>" -H "Authorization: Bearer $TOKEN" -o file.txt

## Health & Analytics

  curl -sf "${FLEET_MAIL_URL}/health"
  curl -sf "${FLEET_MAIL_URL}/api/analytics" -H "Authorization: Bearer $TOKEN"
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
  writeToTriageQueue, buildMessageBody,
  resolveRecipient, isPaneAlive, readJsonFile, acquireLock, releaseLock,
  findOwnPane, getSessionId, getWorkerModel, getWorktreeDir, generateSeedContent,
  runDiagnostics, createWorkerFiles, _setWorkersDir,
  readRegistry, getWorkerEntry, withRegistryLocked, ensureWorkerInRegistry,
  lintRegistry, _replaceMemorySection, getReportTo, canUpdateWorker,
  _captureGitState, _captureHooksSnapshot, _timestampFilename, _writeCheckpoint,
  WORKER_NAME, WORKERS_DIR, HARNESS_LOCK_DIR, REGISTRY_PATH,
  type DiagnosticIssue,
  type RegistryConfig, type RegistryWorkerEntry, type ProjectRegistry,
  type WorkerRuntime, type ReasoningEffort, type RuntimeConfig,
  getWorkerRuntime, RUNTIMES,
};
