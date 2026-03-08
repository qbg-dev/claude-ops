#!/usr/bin/env bun
/**
 * check-your-work MCP server — verification and delegation workflow for Claude
 * Code agents that want a second pass from Codex.
 *
 * Wraps OpenAI Codex CLI to provide:
 *   - code review (`codex review`)
 *   - bounded analysis / planning / debugging (`codex exec`)
 *   - tmux-backed fleet-worker Codex jobs with file-based status
 *
 * Log file: /tmp/check-your-work.log — tail -f to watch progress.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execSync, spawnSync } from "child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { acquireLock, releaseLock } from "../shared/lock-utils.js";

// ── Config ──────────────────────────────────────────────────────────────────

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT =
  process.env.PROJECT_ROOT || resolve(MODULE_DIR, "../../..");
const HOME = process.env.HOME || homedir();
const DEFAULT_CODEX_WRAPPER = join(HOME, ".local", "bin", "codex-wrapper");
const CODEX_BIN =
  process.env.CODEX_BIN ||
  (existsSync(DEFAULT_CODEX_WRAPPER) ? DEFAULT_CODEX_WRAPPER : "codex");
const CODEX_MODEL = process.env.CODEX_MODEL || "gpt-5.4";
const CODEX_REASONING_EFFORT =
  process.env.CODEX_REASONING_EFFORT || "high";
const LOG_FILE = process.env.CHECK_LOG || "/tmp/check-your-work.log";
const CLAUDE_OPS_DIR = process.env.CLAUDE_OPS_DIR || join(HOME, ".claude-ops");
const JOBS_DIR =
  process.env.CHECK_TASKS_DIR ||
  join(CLAUDE_OPS_DIR, "state", "check-your-work", "jobs");
const SWARMS_DIR =
  process.env.CHECK_SWARMS_DIR ||
  join(CLAUDE_OPS_DIR, "state", "check-your-work", "swarms");
const CHECK_ALLOW_MAIN_PROJECT_WRITES =
  process.env.CHECK_ALLOW_MAIN_PROJECT_WRITES === "1";
const REGISTRY_LOCK_DIR = join(CLAUDE_OPS_DIR, "state", "locks", "worker-registry");
const DEFAULT_CODEX_WINDOW = "codex";
const DEFAULT_CODEX_BRIDGE_BASE = join(HOME, ".codex", "claude-bridge-base.md");
const DEFAULT_CODEX_BRIDGE_ACTIVE = join(
  HOME,
  ".codex",
  "generated",
  "claude-bridge-active.md"
);
const SIDECAR_DISALLOWED_TOOLS = [
  "Bash(git checkout main*)",
  "Bash(git merge*)",
  "Bash(git push*)",
  "Bash(git reset --hard*)",
  "Bash(git clean*)",
  "Bash(rm -rf*)",
];

mkdirSync(JOBS_DIR, { recursive: true });
mkdirSync(SWARMS_DIR, { recursive: true });

// ── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  appendFileSync(LOG_FILE, line);
}

function nowIso(): string {
  return new Date().toISOString();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readMaybe(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, "utf-8");
}

function readTrimmedMaybe(path: string): string | undefined {
  const value = readMaybe(path);
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function tailText(text: string | undefined, lineCount = 40): string | undefined {
  if (!text) return undefined;
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-lineCount).join("\n");
}

function truncateText(text: string | undefined, maxChars = 8000): string | undefined {
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

function taskId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sleepMsSync(ms: number) {
  (globalThis as any).Bun.sleepSync(ms);
}

function tmuxAvailable(): boolean {
  const result = spawnSync("tmux", ["-V"], { encoding: "utf-8" });
  return result.status === 0;
}

function runTmux(args: string[]): string {
  const result = spawnSync("tmux", args, {
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "tmux command failed"
    );
  }
  return result.stdout.trim();
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf-8",
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

// Resolve main project root (handles worktrees)
function resolveMainProject(): string {
  const gitPath = join(PROJECT_ROOT, ".git");
  try {
    const content = readFileSync(gitPath, "utf-8").trim();
    if (content.startsWith("gitdir:")) {
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) return match[1].replace(/\/\.git\/worktrees\/.*$/, "");
    }
  } catch {}
  return PROJECT_ROOT;
}
const MAIN_PROJECT = resolveMainProject();
const SESSION_WORKTREE =
  gitOutput(process.cwd(), ["rev-parse", "--show-toplevel"]) || PROJECT_ROOT;
const CURRENT_WORKER_NAME = process.env.WORKER_NAME?.trim() || undefined;
const WORKERS_DIR = join(MAIN_PROJECT, ".claude", "workers");
const REGISTRY_PATH = join(WORKERS_DIR, "registry.json");
const MAIN_MCP_CONFIG = join(MAIN_PROJECT, ".mcp.json");
const LAUNCH_FLAT_WORKER = join(CLAUDE_OPS_DIR, "scripts", "launch-flat-worker.sh");

type CodexProfile =
  | "review"
  | "security_review"
  | "root_cause"
  | "browser_verify"
  | "autonomous_test";

type SwarmTemplate = "review" | "security" | "verification" | "investigation";
type LaunchMode = "tmux-worker";

interface ScopedWorktree {
  worktreeRoot: string;
  branch: string;
  isMainProject: boolean;
}

interface FleetWorkerSpec {
  workerName: string;
  workerDir: string;
  worktreeRoot: string;
  reportTo: string | null;
}

function shouldRegisterInWorkerFleet(worktreeRoot: string): boolean {
  const tooling = detectMcpTooling(worktreeRoot);
  return (
    tooling.hasWorkerFleet ||
    existsSync(REGISTRY_PATH) ||
    existsSync(WORKERS_DIR) ||
    Boolean(CURRENT_WORKER_NAME)
  );
}

function requireFleetTmuxEnvironment(worktreeRoot: string) {
  if (!tmuxAvailable()) {
    throw new Error(
      "tmux is required. Codex tasks now run only as visible worker-fleet workers."
    );
  }
  if (!existsSync(LAUNCH_FLAT_WORKER)) {
    throw new Error(`launch-flat-worker.sh not found: ${LAUNCH_FLAT_WORKER}`);
  }
  if (!shouldRegisterInWorkerFleet(worktreeRoot) || !existsSync(REGISTRY_PATH)) {
    throw new Error(
      `worker-fleet registry is required. Expected registry at ${REGISTRY_PATH}.`
    );
  }
}

interface DetectedTooling {
  mcpServers: string[];
  browserServers: string[];
  hasWorkerFleet: boolean;
}

interface SwarmMemberPlan {
  role: string;
  prompt: string;
  profile: CodexProfile;
}

interface AsyncTaskRecord {
  [key: string]: any;
  task_id: string;
  mode: AsyncMode;
  worktree_root: string;
  profile: CodexProfile;
  fleet_worker_name?: string;
  report_to?: string | null;
  launch?: {
    launch_mode?: LaunchMode;
    locator?: string;
    note?: string;
  };
  status: string;
  pid?: string;
  exit_code?: string;
  started_at?: string;
  finished_at?: string;
  result?: string;
  stdout_tail?: string;
  stderr_tail?: string;
  files: ReturnType<typeof taskFiles>;
}

function parseJsonMaybe<T>(path: string): T | undefined {
  const raw = readMaybe(path);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function withRegistryLocked<T>(fn: (registry: any) => T): T | undefined {
  if (!existsSync(REGISTRY_PATH)) return undefined;

  mkdirSync(dirname(REGISTRY_LOCK_DIR), { recursive: true });
  if (!acquireLock(REGISTRY_LOCK_DIR)) {
    throw new Error("Could not acquire worker-registry lock after 10s");
  }

  try {
    const raw = readMaybe(REGISTRY_PATH);
    const registry = raw ? JSON.parse(raw) : { _config: {} };
    const result = fn(registry);
    writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + "\n");
    return result;
  } finally {
    releaseLock(REGISTRY_LOCK_DIR);
  }
}

function tmuxPaneAlive(paneId: string): boolean {
  if (!paneId || !tmuxAvailable()) return false;
  const result = spawnSync("tmux", ["display-message", "-t", paneId, "-p", "#{pane_id}"], {
    encoding: "utf-8",
    timeout: 3000,
  });
  return result.status === 0 && result.stdout.trim() === paneId;
}

function tmuxPaneCurrentCommand(paneId: string): string | undefined {
  if (!paneId || !tmuxAvailable()) return undefined;
  const result = spawnSync("tmux", ["display-message", "-t", paneId, "-p", "#{pane_current_command}"], {
    encoding: "utf-8",
    timeout: 3000,
  });
  if (result.status !== 0) return undefined;
  return result.stdout.trim() || undefined;
}

function findLaunchPane(): string | undefined {
  const directPane = process.env.TMUX_PANE?.trim();
  if (directPane && tmuxPaneAlive(directPane)) return directPane;
  if (!CURRENT_WORKER_NAME || !existsSync(REGISTRY_PATH)) return undefined;

  try {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    const paneId = registry?.[CURRENT_WORKER_NAME]?.pane_id;
    if (typeof paneId === "string" && tmuxPaneAlive(paneId)) {
      return paneId;
    }
  } catch {}

  return undefined;
}

function collectContextDocs(workspaceRoot: string): string[] {
  const docs: string[] = [];
  const seen = new Set<string>();
  let current = resolve(workspaceRoot);

  while (true) {
    for (const candidate of [
      join(current, "AGENTS.md"),
      join(current, "CLAUDE.md"),
      join(current, ".claude", "CLAUDE.md"),
    ]) {
      if (existsSync(candidate) && !seen.has(candidate)) {
        seen.add(candidate);
        docs.push(candidate);
      }
    }

    if (current === HOME || current === "/") break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return docs;
}

function encodeClaudeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

function findClaudeMemoryDir(worktreeRoot?: string): string | undefined {
  const requested = resolve(worktreeRoot || SESSION_WORKTREE || PROJECT_ROOT);
  const candidates = [
    requested,
    gitOutput(requested, ["rev-parse", "--show-toplevel"]) || requested,
    PROJECT_ROOT,
    MAIN_PROJECT,
  ].map((projectPath) =>
    join(HOME, ".claude", "projects", encodeClaudeProjectPath(projectPath), "memory")
  );

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return undefined;
}

function detectMcpTooling(worktreeRoot: string): DetectedTooling {
  const mcpServers = new Set<string>();

  for (const path of [join(worktreeRoot, ".mcp.json"), MAIN_MCP_CONFIG]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      const entries = parsed?.mcpServers || parsed?.mcp_servers;
      if (entries && typeof entries === "object") {
        for (const name of Object.keys(entries)) {
          if (name) mcpServers.add(name);
        }
      }
    } catch {}
  }

  const mcpServerList = [...mcpServers].sort();
  const browserServers = mcpServerList.filter((name) =>
    /(browser|playwright|chrome|puppeteer)/i.test(name)
  );
  return {
    mcpServers: mcpServerList,
    browserServers,
    hasWorkerFleet: mcpServers.has("worker-fleet"),
  };
}

function loadProjectMcpServers(worktreeRoot: string): Array<{
  name: string;
  config: Record<string, unknown>;
}> {
  const merged = new Map<string, { name: string; config: Record<string, unknown> }>();

  for (const path of [MAIN_MCP_CONFIG, join(worktreeRoot, ".mcp.json")]) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      const entries = parsed?.mcpServers || parsed?.mcp_servers;
      if (!entries || typeof entries !== "object") continue;
      for (const [name, raw] of Object.entries(entries)) {
        if (!name || name === "check-your-work" || !raw || typeof raw !== "object") {
          continue;
        }
        const server = raw as any;
        merged.set(name, {
          name,
          config: JSON.parse(JSON.stringify(server)),
        });
      }
    } catch {}
  }

  return [...merged.values()];
}

function buildExplicitMcpConfigArgs(worktreeRoot: string): string[] {
  const args: string[] = ["-c", "mcp_servers.check-your-work.enabled=false"];
  for (const server of loadProjectMcpServers(worktreeRoot)) {
    args.push("-c", `mcp_servers.${server.name}.enabled=true`);
    for (const [key, value] of Object.entries(server.config)) {
      if (key === "enabled" || value === undefined) continue;
      args.push(
        "-c",
        `mcp_servers.${server.name}.${key}=${JSON.stringify(value)}`
      );
    }
  }
  return args;
}

function resolveScopedWorktree(explicitRoot?: string, writable = false): ScopedWorktree {
  const requested = explicitRoot || PROJECT_ROOT || SESSION_WORKTREE;
  const worktreeRoot =
    gitOutput(requested, ["rev-parse", "--show-toplevel"]) || resolve(requested);
  const isMainProject = resolve(worktreeRoot) === resolve(MAIN_PROJECT);

  if (writable && isMainProject && !CHECK_ALLOW_MAIN_PROJECT_WRITES) {
    throw new Error(
      `Refusing writable Codex task in main project root ${MAIN_PROJECT}. Use a worker worktree or set CHECK_ALLOW_MAIN_PROJECT_WRITES=1.`
    );
  }

  return {
    worktreeRoot,
    branch: gitOutput(worktreeRoot, ["branch", "--show-current"]) || "main",
    isMainProject,
  };
}

function profileUsesWritableSandbox(profile: CodexProfile): boolean {
  return profile === "browser_verify" || profile === "autonomous_test";
}

function profileUsesWebSearch(profile: CodexProfile): boolean {
  return profile === "browser_verify";
}

function sanitizeWorkerName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-")
    .slice(0, 48);
}

function defaultFleetWorkerName(taskIdValue: string): string {
  const parent = sanitizeWorkerName(CURRENT_WORKER_NAME || "operator");
  return sanitizeWorkerName(`codex-${parent}-${taskIdValue.slice(-6)}`);
}

function ensureFleetWorkerFiles(args: {
  workerName: string;
  promptSummary: string;
  worktree: ScopedWorktree;
  profile: CodexProfile;
  reportTo: string | null;
  headful?: boolean;
}): FleetWorkerSpec {
  const workerDir = join(WORKERS_DIR, args.workerName);
  mkdirSync(workerDir, { recursive: true });

  const mission = `# Codex Sidecar Worker

- Runtime: Codex via check-your-work MCP
- Report to: ${args.reportTo || "(none)"}
- Worktree: ${args.worktree.worktreeRoot}
- Branch: ${args.worktree.branch}
- Profile: ${args.profile}
- Scope: Stay inside ${args.worktree.worktreeRoot} unless using worker-fleet messaging/reporting

## Operating rules

- Use the Codex wrapper bridge and project Claude docs before acting.
- Keep changes scoped to the assigned worktree and this worker directory.
- Prefer worker-fleet MCP for replies, handoffs, and coordination.
- Never use mass-destructive git or shell cleanup.

## Current assignment

${args.promptSummary}
`;

  writeFileSync(join(workerDir, "mission.md"), mission.trim() + "\n");
  writeFileSync(join(workerDir, "tasks.json"), "{}\n");
  if (!existsSync(join(workerDir, "inbox.jsonl"))) {
    writeFileSync(join(workerDir, "inbox.jsonl"), "");
  }
  if (!existsSync(join(workerDir, "inbox-cursor.json"))) {
    writeFileSync(
      join(workerDir, "inbox-cursor.json"),
      JSON.stringify({ offset: 0, last_read_at: null, pending_replies: [] }, null, 2) +
        "\n"
    );
  }
  writeFileSync(
    join(workerDir, "permissions.json"),
    JSON.stringify(
      {
        model: CODEX_MODEL,
        permission_mode: args.headful || profileUsesWritableSandbox(args.profile)
          ? "workspace-write"
          : "read-only",
        disallowed_tools: SIDECAR_DISALLOWED_TOOLS,
        runtime: "codex",
        report_to: args.reportTo,
      },
      null,
      2
    ) + "\n"
  );

  if (existsSync(MAIN_MCP_CONFIG) && !existsSync(join(args.worktree.worktreeRoot, ".mcp.json"))) {
    copyFileSync(MAIN_MCP_CONFIG, join(args.worktree.worktreeRoot, ".mcp.json"));
  }

  return {
    workerName: args.workerName,
    workerDir,
    worktreeRoot: args.worktree.worktreeRoot,
    reportTo: args.reportTo,
  };
}

function upsertFleetRegistry(args: {
  workerName: string;
  worktree: ScopedWorktree;
  profile: CodexProfile;
  reportTo: string | null;
  headful?: boolean;
}) {
  const tooling = detectMcpTooling(args.worktree.worktreeRoot);

  withRegistryLocked((registry) => {
    const existing = registry[args.workerName] || {};
    const custom = existing.custom || {};
    registry[args.workerName] = {
      model: existing.model || CODEX_MODEL,
      permission_mode:
        existing.permission_mode ||
        (args.headful || profileUsesWritableSandbox(args.profile)
          ? "workspace-write"
          : "read-only"),
      disallowed_tools: existing.disallowed_tools || SIDECAR_DISALLOWED_TOOLS,
      status: "active",
      perpetual: false,
      sleep_duration: 1800,
      branch: args.worktree.branch,
      worktree: args.worktree.worktreeRoot,
      window: existing.window || DEFAULT_CODEX_WINDOW,
      pane_id: existing.pane_id || null,
      pane_target: existing.pane_target || null,
      tmux_session: existing.tmux_session || registry._config?.tmux_session || "w",
      session_id: existing.session_id || null,
      session_file: existing.session_file || null,
      mission_file: `.claude/workers/${args.workerName}/mission.md`,
      custom: {
        ...custom,
        runtime: "codex",
        launcher: "check-your-work",
        sidecar_for: CURRENT_WORKER_NAME || null,
        profile: args.profile,
        bridge_bin: CODEX_BIN,
        bridge_base: existsSync(DEFAULT_CODEX_BRIDGE_BASE)
          ? DEFAULT_CODEX_BRIDGE_BASE
          : null,
        bridge_active: existsSync(DEFAULT_CODEX_BRIDGE_ACTIVE)
          ? DEFAULT_CODEX_BRIDGE_ACTIVE
          : null,
        task_status: custom.task_status || "queued",
        worktree: args.worktree.worktreeRoot,
        mcp_servers: tooling.mcpServers,
        browser_mcp_servers: tooling.browserServers,
      },
      report_to:
        existing.report_to || args.reportTo || registry._config?.mission_authority || null,
    };
  });
}

function syncFleetWorkerState(args: {
  workerName: string;
  status?: string;
  paneId?: string | null;
  paneTarget?: string | null;
  custom?: Record<string, any>;
}) {
  withRegistryLocked((registry) => {
    const existing = registry[args.workerName];
    if (!existing) return;
    if (args.status) existing.status = args.status;
    if (args.paneId !== undefined) existing.pane_id = args.paneId;
    if (args.paneTarget !== undefined) existing.pane_target = args.paneTarget;
    existing.custom = {
      ...(existing.custom || {}),
      ...(args.custom || {}),
    };
  });
}

function appendWorkerInboxMessage(args: {
  recipient: string;
  from: string;
  summary: string;
  content: string;
}) {
  const inboxPath = join(WORKERS_DIR, args.recipient, "inbox.jsonl");
  if (!existsSync(dirname(inboxPath))) return;

  appendFileSync(
    inboxPath,
    JSON.stringify({
      msg_id: taskId(),
      to: `worker/${args.recipient}`,
      from: `worker/${args.from}`,
      from_name: args.from,
      content: args.content,
      summary: args.summary,
      ack_required: false,
      in_reply_to: null,
      msg_type: "message",
      channel: "check-your-work",
      _ts: nowIso(),
    }) + "\n"
  );
}

function writeSidecarHandoff(workerName: string, content: string) {
  const workerDir = join(WORKERS_DIR, workerName);
  if (!existsSync(workerDir)) return;
  writeFileSync(join(workerDir, "handoff.md"), content.trim() + "\n");
}

const CLAUDE_MEMORY_DIR = findClaudeMemoryDir();

log(`check-your-work MCP server starting`);
log(`PROJECT_ROOT: ${PROJECT_ROOT}`);
log(`SESSION_WORKTREE: ${SESSION_WORKTREE}`);
log(`MAIN_PROJECT: ${MAIN_PROJECT}`);
log(`CODEX_BIN: ${CODEX_BIN}`);
log(`CODEX_MODEL: ${CODEX_MODEL}`);
log(`CODEX_REASONING_EFFORT: ${CODEX_REASONING_EFFORT}`);
log(`JOBS_DIR: ${JOBS_DIR}`);
log(`SWARMS_DIR: ${SWARMS_DIR}`);
if (CLAUDE_MEMORY_DIR) log(`CLAUDE_MEMORY_DIR: ${CLAUDE_MEMORY_DIR}`);
if (existsSync(DEFAULT_CODEX_BRIDGE_ACTIVE)) {
  log(`CODEX_BRIDGE_ACTIVE: ${DEFAULT_CODEX_BRIDGE_ACTIVE}`);
}
log(`Log file: ${LOG_FILE} — tail -f ${LOG_FILE} to watch`);

// ── Context builder ─────────────────────────────────────────────────────────

function buildContextPreamble(args: {
  mode: "review" | "task";
  worktreeRoot?: string;
  profile?: CodexProfile;
  fleetWorker?: FleetWorkerSpec;
}): string {
  const sections: string[] = [];
  const worktreeRoot = args.worktreeRoot || SESSION_WORKTREE;
  const memoryDir = findClaudeMemoryDir(worktreeRoot);
  const contextDocs = collectContextDocs(worktreeRoot);
  const tooling = detectMcpTooling(worktreeRoot);

  const intro =
    args.mode === "review"
      ? `# Verification Context

You are acting as an independent code reviewer / verifier for a project primarily developed using **Claude Code** (Anthropic's CLI agent).`
      : `# Delegation Context

You are Codex acting as an independent specialist for a project primarily developed using **Claude Code** (Anthropic's CLI agent). Treat this as a bounded analysis / planning / debugging task.`;

  sections.push(`${intro}

## Environment
- **Primary IDE**: Claude Code (CLI agent in tmux panes)
- **Active worktree**: ${worktreeRoot}
- **Project root**: ${PROJECT_ROOT}
- **Main project** (if worktree): ${MAIN_PROJECT}
- **Runtime**: Bun + TypeScript
- **Platform**: macOS (darwin)
- **Current worker**: ${args.fleetWorker?.workerName || CURRENT_WORKER_NAME || "(not set)"}
- **Parent worker**: ${args.fleetWorker ? CURRENT_WORKER_NAME || "(none)" : "(same as current)"}
- **Codex bridge**: ${existsSync(DEFAULT_CODEX_BRIDGE_ACTIVE) ? DEFAULT_CODEX_BRIDGE_ACTIVE : DEFAULT_CODEX_BRIDGE_BASE}`);

  if (args.fleetWorker) {
    sections.push(`## Fleet Sidecar
- **Codex worker**: ${args.fleetWorker.workerName}
- **Reports to**: ${args.fleetWorker.reportTo || "(none)"}
- **Worker dir**: \`${args.fleetWorker.workerDir}\`
- **Launcher**: \`${LAUNCH_FLAT_WORKER}\`
- **Bridge binary**: \`${CODEX_BIN}\``);
  }

  sections.push(`## Guardrails
- **Stay inside the assigned worktree.** Never read, write, move, or delete files outside \`${worktreeRoot}\`.
- **Allowed write roots**: \`${worktreeRoot}\`${args.fleetWorker ? ` and \`${args.fleetWorker.workerDir}\`` : ""}
- **Mass-destructive commands are forbidden.** Never run \`git reset --hard\`, \`git clean -fd\`, or broad \`rm -rf\`.
- **Prefer the worker-fleet MCP path.** If worker-fleet tools are available, use them for reporting back rather than inventing side channels.
- **Use the wrapper-provided Claude context.** The Codex launch path already bridged AGENTS/CLAUDE docs and Claude memory for this workspace.`);

  if (args.profile) {
    sections.push(`## Task Profile
- **Profile**: ${args.profile}`);
  }

  sections.push(
    `## Project Instructions
These files contain the project conventions, patterns, and accumulated knowledge. Reference them heavily before forming opinions:

${contextDocs.length > 0 ? contextDocs.map((path) => `- \`${path}\``).join("\n") : "- No AGENTS/CLAUDE docs were discovered in the workspace ancestor chain."}`
  );

  if (memoryDir) {
    sections.push(`## Claude Code Memory
- **Memory directory**: \`${memoryDir}\`
- **Main memory file**: \`${join(memoryDir, "MEMORY.md")}\`
- **Topic memory files**: \`${join(memoryDir, "*.md")}\``);
  }

  if (tooling.mcpServers.length > 0) {
    sections.push(`## MCP Tooling
- **Configured MCP servers**: ${tooling.mcpServers.join(", ")}
- **worker-fleet available**: ${tooling.hasWorkerFleet ? "yes" : "no"}
- **Browser-capable MCP servers**: ${tooling.browserServers.length > 0 ? tooling.browserServers.join(", ") : "(none detected)"}`);
  }

  if (args.mode === "review") {
    sections.push(`## Review Philosophy
- **Extra context is always better.** Read surrounding code, related files, and memory notes before forming opinions. Don't review in isolation.
- **Check against CLAUDE.md patterns.** Security patterns, deploy workflow, UI conventions, and ontology rules are part of the contract.
- **Zero mock data rule.** Any placeholder, dummy, or hardcoded test data is a hard failure.
- **No hardcoded IDs.** Project IDs, tenant IDs, and employee IDs must be resolved dynamically.
- **State explicitly if no findings were discovered.** Mention residual risks or testing gaps.`);
  } else {
    sections.push(`## Task Philosophy
- **Read before answering.** Inspect the repo, project instructions, and related code rather than guessing.
- **Stay concrete.** Prefer root causes, specific risks, precise file references, and actionable next steps.
- **File writes are tightly scoped.** Only make task-required changes inside the assigned worktree, and prefer read-only inspection unless the profile explicitly calls for validation work.`);
  }

  for (const claudeMdPath of contextDocs) {
    if (!/CLAUDE\.md$/.test(claudeMdPath)) continue;
    if (!existsSync(claudeMdPath)) continue;
    try {
      const content = readFileSync(claudeMdPath, "utf-8");
      const securityMatch = content.match(
        /## Security Patterns[\s\S]*?(?=\n## |\n---\n|$)/
      );
      if (securityMatch) {
        sections.push(
          `## Security Patterns (from ${claudeMdPath})\n${securityMatch[0]}`
        );
      }
      const codeMatch = content.match(
        /## Code Patterns[\s\S]*?(?=\n## |\n---\n|$)/
      );
      if (codeMatch) {
        sections.push(`## Code Patterns (from ${claudeMdPath})\n${codeMatch[0]}`);
      }
    } catch {}
  }

  return sections.join("\n\n");
}

function buildReviewPrompt(args: {
  extraInstructions?: string;
  worktreeRoot?: string;
  profile?: CodexProfile;
  fleetWorker?: FleetWorkerSpec;
}): string {
  return [
    buildContextPreamble({
      mode: "review",
      worktreeRoot: args.worktreeRoot,
      profile: args.profile,
      fleetWorker: args.fleetWorker,
    }),
    args.extraInstructions || "",
    "Review thoroughly. Prioritize concrete bugs, regressions, security issues, and missing verification. Flag any violations of the project patterns described above.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildExecPrompt(args: {
  task: string;
  worktreeRoot?: string;
  profile?: CodexProfile;
  fleetWorker?: FleetWorkerSpec;
  enableWebSearch?: boolean;
}): string {
  const worktreeRoot = args.worktreeRoot || SESSION_WORKTREE;
  const tooling = detectMcpTooling(worktreeRoot);
  const profileNotes =
    args.profile === "browser_verify"
      ? `Validate behavior end-to-end. Prefer existing browser automation or lightweight HTTP verification, and use web search only when it materially helps.${tooling.browserServers.length > 0 ? ` Browser MCP servers are configured: ${tooling.browserServers.join(", ")}. Prefer headed/visible browser verification when those tools support it.` : " No browser MCP server was detected, so fall back to HTTP verification or project-local browser automation if present."}`
      : args.profile === "autonomous_test"
        ? "Run focused tests and validation commands when they materially reduce uncertainty. Prefer targeted commands over broad destructive cleanup."
        : args.profile === "security_review"
          ? "Bias heavily toward authentication, authorization, IDOR, secret handling, and data exposure risks."
          : "Stay concrete and root-cause oriented.";

  return [
    buildContextPreamble({
      mode: "task",
      worktreeRoot,
      profile: args.profile,
      fleetWorker: args.fleetWorker,
    }),
    "## Task",
    args.task,
    "## Execution Guidance",
    profileNotes,
    args.enableWebSearch
      ? "Web search has been enabled for this run. Use it sparingly and only for facts that truly require current external verification."
      : "",
    args.fleetWorker?.reportTo
      ? `If worker-fleet messaging is available, send a concise completion note back to ${args.fleetWorker.reportTo}.`
      : "",
    "Read whatever local context you need, then return a concise, high-signal answer.",
  ].join("\n\n");
}

// ── Codex execution helpers ────────────────────────────────────────────────

function buildReviewArgs(args: {
  worktreeRoot?: string;
  commitSha?: string;
  baseBranch?: string;
  title?: string;
  reasoningEffort?: string;
}): string[] {
  const cmdArgs = [
    "-C",
    args.worktreeRoot || SESSION_WORKTREE,
    "review",
    "-c",
    `model="${CODEX_MODEL}"`,
    ...buildExplicitMcpConfigArgs(args.worktreeRoot || SESSION_WORKTREE),
  ];
  cmdArgs.push(
    "-c",
    `model_reasoning_effort="${args.reasoningEffort || CODEX_REASONING_EFFORT}"`
  );

  if (args.commitSha) {
    cmdArgs.push("--commit", args.commitSha);
    if (args.title) cmdArgs.push("--title", args.title);
  } else if (args.baseBranch) {
    cmdArgs.push("--base", args.baseBranch);
  } else {
    cmdArgs.push("--uncommitted");
  }

  cmdArgs.push("-");
  return cmdArgs;
}

function buildExecArgs(args: {
  worktreeRoot?: string;
  reasoningEffort?: string;
  writable?: boolean;
  enableWebSearch?: boolean;
  workerDir?: string;
}): string[] {
  const cmdArgs = [
    "-C",
    args.worktreeRoot || SESSION_WORKTREE,
    "exec",
    "-c",
    `model="${CODEX_MODEL}"`,
    ...buildExplicitMcpConfigArgs(args.worktreeRoot || SESSION_WORKTREE),
    "-c",
    `model_reasoning_effort="${args.reasoningEffort || CODEX_REASONING_EFFORT}"`,
    "-s",
    args.writable ? "workspace-write" : "read-only",
  ];

  if (args.enableWebSearch) {
    cmdArgs.push("--search");
  }
  if (args.workerDir && args.writable) {
    cmdArgs.push("--add-dir", args.workerDir);
  }

  cmdArgs.push("-");
  return cmdArgs;
}

// ── Async task helpers ─────────────────────────────────────────────────────

type AsyncMode =
  | "exec"
  | "review_commit"
  | "review_uncommitted"
  | "review_base";

function jobDir(taskId: string): string {
  return join(JOBS_DIR, taskId);
}

function taskFiles(taskId: string) {
  const dir = jobDir(taskId);
  return {
    dir,
    meta: join(dir, "meta.json"),
    prompt: join(dir, "prompt.txt"),
    status: join(dir, "status.txt"),
    pid: join(dir, "pid.txt"),
    exitCode: join(dir, "exit_code.txt"),
    startedAt: join(dir, "started_at.txt"),
    finishedAt: join(dir, "finished_at.txt"),
    stdout: join(dir, "stdout.log"),
    stderr: join(dir, "stderr.log"),
    result: join(dir, "result.txt"),
    tmux: join(dir, "tmux.txt"),
    runner: join(dir, "run.sh"),
    command: join(dir, "command.txt"),
    notified: join(dir, "notified.txt"),
    finalized: join(dir, "finalized.txt"),
  };
}

function swarmDir(swarmId: string): string {
  return join(SWARMS_DIR, swarmId);
}

function swarmFiles(swarmId: string) {
  const dir = swarmDir(swarmId);
  return {
    dir,
    meta: join(dir, "meta.json"),
    synthesis: join(dir, "synthesis.txt"),
  };
}

function buildAsyncTask(args: {
  mode: AsyncMode;
  prompt: string;
  commitSha?: string;
  baseBranch?: string;
  title?: string;
  reasoningEffort?: string;
  worktreeRoot: string;
  profile: CodexProfile;
  fleetWorker?: FleetWorkerSpec;
  enableWebSearch?: boolean;
}) {
  if (args.mode === "exec") {
    return {
      cmdArgs: buildExecArgs({
        worktreeRoot: args.worktreeRoot,
        reasoningEffort: args.reasoningEffort,
        writable: profileUsesWritableSandbox(args.profile),
        enableWebSearch:
          args.enableWebSearch ?? profileUsesWebSearch(args.profile),
        workerDir: args.fleetWorker?.workerDir,
      }),
      prompt: buildExecPrompt({
        task: args.prompt,
        worktreeRoot: args.worktreeRoot,
        profile: args.profile,
        fleetWorker: args.fleetWorker,
        enableWebSearch:
          args.enableWebSearch ?? profileUsesWebSearch(args.profile),
      }),
      label: "delegated exec task",
    };
  }

  return {
    cmdArgs: buildReviewArgs({
      worktreeRoot: args.worktreeRoot,
      commitSha: args.mode === "review_commit" ? args.commitSha : undefined,
      baseBranch: args.mode === "review_base" ? args.baseBranch : undefined,
      title: args.mode === "review_commit" ? args.title : undefined,
      reasoningEffort: args.reasoningEffort,
    }),
    prompt: buildReviewPrompt({
      extraInstructions: args.prompt,
      worktreeRoot: args.worktreeRoot,
      profile: args.profile,
      fleetWorker: args.fleetWorker,
    }),
    label:
      args.mode === "review_commit"
        ? `commit review ${args.commitSha}`
        : args.mode === "review_base"
          ? `base review ${args.baseBranch}`
          : "uncommitted review",
  };
}

function buildHeadfulPrompt(args: {
  mode: AsyncMode;
  prompt: string;
  commitSha?: string;
  baseBranch?: string;
  title?: string;
  worktreeRoot: string;
  profile: CodexProfile;
  fleetWorker: FleetWorkerSpec;
  files: ReturnType<typeof taskFiles>;
  enableWebSearch?: boolean;
}): string {
  const basePrompt =
    args.mode === "exec"
      ? buildExecPrompt({
          task: args.prompt,
          worktreeRoot: args.worktreeRoot,
          profile: args.profile,
          fleetWorker: args.fleetWorker,
          enableWebSearch:
            args.enableWebSearch ?? profileUsesWebSearch(args.profile),
        })
      : buildReviewPrompt({
          extraInstructions: [
            args.mode === "review_commit"
              ? `Review the changes introduced by commit ${args.commitSha}${args.title ? ` (${args.title})` : ""}.`
              : args.mode === "review_base"
                ? `Review the current changes against base branch ${args.baseBranch}.`
                : "Review the staged, unstaged, and untracked changes in the current worktree.",
            args.prompt,
          ]
            .filter(Boolean)
            .join("\n\n"),
          worktreeRoot: args.worktreeRoot,
          profile: args.profile,
          fleetWorker: args.fleetWorker,
        });

  return [
    basePrompt,
    "## Completion Contract",
    "- This headful sidecar has scoped write access so it can record results and operate inside the assigned worktree. Treat repository files as read-only unless the task explicitly calls for validation edits.",
    `- When you have a meaningful completion update, write the full final answer to \`${args.files.result}\`.`,
    `- Then write either \`done\` or \`failed\` to \`${args.files.status}\`.`,
    `- The job directory \`${args.files.dir}\` is an explicitly allowed infrastructure output path for this task.`,
    `- Keep this Codex session open after recording the result so the user can steer or follow up.`,
    args.fleetWorker.reportTo
      ? `- Send a concise worker-fleet completion note back to ${args.fleetWorker.reportTo} when practical.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function buildHeadfulArgs(args: {
  worktreeRoot: string;
  reasoningEffort?: string;
  writable?: boolean;
  enableWebSearch?: boolean;
  extraWritableDirs?: string[];
}): string[] {
  const cmdArgs = [
    "-C",
    args.worktreeRoot,
    "-c",
    `model="${CODEX_MODEL}"`,
    ...buildExplicitMcpConfigArgs(args.worktreeRoot),
    "-c",
    `model_reasoning_effort="${args.reasoningEffort || CODEX_REASONING_EFFORT}"`,
    "-s",
    "workspace-write",
    "--no-alt-screen",
  ];

  if (args.enableWebSearch) {
    cmdArgs.push("--search");
  }

  for (const dir of args.extraWritableDirs || []) {
    cmdArgs.push("--add-dir", dir);
  }

  return cmdArgs;
}

function tmuxSendText(paneId: string, text: string) {
  const bufferName = `codex-prompt-${Date.now()}`;
  const bufferFile = join(JOBS_DIR, `${bufferName}.txt`);
  writeFileSync(bufferFile, text);
  try {
    spawnSync("tmux", ["load-buffer", "-b", bufferName, bufferFile], {
      encoding: "utf-8",
      timeout: 5000,
    });
    spawnSync("tmux", ["paste-buffer", "-b", bufferName, "-t", paneId, "-d"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    sleepMsSync(300);
    spawnSync("tmux", ["send-keys", "-t", paneId, "-H", "0d"], {
      encoding: "utf-8",
      timeout: 5000,
    });
  } finally {
    try {
      spawnSync("tmux", ["delete-buffer", "-b", bufferName], {
        encoding: "utf-8",
        timeout: 2000,
      });
    } catch {}
    try {
      rmSync(bufferFile, { force: true });
    } catch {}
  }
}

function capturePaneTail(paneId: string, lineCount = 40): string | undefined {
  if (!paneId || !tmuxPaneAlive(paneId)) return undefined;
  const result = spawnSync("tmux", ["capture-pane", "-t", paneId, "-p"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  if (result.status !== 0) return undefined;
  return tailText(result.stdout || "", lineCount);
}

function createHeadfulBootstrapScript(args: {
  taskId: string;
  cmdArgs: string[];
  worktreeRoot: string;
  env?: Record<string, string>;
}): string {
  const files = taskFiles(args.taskId);
  const argsString = args.cmdArgs.map(shellQuote).join(" ");
  const envLines = Object.entries(args.env || {})
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join("\n");

  const script = `#!/usr/bin/env bash
set -euo pipefail

STATUS_FILE=${shellQuote(files.status)}
PID_FILE=${shellQuote(files.pid)}
EXIT_FILE=${shellQuote(files.exitCode)}
STARTED_FILE=${shellQuote(files.startedAt)}
FINISHED_FILE=${shellQuote(files.finishedAt)}
${envLines}

echo "$$" > "$PID_FILE"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$STARTED_FILE"
echo "interactive" > "$STATUS_FILE"

cd ${shellQuote(args.worktreeRoot)}

set +e
${shellQuote(CODEX_BIN)} ${argsString}
code=$?
set -e

echo "$code" > "$EXIT_FILE"
date -u +"%Y-%m-%dT%H:%M:%SZ" > "$FINISHED_FILE"

if [ ! -s "$STATUS_FILE" ] || [ "$(cat "$STATUS_FILE")" = "interactive" ]; then
  if [ "$code" -eq 0 ]; then
    echo "exited" > "$STATUS_FILE"
  else
    echo "failed" > "$STATUS_FILE"
  fi
fi

echo
echo "[check-your-work] Headful Codex session exited in ${args.worktreeRoot}"
echo "[check-your-work] Status: $(cat "$STATUS_FILE")"
exec "\${SHELL:-/bin/zsh}" -l
`;

  writeFileSync(files.runner, script);
  chmodSync(files.runner, 0o755);
  return files.runner;
}

function launchViaWorkerSpawner(args: {
  worker: FleetWorkerSpec;
  runnerScript: string;
}) {
  if (!existsSync(LAUNCH_FLAT_WORKER)) {
    throw new Error(`launch-flat-worker.sh not found: ${LAUNCH_FLAT_WORKER}`);
  }

  const launchArgs = [
    LAUNCH_FLAT_WORKER,
    args.worker.workerName,
    "--project",
    MAIN_PROJECT,
    "--window",
    DEFAULT_CODEX_WINDOW,
    "--worktree",
    args.worker.worktreeRoot,
    "--bootstrap-cmd-file",
    args.runnerScript,
  ];

  const besidePane = findLaunchPane();
  if (besidePane) {
    launchArgs.push("--beside-pane", besidePane);
  }

  const result = spawnSync("bash", launchArgs, {
    cwd: MAIN_PROJECT,
    encoding: "utf-8",
    timeout: 120000,
    env: { ...process.env, PROJECT_ROOT: MAIN_PROJECT },
  });

  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || "launch-flat-worker failed").trim()
    );
  }

  const paneMatch = (result.stdout || "").match(/pane\s+(%\d+)/);
  return {
    launchMode: "tmux-worker" as LaunchMode,
    locator: paneMatch?.[1] || "unknown",
    note: (result.stdout || "").trim() || undefined,
  };
}

function startAsyncTask(args: {
  mode: AsyncMode;
  prompt: string;
  commitSha?: string;
  baseBranch?: string;
  title?: string;
  reasoningEffort?: string;
  worktreeRoot?: string;
  profile?: CodexProfile;
  workerName?: string;
  enableWebSearch?: boolean;
}) {
  const id = taskId();
  const files = taskFiles(id);
  mkdirSync(files.dir, { recursive: true });
  const profile = args.profile || (args.mode === "exec" ? "root_cause" : "review");
  const worktree = resolveScopedWorktree(
    args.worktreeRoot,
    args.mode === "exec" && profileUsesWritableSandbox(profile)
  );
  requireFleetTmuxEnvironment(worktree.worktreeRoot);
  const reportTo = CURRENT_WORKER_NAME || null;
  const tooling = detectMcpTooling(worktree.worktreeRoot);
  const callerPane = findLaunchPane();
  const fleetWorker = ensureFleetWorkerFiles({
    workerName: sanitizeWorkerName(args.workerName || defaultFleetWorkerName(id)),
    promptSummary: args.prompt.slice(0, 2000),
    worktree,
    profile,
    reportTo,
    headful: true,
  });

  upsertFleetRegistry({
    workerName: fleetWorker.workerName,
    worktree,
    profile,
    reportTo,
    headful: true,
  });

  const task = buildAsyncTask({
    mode: args.mode,
    prompt: args.prompt,
    commitSha: args.commitSha,
    baseBranch: args.baseBranch,
    title: args.title,
    reasoningEffort: args.reasoningEffort,
    worktreeRoot: worktree.worktreeRoot,
    profile,
    fleetWorker,
    enableWebSearch: args.enableWebSearch,
  });
  const headfulPrompt =
    buildHeadfulPrompt({
      mode: args.mode,
      prompt: args.prompt,
      commitSha: args.commitSha,
      baseBranch: args.baseBranch,
      title: args.title,
      worktreeRoot: worktree.worktreeRoot,
      profile,
      fleetWorker,
      files,
      enableWebSearch: args.enableWebSearch,
    });
  const headfulCmdArgs = buildHeadfulArgs({
    worktreeRoot: worktree.worktreeRoot,
    reasoningEffort: args.reasoningEffort,
    writable: profileUsesWritableSandbox(profile),
    enableWebSearch:
      args.enableWebSearch ?? profileUsesWebSearch(profile),
    extraWritableDirs: [fleetWorker.workerDir, files.dir],
  });

  writeFileSync(files.prompt, headfulPrompt);
  writeFileSync(
    files.command,
    `${CODEX_BIN} ${headfulCmdArgs.join(" ")}`
  );
  writeFileSync(files.status, "interactive\n");
  writeFileSync(
    files.meta,
    JSON.stringify(
      {
        task_id: id,
        mode: args.mode,
        created_at: nowIso(),
        project_root: PROJECT_ROOT,
        session_worktree: SESSION_WORKTREE,
        main_project: MAIN_PROJECT,
        worktree_root: worktree.worktreeRoot,
        branch: worktree.branch,
        prompt_summary: args.prompt.slice(0, 500),
        commit_sha: args.commitSha,
        base_branch: args.baseBranch,
        title: args.title,
        profile,
        reasoning_effort: args.reasoningEffort || CODEX_REASONING_EFFORT,
        fleet_worker_name: fleetWorker?.workerName,
        report_to: reportTo,
        caller_pane: callerPane || null,
        mcp_servers: tooling.mcpServers,
        browser_mcp_servers: tooling.browserServers,
        label: task.label,
        interactive: true,
      },
      null,
      2
    )
  );

  const runnerEnv = {
    WORKER_NAME: fleetWorker.workerName,
    WORKER_RUNTIME: "codex",
    WORKER_FLEET_LINT: "0",
    PROJECT_ROOT: MAIN_PROJECT,
    CHECK_RESULT_FILE: files.result,
    CHECK_STATUS_FILE: files.status,
  };
  const runnerScript = createHeadfulBootstrapScript({
    taskId: id,
    cmdArgs: headfulCmdArgs,
    worktreeRoot: worktree.worktreeRoot,
    env: runnerEnv,
  });
  const launch = launchViaWorkerSpawner({
    worker: fleetWorker,
    runnerScript,
  });

  syncFleetWorkerState({
    workerName: fleetWorker.workerName,
    status: "active",
    paneId:
      launch.launchMode === "tmux-worker" && launch.locator.startsWith("%")
        ? launch.locator
        : undefined,
    custom: {
      task_id: id,
      task_status: "queued",
      last_launch_mode: launch.launchMode,
      last_locator: launch.locator,
    },
  });

  if (
    launch.launchMode === "tmux-worker" &&
    launch.locator.startsWith("%") &&
    headfulPrompt
  ) {
    const ready = waitForHeadfulCodexReady(launch.locator);
    if (!ready) {
      const paneTail =
        capturePaneTail(launch.locator, 80) ||
        "Headful Codex did not reach an interactive prompt before timeout.";
      writeFileSync(files.status, "failed\n");
      writeFileSync(files.result, paneTail.trim() + "\n");
      syncFleetWorkerState({
        workerName: fleetWorker.workerName,
        status: "idle",
        custom: {
          task_id: id,
          task_status: "failed",
          last_result_file: files.result,
          last_failure: "headful-startup-timeout",
        },
      });
    } else {
      tmuxSendText(launch.locator, headfulPrompt);
      writeFileSync(files.status, "running\n");
      syncFleetWorkerState({
        workerName: fleetWorker.workerName,
        status: "active",
        custom: {
          task_id: id,
          task_status: "running",
        },
      });
    }
  }

  writeFileSync(
    files.tmux,
    JSON.stringify(
      {
        launch_mode: launch.launchMode,
        locator: launch.locator,
        note: launch.note,
      },
      null,
      2
    )
  );

  log(`Started async Codex task ${id} (${args.mode}) via ${launch.launchMode}`);

  return {
    taskId: id,
    launchMode: launch.launchMode,
    locator: launch.locator,
    note: launch.note,
    fleetWorkerName: fleetWorker?.workerName,
    files,
  };
}

function synchronizeAsyncTaskState(task: AsyncTaskRecord): AsyncTaskRecord {
  const workerName = task.fleet_worker_name;
  const finalizedAt =
    task.finished_at ||
    readTrimmedMaybe(task.files.finalized) ||
    (task.status === "done" || task.status === "failed" || task.status === "exited"
      ? nowIso()
      : null);
  if (workerName) {
    syncFleetWorkerState({
      workerName,
      status:
        task.status === "done" || task.status === "failed" || task.status === "exited"
          ? "idle"
          : "active",
      paneId:
        task.launch?.launch_mode === "tmux-worker" &&
        typeof task.launch.locator === "string" &&
        task.launch.locator.startsWith("%")
          ? task.launch.locator
          : undefined,
      custom: {
        task_id: task.task_id,
        task_status: task.status,
        last_exit_code: task.exit_code || null,
        last_finished_at: finalizedAt,
        last_result_file: task.files.result,
        last_launch_mode: task.launch?.launch_mode || null,
        last_locator: task.launch?.locator || null,
      },
    });
  }

  if (
    workerName &&
    (task.status === "done" || task.status === "failed" || task.status === "exited") &&
    !existsSync(task.files.finalized)
  ) {
    const preview = truncateText(
      task.result || task.stderr_tail || task.stdout_tail,
      2000
    ) || "(no output captured)";

    writeSidecarHandoff(
      workerName,
      `# Codex Task Complete

- Task ID: ${task.task_id}
- Status: ${task.status}
- Profile: ${task.profile}
- Worktree: ${task.worktree_root}
- Finished at: ${finalizedAt}
- Exit code: ${task.exit_code || "(unknown)"}

## Summary

${task.prompt_summary || "(no prompt summary)"}

## Result Preview

${preview}`
    );

    if (task.report_to && !existsSync(task.files.notified)) {
      appendWorkerInboxMessage({
        recipient: task.report_to,
        from: workerName,
        summary: `[codex:${workerName}] ${task.status} ${task.profile}`,
        content: [
          `Codex sidecar '${workerName}' finished task ${task.task_id}.`,
          `Status: ${task.status}`,
          `Profile: ${task.profile}`,
          `Worktree: ${task.worktree_root}`,
          `Result file: ${task.files.result}`,
          "",
          preview,
        ].join("\n"),
      });
      writeFileSync(task.files.notified, nowIso() + "\n");
    }

    writeFileSync(task.files.finalized, finalizedAt + "\n");
  }

  return task;
}

function readAsyncTask(taskIdValue: string, logLines = 40): AsyncTaskRecord {
  const files = taskFiles(taskIdValue);
  if (!existsSync(files.meta)) {
    throw new Error(`Unknown task_id: ${taskIdValue}`);
  }

  const meta = JSON.parse(readFileSync(files.meta, "utf-8"));
  const launchInfo = parseJsonMaybe<AsyncTaskRecord["launch"]>(files.tmux);
  const result: AsyncTaskRecord = {
    ...meta,
    status: readTrimmedMaybe(files.status) || "unknown",
    pid: readTrimmedMaybe(files.pid),
    exit_code: readTrimmedMaybe(files.exitCode),
    started_at: readTrimmedMaybe(files.startedAt),
    finished_at: readTrimmedMaybe(files.finishedAt),
    launch: launchInfo,
    result: readMaybe(files.result),
    stdout_tail: tailText(readMaybe(files.stdout), logLines),
    stderr_tail: tailText(readMaybe(files.stderr), logLines),
    pane_tail:
      launchInfo?.launch_mode === "tmux-worker" &&
      typeof launchInfo.locator === "string" &&
      launchInfo.locator.startsWith("%")
        ? capturePaneTail(launchInfo.locator, logLines)
        : undefined,
    files,
  };

  return synchronizeAsyncTaskState(result);
}

async function waitForAsyncTask(args: {
  taskId: string;
  timeoutMs?: number;
  pollMs?: number;
  logLines?: number;
}) {
  const timeout = args.timeoutMs || 300000;
  const pollMs = args.pollMs || 2000;
  const started = Date.now();

  while (true) {
    const status = readAsyncTask(args.taskId, args.logLines);
    if (
      status.status === "done" ||
      status.status === "failed" ||
      status.status === "exited"
    ) {
      return status;
    }
    if (Date.now() - started > timeout) {
      throw new Error(
        `Timed out waiting for task ${args.taskId} after ${Math.round(timeout / 1000)}s`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function extractTaskResultText(task: AsyncTaskRecord): string {
  return (
    task.result?.trim() ||
    task.pane_tail?.trim() ||
    task.stdout_tail?.trim() ||
    task.stderr_tail?.trim() ||
    "(No output from Codex)"
  );
}

function waitForHeadfulCodexReady(paneId: string, timeoutMs = 15_000): boolean {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const paneText = capturePaneTail(paneId, 120) || "";
    const currentCommand = tmuxPaneCurrentCommand(paneId);
    if (
      currentCommand === "codex" ||
      paneText.includes("OpenAI Codex") ||
      paneText.includes("provider: openai") ||
      paneText.includes("session id:")
    ) {
      return true;
    }
    if (currentCommand && currentCommand !== "bash" && currentCommand !== "zsh") {
      return false;
    }
    sleepMsSync(250);
  }
  return false;
}

function buildDefaultSwarmPlans(args: {
  template: SwarmTemplate;
  prompt: string;
}): SwarmMemberPlan[] {
  if (args.template === "security") {
    return [
      {
        role: "security",
        profile: "security_review",
        prompt: `${args.prompt}\n\nFocus on authentication, authorization, tenant/project ownership, IDOR, secrets, logging exposure, and unsafe trust boundaries.`,
      },
      {
        role: "data-exposure",
        profile: "review",
        prompt: `${args.prompt}\n\nFocus on PII exposure, unsafe API responses, error leakage, overly broad queries, and logging/privacy regressions.`,
      },
      {
        role: "reproduction",
        profile: "autonomous_test",
        prompt: `${args.prompt}\n\nTry to reproduce or falsify the most plausible security issues with targeted local checks, requests, or tests. Keep changes minimal and scoped.`,
      },
    ];
  }

  if (args.template === "verification") {
    return [
      {
        role: "browser",
        profile: "browser_verify",
        prompt: `${args.prompt}\n\nValidate the behavior end-to-end through the browser path when possible. Prefer visible/headed browser verification via configured MCP tools.`,
      },
      {
        role: "tests",
        profile: "autonomous_test",
        prompt: `${args.prompt}\n\nRun the smallest targeted tests or commands needed to verify behavior and surface regressions.`,
      },
      {
        role: "consistency",
        profile: "review",
        prompt: `${args.prompt}\n\nCross-check implementation, docs, API contracts, and obvious edge cases for mismatches.`,
      },
    ];
  }

  if (args.template === "investigation") {
    return [
      {
        role: "root-cause",
        profile: "root_cause",
        prompt: `${args.prompt}\n\nBuild the most likely root-cause explanation from code and runtime evidence. State assumptions clearly.`,
      },
      {
        role: "validation",
        profile: "autonomous_test",
        prompt: `${args.prompt}\n\nRun focused validation commands to confirm or falsify the leading hypotheses.`,
      },
      {
        role: "change-risk",
        profile: "review",
        prompt: `${args.prompt}\n\nFocus on likely fix strategy, blast radius, regression risk, and required follow-up verification.`,
      },
    ];
  }

  return [
    {
      role: "security",
      profile: "security_review",
      prompt: `${args.prompt}\n\nReview with strong emphasis on auth, ownership checks, secrets, privacy, and high-severity risks.`,
    },
    {
      role: "regression",
      profile: "review",
      prompt: `${args.prompt}\n\nReview for bugs, regressions, broken assumptions, and missing tests.`,
    },
    {
      role: "verification",
      profile: "autonomous_test",
      prompt: `${args.prompt}\n\nRun focused verification commands or tests to confirm or refute the likely issues. Avoid broad or destructive cleanup.`,
    },
  ];
}

function parseCustomSwarmPlans(json?: string): SwarmMemberPlan[] | undefined {
  if (!json) return undefined;

  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("roles_json must be a non-empty JSON array");
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`roles_json[${index}] must be an object`);
    }
    if (!entry.name || typeof entry.name !== "string") {
      throw new Error(`roles_json[${index}].name must be a string`);
    }
    if (!entry.prompt || typeof entry.prompt !== "string") {
      throw new Error(`roles_json[${index}].prompt must be a string`);
    }
    const profile = entry.profile || "root_cause";
    if (
      !["review", "security_review", "root_cause", "browser_verify", "autonomous_test"].includes(
        profile
      )
    ) {
      throw new Error(
        `roles_json[${index}].profile must be one of review, security_review, root_cause, browser_verify, autonomous_test`
      );
    }
    return {
      role: entry.name,
      prompt: entry.prompt,
      profile,
    } as SwarmMemberPlan;
  });
}

function startCodexSwarm(args: {
  prompt: string;
  template: SwarmTemplate;
  rolesJson?: string;
  worktreeRoot?: string;
  reasoningEffort?: string;
  workerNamePrefix?: string;
  enableWebSearch?: boolean;
}) {
  const id = `swarm-${taskId()}`;
  const files = swarmFiles(id);
  mkdirSync(files.dir, { recursive: true });

  const plans =
    parseCustomSwarmPlans(args.rolesJson) ||
    buildDefaultSwarmPlans({
      template: args.template,
      prompt: args.prompt,
    });
  const worktree = resolveScopedWorktree(
    args.worktreeRoot,
    plans.some((plan) => profileUsesWritableSandbox(plan.profile))
  );
  const prefix = sanitizeWorkerName(
    args.workerNamePrefix || `codex-${CURRENT_WORKER_NAME || "operator"}-${id.slice(-5)}`
  );

  const members = plans.map((plan, index) => {
    const started = startAsyncTask({
      mode: "exec",
      prompt: plan.prompt,
      reasoningEffort: args.reasoningEffort,
      worktreeRoot: worktree.worktreeRoot,
      profile: plan.profile,
      workerName: sanitizeWorkerName(`${prefix}-${plan.role || `agent-${index + 1}`}`),
      enableWebSearch: args.enableWebSearch,
    });

    return {
      role: plan.role,
      profile: plan.profile,
      prompt_summary: plan.prompt.slice(0, 300),
      task_id: started.taskId,
      worker_name: started.fleetWorkerName,
      launch_mode: started.launchMode,
      locator: started.locator,
    };
  });

  writeFileSync(
    files.meta,
    JSON.stringify(
      {
        swarm_id: id,
        created_at: nowIso(),
        template: args.rolesJson ? "custom" : args.template,
        prompt_summary: args.prompt.slice(0, 500),
        project_root: PROJECT_ROOT,
        session_worktree: SESSION_WORKTREE,
        main_project: MAIN_PROJECT,
        worktree_root: worktree.worktreeRoot,
        branch: worktree.branch,
        worker_name_prefix: prefix,
        enable_web_search: args.enableWebSearch ?? false,
        members,
      },
      null,
      2
    )
  );

  return {
    swarmId: id,
    files,
    members,
  };
}

function readCodexSwarm(swarmIdValue: string, logLines = 20) {
  const files = swarmFiles(swarmIdValue);
  if (!existsSync(files.meta)) {
    throw new Error(`Unknown swarm_id: ${swarmIdValue}`);
  }

  const meta = JSON.parse(readFileSync(files.meta, "utf-8"));
  const members = (meta.members || []).map((member: any) => ({
    ...member,
    task: readAsyncTask(member.task_id, logLines),
  }));

  return {
    ...meta,
    members,
    synthesis: readMaybe(files.synthesis),
    files,
  };
}

async function synthesizeCodexSwarm(args: {
  swarm: ReturnType<typeof readCodexSwarm>;
  timeoutMs?: number;
}) {
  const synthesisFiles = swarmFiles(args.swarm.swarm_id);
  const existing = readMaybe(synthesisFiles.synthesis);
  if (existing) return existing;
  const meta = JSON.parse(readFileSync(synthesisFiles.meta, "utf-8"));
  if (meta.synthesis_task_id) {
    const prior = await waitForAsyncTask({
      taskId: meta.synthesis_task_id,
      timeoutMs: args.timeoutMs,
      logLines: 40,
    });
    if (prior.status === "failed") {
      throw new Error(extractTaskResultText(prior));
    }
    const priorText = extractTaskResultText(prior);
    writeFileSync(synthesisFiles.synthesis, priorText);
    return priorText;
  }

  const memberSections = args.swarm.members
    .map((member: any) => {
      const task: AsyncTaskRecord = member.task;
      return [
        `## ${member.role} (${member.profile}, task ${member.task_id}, status ${task.status})`,
        truncateText(task.result || task.stderr_tail || task.stdout_tail, 6000) ||
          "(no output)",
      ].join("\n\n");
    })
    .join("\n\n");

  const synthesisPrompt = [
    "Synthesize the outputs from a Codex swarm.",
    `Original request:\n${args.swarm.prompt_summary}`,
    `Template: ${args.swarm.template}`,
    "Tasks were run independently in the same worktree. Deduplicate findings, call out disagreements, rank the issues by severity, and state if no concrete issues were found.",
    memberSections,
  ].join("\n\n");

  const started = startAsyncTask({
    mode: "exec",
    prompt: synthesisPrompt,
    worktreeRoot: args.swarm.worktree_root,
    profile:
      args.swarm.template === "security" ? "security_review" : "review",
    workerName: sanitizeWorkerName(`${args.swarm.worker_name_prefix}-synthesis`),
  });
  meta.synthesis_task_id = started.taskId;
  meta.synthesis_worker_name = started.fleetWorkerName || null;
  writeFileSync(synthesisFiles.meta, JSON.stringify(meta, null, 2) + "\n");

  const synthesisTask = await waitForAsyncTask({
    taskId: started.taskId,
    timeoutMs: args.timeoutMs,
    logLines: 40,
  });
  if (synthesisTask.status === "failed") {
    throw new Error(extractTaskResultText(synthesisTask));
  }
  const synthesis = extractTaskResultText(synthesisTask);

  writeFileSync(synthesisFiles.synthesis, synthesis);
  return synthesis;
}

async function waitForCodexSwarm(args: {
  swarmId: string;
  timeoutMs?: number;
  pollMs?: number;
  logLines?: number;
  synthesize?: boolean;
  synthesisTimeoutMs?: number;
}) {
  const timeout = args.timeoutMs || 600000;
  const pollMs = args.pollMs || 2000;
  const started = Date.now();

  while (true) {
    const swarm = readCodexSwarm(args.swarmId, args.logLines);
    const allFinished = swarm.members.every((member: any) =>
      ["done", "failed", "exited"].includes(member.task.status)
    );

    if (allFinished) {
      if (args.synthesize !== false) {
        const synthesis = await synthesizeCodexSwarm({
          swarm,
          timeoutMs: args.synthesisTimeoutMs,
        });
        return {
          ...swarm,
          synthesis,
        };
      }
      return swarm;
    }

    if (Date.now() - started > timeout) {
      throw new Error(
        `Timed out waiting for swarm ${args.swarmId} after ${Math.round(timeout / 1000)}s`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function formatTaskStatus(task: ReturnType<typeof readAsyncTask>): string {
  return JSON.stringify(task, null, 2);
}

function formatStartedTaskText(args: {
  started: ReturnType<typeof startAsyncTask>;
  summary: string;
  includeGetHint?: boolean;
}): string {
  return [
    args.summary,
    `task_id: ${args.started.taskId}`,
    `launch: ${args.started.launchMode} (${args.started.locator})`,
    args.started.fleetWorkerName ? `worker: ${args.started.fleetWorkerName}` : "",
    args.started.note ? `note: ${args.started.note}` : "",
    `result file: ${args.started.files.result}`,
    `status file: ${args.started.files.status}`,
    "completion: worker-fleet inbox message will be sent on completion when report_to is configured",
    args.includeGetHint === false
      ? ""
      : `inspect: get_codex_task(task_id="${args.started.taskId}")`,
  ]
    .filter(Boolean)
    .join("\n");
}

// ── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "check-your-work",
  version: "1.2.0",
});

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "check_commit",
  {
    description:
      "Spawn an async commit review as a visible tmux Codex fleet worker. Completion is delivered back through worker-fleet messaging.",
    inputSchema: {
      commit_sha: z.string().describe("Git commit SHA to review"),
      worktree_root: z
        .string()
        .optional()
        .describe("Optional worktree/repo root to run the review in (defaults to current session worktree)"),
      focus: z
        .string()
        .optional()
        .describe(
          "What to focus on in the review (e.g. 'security', 'ownership checks', 'verify BI query source')"
        ),
      worker_name: z
        .string()
        .optional()
        .describe("Optional fleet worker name for this Codex reviewer"),
      reasoning_effort: z
        .string()
        .optional()
        .describe("Optional Codex reasoning effort override, e.g. medium, high, xhigh"),
    },
  },
  async ({
    commit_sha,
    worktree_root,
    focus,
    worker_name,
    reasoning_effort,
  }: {
    commit_sha: string;
    worktree_root?: string;
    focus?: string;
    worker_name?: string;
    reasoning_effort?: string;
  }) => {
    try {
      const worktree = resolveScopedWorktree(worktree_root, false);
      let commitTitle: string | undefined;
      try {
        commitTitle = execSync(`git log --format='%s' -1 ${commit_sha}`, {
          encoding: "utf-8",
          cwd: worktree.worktreeRoot,
        }).trim();
      } catch {}

      log(`Tool call: check_commit(${commit_sha})`);
      const started = startAsyncTask({
        mode: "review_commit",
        worktreeRoot: worktree.worktreeRoot,
        commitSha: commit_sha,
        prompt: focus || "",
        profile: "review",
        title: commitTitle,
        reasoningEffort: reasoning_effort,
        workerName: worker_name,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: formatStartedTaskText({
              started,
              summary: `Spawned async commit review for ${commit_sha}.`,
            }),
          },
        ],
      };
    } catch (e: any) {
      const msg = `Commit review failed: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "check_uncommitted",
  {
    description:
      "Spawn an async review of staged, unstaged, and untracked changes as a visible tmux Codex fleet worker.",
    inputSchema: {
      worktree_root: z
        .string()
        .optional()
        .describe("Optional worktree/repo root to run the review in (defaults to current session worktree)"),
      focus: z
        .string()
        .optional()
        .describe("Optional review focus, e.g. 'security', 'regression risk', 'missing tests'"),
      worker_name: z
        .string()
        .optional()
        .describe("Optional fleet worker name for this Codex reviewer"),
      reasoning_effort: z
        .string()
        .optional()
        .describe("Optional Codex reasoning effort override, e.g. medium, high, xhigh"),
    },
  },
  async ({
    worktree_root,
    focus,
    worker_name,
    reasoning_effort,
  }: {
    worktree_root?: string;
    focus?: string;
    worker_name?: string;
    reasoning_effort?: string;
  }) => {
    try {
      const worktree = resolveScopedWorktree(worktree_root, false);
      log(`Tool call: check_uncommitted()`);
      const started = startAsyncTask({
        mode: "review_uncommitted",
        worktreeRoot: worktree.worktreeRoot,
        prompt: focus || "",
        profile: "review",
        reasoningEffort: reasoning_effort,
        workerName: worker_name,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: formatStartedTaskText({
              started,
              summary: "Spawned async review for uncommitted changes.",
            }),
          },
        ],
      };
    } catch (e: any) {
      const msg = `Uncommitted review failed: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "check_base",
  {
    description:
      "Spawn an async review of current changes against a base branch using a visible tmux Codex fleet worker.",
    inputSchema: {
      base_branch: z.string().describe("Base branch to review against, e.g. main"),
      worktree_root: z
        .string()
        .optional()
        .describe("Optional worktree/repo root to run the review in (defaults to current session worktree)"),
      focus: z
        .string()
        .optional()
        .describe("Optional review focus, e.g. 'security', 'regression risk', 'missing tests'"),
      worker_name: z
        .string()
        .optional()
        .describe("Optional fleet worker name for this Codex reviewer"),
      reasoning_effort: z
        .string()
        .optional()
        .describe("Optional Codex reasoning effort override, e.g. medium, high, xhigh"),
    },
  },
  async ({
    base_branch,
    worktree_root,
    focus,
    worker_name,
    reasoning_effort,
  }: {
    base_branch: string;
    worktree_root?: string;
    focus?: string;
    worker_name?: string;
    reasoning_effort?: string;
  }) => {
    try {
      const worktree = resolveScopedWorktree(worktree_root, false);
      log(`Tool call: check_base(${base_branch})`);
      const started = startAsyncTask({
        mode: "review_base",
        worktreeRoot: worktree.worktreeRoot,
        baseBranch: base_branch,
        prompt: focus || "",
        profile: "review",
        reasoningEffort: reasoning_effort,
        workerName: worker_name,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: formatStartedTaskText({
              started,
              summary: `Spawned async review against base branch ${base_branch}.`,
            }),
          },
        ],
      };
    } catch (e: any) {
      const msg = `Base review failed: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "ask_codex",
  {
    description:
      "Spawn an async Codex specialist as a visible tmux fleet worker for debugging, architecture questions, root-cause analysis, browser verification, or autonomous testing.",
    inputSchema: {
      task: z.string().describe("The delegated task or question for Codex"),
      worktree_root: z
        .string()
        .optional()
        .describe("Optional worktree/repo root for the task (defaults to current session worktree)"),
      profile: z
        .enum(["review", "security_review", "root_cause", "browser_verify", "autonomous_test"])
        .optional()
        .describe("Task profile: review, security_review, root_cause, browser_verify, autonomous_test"),
      enable_web_search: z
        .boolean()
        .optional()
        .describe("Enable Codex web search for this task"),
      worker_name: z
        .string()
        .optional()
        .describe("Optional fleet worker name for this Codex specialist"),
      reasoning_effort: z
        .string()
        .optional()
        .describe("Optional Codex reasoning effort override, e.g. medium, high, xhigh"),
    },
  },
  async ({
    task,
    worktree_root,
    profile,
    enable_web_search,
    worker_name,
    reasoning_effort,
  }: {
    task: string;
    worktree_root?: string;
    profile?: CodexProfile;
    enable_web_search?: boolean;
    worker_name?: string;
    reasoning_effort?: string;
  }) => {
    try {
      const selectedProfile = profile || "root_cause";
      const worktree = resolveScopedWorktree(
        worktree_root,
        profileUsesWritableSandbox(selectedProfile)
      );
      log(`Tool call: ask_codex(...)`);
      const started = startAsyncTask({
        mode: "exec",
        prompt: task,
        worktreeRoot: worktree.worktreeRoot,
        reasoningEffort: reasoning_effort,
        profile: selectedProfile,
        enableWebSearch: enable_web_search,
        workerName: worker_name,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: formatStartedTaskText({
              started,
              summary: `Spawned async Codex ${selectedProfile} task.`,
            }),
          },
        ],
      };
    } catch (e: any) {
      const msg = `Delegated Codex task failed: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "spawn_codex_task",
  {
    description:
      "Start a long-running Codex task asynchronously as a visible tmux worker-fleet sidecar.",
    inputSchema: {
      mode: z
        .enum(["exec", "review_commit", "review_uncommitted", "review_base"])
        .describe("What kind of Codex task to start"),
      prompt: z
        .string()
        .describe("Task prompt for exec, or extra review instructions for review modes"),
      commit_sha: z
        .string()
        .optional()
        .describe("Required when mode=review_commit"),
      base_branch: z
        .string()
        .optional()
        .describe("Required when mode=review_base"),
      title: z
        .string()
        .optional()
        .describe("Optional title when mode=review_commit"),
      worktree_root: z
        .string()
        .optional()
        .describe("Optional worktree/repo root for the task (defaults to current session worktree)"),
      profile: z
        .enum(["review", "security_review", "root_cause", "browser_verify", "autonomous_test"])
        .optional()
        .describe("Execution profile. For review modes, use review/security_review. For exec, root_cause/browser_verify/autonomous_test are typical."),
      worker_name: z
        .string()
        .optional()
        .describe("Optional fleet worker name for visible tmux launches"),
      reasoning_effort: z
        .string()
        .optional()
        .describe("Optional Codex reasoning effort override, e.g. medium, high, xhigh"),
      enable_web_search: z
        .boolean()
        .optional()
        .describe("Enable Codex web search for this task"),
    },
  },
  async ({
    mode,
    prompt,
    commit_sha,
    base_branch,
    title,
    worktree_root,
    profile,
    worker_name,
    reasoning_effort,
    enable_web_search,
  }: {
    mode: AsyncMode;
    prompt: string;
    commit_sha?: string;
    base_branch?: string;
    title?: string;
    worktree_root?: string;
    profile?: CodexProfile;
    worker_name?: string;
    reasoning_effort?: string;
    enable_web_search?: boolean;
  }) => {
    try {
      if (mode === "review_commit" && !commit_sha) {
        throw new Error("commit_sha is required when mode=review_commit");
      }
      if (mode === "review_base" && !base_branch) {
        throw new Error("base_branch is required when mode=review_base");
      }

      log(`Tool call: spawn_codex_task(${mode})`);
      const started = startAsyncTask({
        mode,
        prompt,
        commitSha: commit_sha,
        baseBranch: base_branch,
        title,
        reasoningEffort: reasoning_effort,
        worktreeRoot: worktree_root,
        profile,
        workerName: worker_name,
        enableWebSearch: enable_web_search,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatStartedTaskText({
              started,
              summary: `Spawned async Codex task in mode ${mode}.`,
            }),
          },
        ],
      };
    } catch (e: any) {
      const msg = `Failed to start Codex task: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "spawn_codex_swarm",
  {
    description:
      "Launch a coordinated multi-agent Codex swarm in the same worktree. Each member is a visible tmux worker-fleet sidecar.",
    inputSchema: {
      prompt: z.string().describe("Shared request or review assignment for the swarm"),
      template: z
        .enum(["review", "security", "verification", "investigation"])
        .optional()
        .describe("Swarm template. review is the default."),
      roles_json: z
        .string()
        .optional()
        .describe(
          "Optional JSON array of custom roles: [{\"name\":\"security\",\"profile\":\"security_review\",\"prompt\":\"...\"}]"
        ),
      worktree_root: z
        .string()
        .optional()
        .describe("Optional worktree/repo root for the swarm (defaults to current session worktree)"),
      reasoning_effort: z
        .string()
        .optional()
        .describe("Optional Codex reasoning effort override for all members"),
      worker_name_prefix: z
        .string()
        .optional()
        .describe("Optional fleet worker name prefix for swarm members"),
      enable_web_search: z
        .boolean()
        .optional()
        .describe("Enable Codex web search for all swarm members"),
    },
  },
  async ({
    prompt,
    template,
    roles_json,
    worktree_root,
    reasoning_effort,
    worker_name_prefix,
    enable_web_search,
  }: {
    prompt: string;
    template?: SwarmTemplate;
    roles_json?: string;
    worktree_root?: string;
    reasoning_effort?: string;
    worker_name_prefix?: string;
    enable_web_search?: boolean;
  }) => {
    try {
      log(`Tool call: spawn_codex_swarm(${template || "review"})`);
      const swarm = startCodexSwarm({
        prompt,
        template: template || "review",
        rolesJson: roles_json,
        worktreeRoot: worktree_root,
        reasoningEffort: reasoning_effort,
        workerNamePrefix: worker_name_prefix,
        enableWebSearch: enable_web_search,
      });

      const text = [
        `Started Codex swarm \`${swarm.swarmId}\`.`,
        ...swarm.members.map(
          (member) =>
            `- ${member.role}: task=${member.task_id}, launch=${member.launch_mode} (${member.locator})`
        ),
        "completion: members report back through worker-fleet messaging when report_to is configured",
        `inspect: get_codex_swarm(swarm_id="${swarm.swarmId}")`,
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) {
      const msg = `Failed to start Codex swarm: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "get_codex_swarm",
  {
    description:
      "Read the status of all members in a previously spawned Codex swarm, plus any synthesized result if available.",
    inputSchema: {
      swarm_id: z.string().describe("Swarm id returned by spawn_codex_swarm"),
      log_lines: z
        .number()
        .optional()
        .describe("How many lines of task/pane tail to include per member (default: 20)"),
    },
  },
  async ({
    swarm_id,
    log_lines,
  }: {
    swarm_id: string;
    log_lines?: number;
  }) => {
    try {
      log(`Tool call: get_codex_swarm(${swarm_id})`);
      const swarm = readCodexSwarm(swarm_id, log_lines);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(swarm, null, 2) }],
      };
    } catch (e: any) {
      const msg = `Failed to read Codex swarm: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "get_codex_task",
  {
    description:
      "Read status, output, and recent logs for a previously spawned async Codex task.",
    inputSchema: {
      task_id: z.string().describe("Task id returned by spawn_codex_task"),
      log_lines: z
        .number()
        .optional()
        .describe("How many lines of stdout/stderr tail to include (default: 40)"),
    },
  },
  async ({
    task_id,
    log_lines,
  }: {
    task_id: string;
    log_lines?: number;
  }) => {
    try {
      log(`Tool call: get_codex_task(${task_id})`);
      const task = readAsyncTask(task_id, log_lines);
      return {
        content: [{ type: "text" as const, text: formatTaskStatus(task) }],
      };
    } catch (e: any) {
      const msg = `Failed to read Codex task: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

// @ts-ignore — MCP SDK deep type instantiation with Zod
server.registerTool(
  "deep_review",
  {
    description:
      "Launch a Bugbot-style multi-pass code review pipeline. Creates a 'bug-bot' tmux window with 8 parallel Opus review workers + 1 Sonnet coordinator. Workers review the diff with randomized chunk ordering; coordinator aggregates via majority voting (>=2/8), validates, dedupes against history, and applies fixes. Default: reviews the current HEAD commit.",
    inputSchema: {
      commit: z
        .string()
        .optional()
        .describe(
          "Specific commit SHA to review. Default: HEAD (current commit)"
        ),
      base_branch: z
        .string()
        .optional()
        .describe(
          "Review all changes since this branch (e.g. 'main'). Overrides commit."
        ),
      uncommitted: z
        .boolean()
        .optional()
        .describe(
          "Review staged + unstaged + untracked changes. Overrides commit and base_branch."
        ),
      pr_number: z
        .string()
        .optional()
        .describe(
          "Review a pull request by number (uses gh pr diff). Overrides other modes."
        ),
      passes: z
        .number()
        .optional()
        .describe("Number of parallel review passes (default: 8)"),
      worktree_root: z
        .string()
        .optional()
        .describe(
          "Optional repo root to run the review in (defaults to current session worktree)"
        ),
    },
  },
  async ({
    commit,
    base_branch,
    uncommitted,
    pr_number,
    passes,
    worktree_root,
  }: {
    commit?: string;
    base_branch?: string;
    uncommitted?: boolean;
    pr_number?: string;
    passes?: number;
    worktree_root?: string;
  }) => {
    try {
      log(`Tool call: deep_review(commit=${commit || "HEAD"}, base=${base_branch || "-"}, uncommitted=${uncommitted || false}, pr=${pr_number || "-"})`);

      const worktree = resolveScopedWorktree(worktree_root, false);
      const scriptPath = join(CLAUDE_OPS_DIR, "scripts", "deep-review.sh");

      if (!existsSync(scriptPath)) {
        throw new Error(`deep-review.sh not found at ${scriptPath}`);
      }

      // Build args — default to --commit HEAD
      const args: string[] = [];
      if (pr_number) {
        args.push("--pr", pr_number);
      } else if (uncommitted) {
        args.push("--uncommitted");
      } else if (base_branch) {
        args.push("--base", base_branch);
      } else {
        // Default: review current HEAD commit
        const headSha = execSync("git rev-parse HEAD", {
          encoding: "utf-8",
          cwd: worktree.worktreeRoot,
        }).trim();
        args.push("--commit", headSha);
      }

      if (passes) {
        args.push("--passes", String(passes));
      }

      // Detect tmux session from environment
      const tmuxSession =
        process.env.TMUX_SESSION ||
        (() => {
          try {
            return execSync(
              "tmux display-message -p '#{session_name}'",
              { encoding: "utf-8" }
            ).trim();
          } catch {
            return "h";
          }
        })();

      // Launch deep-review.sh asynchronously (it creates its own tmux window)
      const env = {
        ...process.env,
        PROJECT_ROOT: worktree.worktreeRoot,
        TMUX_SESSION: tmuxSession,
      };

      const launchResult = spawnSync("bash", [scriptPath, ...args], {
        encoding: "utf-8",
        cwd: worktree.worktreeRoot,
        env,
        timeout: 60_000, // 60s for setup (workers launch async)
      });

      if (launchResult.status !== 0) {
        const stderr = launchResult.stderr?.slice(0, 1000) || "";
        throw new Error(`deep-review.sh failed (exit ${launchResult.status}): ${stderr}`);
      }

      const stdout = launchResult.stdout || "";

      // Extract session directory from output
      const sessionMatch = stdout.match(/Session:\s+(\S+)/);
      const sessionDir = sessionMatch ? sessionMatch[1] : "unknown";

      const text = [
        `Deep review pipeline launched.`,
        ``,
        `Window: ${tmuxSession}:bug-bot (9 panes)`,
        `Session: ${sessionDir}`,
        `Passes: ${passes || 8} workers (Opus, xhigh effort)`,
        `Coordinator: pane 0 (Sonnet, medium effort)`,
        ``,
        `Pipeline: 8 parallel passes -> bucket -> majority vote (>=2/8) -> validate -> dedup -> autofix -> report`,
        ``,
        `The coordinator will write the final report to: ${sessionDir}/report.md`,
        `Monitor progress by switching to the bug-bot tmux window.`,
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    } catch (e: any) {
      const msg = `Deep review launch failed: ${e.message?.slice(0, 500) || String(e)}`;
      log(`ERROR: ${msg}`);
      return {
        content: [{ type: "text" as const, text: msg }],
        isError: true,
      };
    }
  }
);

log(
  `Server ready — 9 tools registered: check_commit, check_uncommitted, check_base, ask_codex, spawn_codex_task, spawn_codex_swarm, get_codex_swarm, get_codex_task, deep_review`
);

// Start
const transport = new StdioServerTransport();
await server.connect(transport);
