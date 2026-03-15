/**
 * Canonical type definitions shared between CLI and MCP server.
 * Single source of truth — both `cli/lib/config.ts` and `mcp/worker-fleet/index.ts`
 * import from here.
 */

export interface WorkerConfig {
  model: string;
  /** Runtime: "claude" (default), "codex", or "custom" */
  runtime?: "claude" | "codex" | "custom";
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
  model: "opus",
  effort: "high",
  permission_mode: "bypassPermissions",
  sleep_duration: null as number | null,
};
