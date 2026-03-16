/**
 * Canonical type definitions shared between CLI and MCP server.
 * Single source of truth — both `cli/lib/config.ts` and `mcp/worker-fleet/index.ts`
 * import from here.
 */

export interface WorkerConfig {
  model: string;
  /** Runtime: "claude" (default), "codex", "sdk" (Agent SDK), or "custom" */
  runtime?: "claude" | "codex" | "sdk" | "custom";
  /** Custom launch command (only used when runtime is "custom") */
  customLauncher?: string;
  reasoning_effort: string;
  permission_mode: string;
  sleep_duration: number | null;
  window: string | null;
  worktree: string;
  branch: string;
  mcp: Record<string, unknown>;
  hooks: SystemHook[];
  /** Ephemeral workers skip watchdog respawn and are auto-cleaned after completion (e.g. deep-review workers) */
  ephemeral?: boolean;
  /** Expected CronCreate calls — Stop hook blocks until all are registered */
  cron_schedule?: { cron: string; prompt: string }[];
  meta: {
    created_at: string;
    created_by: string;
    forked_from: string | null;
    project: string;
  };
}

export interface WorkerState {
  status: "active" | "idle" | "sleeping" | "dead" | "unknown";
  pane_id: string | null;
  pane_target: string | null;
  tmux_session: string | null;
  session_id: string;
  past_sessions: string[];
  last_relaunch: { at: string; reason: string } | null;
  relaunch_count: number;
  cycles_completed: number;
  last_cycle_at: string | null;
  custom: Record<string, unknown>;
}

export interface FleetConfig {
  tmux_session: string;
  project_name: string;
  commit_notify: string[];
  deploy_authority: string;
  merge_authority: string;
  mission_authority: string | string[];
  window_groups?: Record<string, string[]>;
  /** Per-type hooks — merged as creator-owned hooks when creating workers of that type */
  hooks_by_type?: Record<string, Omit<SystemHook, 'id' | 'owner'>[]>;
  /** Saved tmux window layout strings (window name → layout) */
  layouts?: Record<string, string>;
}

export interface SystemHook {
  id: string;
  owner: "system" | "creator" | "self";
  event: string;
  tool?: string;
  condition: Record<string, string>;
  action: "block";
  message: string;
}

export interface DynamicHook {
  id: string;
  event: string;
  description: string;
  content?: string;
  blocking: boolean;
  condition?: {
    tool?: string;
    file_glob?: string;
    command_pattern?: string;
  };
  completed: boolean;
  completed_at?: string;
  result?: string;
  agent_id?: string;
  added_at: string;
  /** Relative path to script file in the worker's hooks/ dir (e.g. "dh-1-notify-validator.sh") */
  script_path?: string;
  /** Hook status — "active" hooks fire, "done" = check passed/completed, "archived" = preserved but inert */
  status?: "active" | "done" | "archived";
  /** Lifetime — "cycle" hooks are archived on recycle, "persistent" survive recycles.
   *  Default: "persistent" for Stop hooks, "cycle" for all others. */
  lifetime?: "cycle" | "persistent";
  /** Scope — limits which sessions/workers this hook fires in.
   *  "session:{id}" = per-session, "worker:{name}" = per-worker, undefined = global (fires everywhere). */
  scope?: string;
  /** Bash command to verify a condition. Exit 0 = pass, non-zero = block.
   *  Re-evaluated each time the event fires (Stop hooks become verification loops). */
  check?: string;
  /** How many times this hook has blocked (for safety valve) */
  fire_count?: number;
  /** Auto-pass after this many blocks. Default: 5. Prevents infinite loops. */
  max_fires?: number;
  /** ISO timestamp when this hook was archived */
  archived_at?: string;
  /** Why this hook was archived (e.g. "cycle-end", "removed", "completed") */
  archive_reason?: string;
  /** Who registered this hook (worker name). Set by manage_worker_hooks for cross-worker hooks. */
  registered_by?: string;
  /** Hook ownership tier — "system" (irremovable), "creator" (worker can't remove), "self" (worker manages). */
  ownership?: "system" | "creator" | "self";
}

/** The 12 immutable system hooks — safety guardrails for all workers */
export const SYSTEM_HOOKS: SystemHook[] = [
  { id: "sys-1", owner: "system", event: "PreToolUse", tool: "Bash", condition: { command_pattern: "rm\\s+-rf\\s+[/~.]" }, action: "block", message: "Catastrophic rm -rf blocked" },
  { id: "sys-2", owner: "system", event: "PreToolUse", tool: "Bash", condition: { command_pattern: "git\\s+reset\\s+--hard" }, action: "block", message: "git reset --hard blocked" },
  { id: "sys-3", owner: "system", event: "PreToolUse", tool: "Bash", condition: { command_pattern: "git\\s+clean\\s+-[fd]" }, action: "block", message: "git clean blocked" },
  { id: "sys-4", owner: "system", event: "PreToolUse", tool: "Bash", condition: { command_pattern: "git\\s+push.*--force" }, action: "block", message: "Force push blocked" },
  { id: "sys-5", owner: "system", event: "PreToolUse", tool: "Bash", condition: { command_pattern: "git\\s+checkout\\s+main\\b" }, action: "block", message: "Workers stay on their branch" },
  { id: "sys-6", owner: "system", event: "PreToolUse", tool: "Bash", condition: { command_pattern: "git\\s+merge\\b" }, action: "block", message: "Workers don't merge — use Fleet Mail" },
  { id: "sys-7", owner: "system", event: "PreToolUse", tool: "Edit", condition: { file_glob: "**/fleet/**/config.json" }, action: "block", message: "Use update_worker_config tool" },
  { id: "sys-8", owner: "system", event: "PreToolUse", tool: "Write", condition: { file_glob: "**/fleet/**/config.json" }, action: "block", message: "Use update_worker_config tool" },
  { id: "sys-9", owner: "system", event: "PreToolUse", tool: "Edit", condition: { file_glob: "**/fleet/**/state.json" }, action: "block", message: "Use update_state tool" },
  { id: "sys-10", owner: "system", event: "PreToolUse", tool: "Write", condition: { file_glob: "**/fleet/**/state.json" }, action: "block", message: "Use update_state tool" },
  { id: "sys-11", owner: "system", event: "PreToolUse", tool: "Edit", condition: { file_glob: "**/fleet/**/token" }, action: "block", message: "Token is auto-provisioned" },
  { id: "sys-12", owner: "system", event: "PreToolUse", tool: "Write", condition: { file_glob: "**/fleet/**/token" }, action: "block", message: "Token is auto-provisioned" },
];

export interface ExtensionManifest {
  name: string;
  version?: string;
  description?: string;
  scripts?: Record<string, string>;
  hooks?: Record<string, string>;
  root_files?: string[];
  install?: string;
  templates?: {
    "seed-fragments"?: string[];
  };
}

export const HARDCODED_DEFAULTS = {
  model: "opus[1m]",
  runtime: "claude" as const,
  effort: "high",
  permission_mode: "bypassPermissions",
  sleep_duration: null as number | null,
};

// ── Event Tools (Druids-style custom MCP tools per agent) ─────────

export interface EventTool {
  name: string;
  description: string;
  inputSchema?: Record<string, EventToolParam>;
  mode: "inline" | "command";
  handler: string;  // function name (inline) or shell command (command)
}

export interface EventToolParam {
  type: "string" | "number" | "boolean" | "object" | "array";
  description?: string;
  required?: boolean;
}

export interface EventToolContext {
  workerName: string;
  projectRoot: string;
  sessionDir: string;
  sendMail(to: string, subject: string, body: string): Promise<void>;
  updateState(key: string, value: unknown): void;
  spawnWorker(name: string, mission: string, opts?: Record<string, unknown>): Promise<void>;
  triggerNode(nodeName: string): Promise<void>;
  writeResult(filename: string, content: string): void;
  readResult(filename: string): string | null;
}

export interface EventToolResult { text: string; data?: unknown; }

// ── AgentSpec File Format (universal unit) ────────────────────────

export interface AgentSpecFile {
  name: string;
  role?: string;

  // Model & Runtime
  model?: string;
  runtime?: "claude" | "codex" | "sdk" | "custom";
  custom_launcher?: string;
  effort?: string;
  permission_mode?: string;

  // Prompt & Context
  prompt?: string;
  system_prompt?: string;
  append_system_prompt?: string;
  add_dir?: string[];

  // Tool Access
  allowed_tools?: string[];
  disallowed_tools?: string[];

  // MCP Servers
  mcp_servers?: Record<string, { url?: string; command?: string; args?: string[]; headers?: Record<string, string>; env?: Record<string, string> }>;

  // Git & Workspace
  worktree?: boolean | string;
  branch?: string;
  dir?: string;

  // Mission
  mission?: string;

  // Lifecycle
  type?: string;
  sleep_duration?: number | null;
  ephemeral?: boolean;
  report_to?: string;
  max_budget_usd?: number;

  // Hooks (any Claude Code event)
  hooks?: AgentSpecHook[];

  // Event Tools (Druids-style)
  tools?: EventTool[];

  // Environment
  env?: Record<string, string>;
  vars?: Record<string, string>;

  // Output
  json_schema?: string;

  // SDK-specific options (runtime: "sdk")
  max_turns?: number;
  agents?: Record<string, { description: string; prompt: string; tools?: string[]; model?: string; maxTurns?: number }>;
  persist_session?: boolean;
}

export interface AgentSpecHook {
  event: string;
  type?: "command" | "prompt" | "agent" | "launch" | "message";
  command?: string;
  matcher?: string;
  blocking?: boolean;
  check?: string;
  description?: string;
  content?: string;

  // For type:"message"
  to?: string;
  subject?: string;
  body?: string;

  // For type:"launch"
  workers?: AgentSpecFile[];
}

/**
 * Load an AgentSpec from a YAML or JSON file.
 */
export function loadAgentSpec(path: string): AgentSpecFile {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const content = readFileSync(path, "utf-8");

  let spec: AgentSpecFile;

  if (path.endsWith(".json")) {
    spec = JSON.parse(content);
  } else {
    // YAML (.yaml, .yml, .agent.yaml)
    const yaml = require("js-yaml");
    spec = yaml.load(content) as AgentSpecFile;
  }

  if (!spec || typeof spec !== "object") {
    throw new Error(`Invalid agent spec file: ${path}`);
  }
  if (!spec.name) {
    throw new Error(`Agent spec missing required 'name' field: ${path}`);
  }

  return spec;
}
