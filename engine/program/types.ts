/**
 * Program API types — declares a multi-phase agent pipeline
 * that compiles into fleet's distributed artifacts.
 *
 * A Program is a declarative description of phases, agents, hooks,
 * and bridge actions. The compiler walks it to produce:
 *   - Stop hook scripts (direct bridge invocation, no FIFOs)
 *   - Seed prompts (from templates or inline)
 *   - Launch wrappers (per agent)
 *   - Fleet worker directories
 *   - Tmux layout (windows + panes)
 *   - Manifest (human-readable pipeline overview)
 */

// ── Hook types (re-exported from claude-hooks for convenience) ───

export type HookEvent =
  | "SessionStart" | "SessionEnd" | "UserPromptSubmit"
  | "PreToolUse" | "PostToolUse" | "PostToolUseFailure"
  | "PermissionRequest" | "Notification" | "Stop"
  | "SubagentStart" | "SubagentStop" | "TeammateIdle"
  | "TaskCompleted" | "InstructionsLoaded" | "ConfigChange"
  | "PreCompact" | "WorktreeCreate" | "WorktreeRemove";

export interface PipelineHook {
  event: HookEvent;
  type: "command" | "prompt" | "agent";
  command?: string;       // for type:"command"
  prompt?: string;        // for type:"prompt"/"agent"
  matcher?: string;       // regex for tool names (PreToolUse/PostToolUse)
  blocking?: boolean;     // gate vs inject
  check?: string;         // bash command: exit 0=pass, non-zero=block
  description?: string;
}

export interface ConvergenceSpec {
  check: string;              // exit 0 = converged (stop cycling)
  maxIterations?: number;     // safety valve
  handler?: string;           // exported function name for complex checks
}

// ── Program Declaration ────────────────────────────────────

export interface Program {
  name: string;
  description?: string;
  phases: Phase[];
  defaults?: ProgramDefaults;
  material?: ProgramMaterial;
  /** If present, the compiler uses the graph instead of phases */
  graph?: ProgramGraph;
}

export interface ProgramDefaults {
  model?: string;
  effort?: string;
  permission?: string;
}

export interface ProgramMaterial {
  scope?: string;
  contentFiles?: string[];
  spec?: string;
}

export interface Phase {
  name: string;
  description?: string;
  agents: AgentSpec[] | DynamicAgents;
  /** Which agent's Stop triggers next phase. Default: last agent. "all" = all must finish. */
  gate?: string | "all";
  layout?: PhaseLayout;
  /** Actions to run during bridge before launching this phase's agents */
  prelaunch?: BridgeAction[];
  /** Hooks active during this phase (installed on all agents in this phase) */
  hooks?: PipelineHook[];
  /** Override default i+1 transition (enables cycles and branching) */
  next?: number | string;
  /** For cyclic phases: stop condition */
  convergence?: ConvergenceSpec;
}

export interface PhaseLayout {
  panesPerWindow?: number;
  algorithm?: string;
}

export interface AgentSpec {
  name: string;
  role: string;
  model?: string;
  seed: SeedSpec;
  window?: string;
  vars?: Record<string, string>;
  /** Per-agent hooks (e.g. read-only guard on review workers) */
  hooks?: PipelineHook[];
}

export type SeedSpec =
  | { template: string; vars?: Record<string, string> }
  | { inline: string }
  | { generator: string };

export interface DynamicAgents {
  /** Exported function name called at bridge time: (state, defaults) => AgentSpec[] */
  generator: string;
  /** Pre-created window estimate for layout */
  estimate?: number;
  /** Static fallback if generator fails */
  fallback?: AgentSpec[];
}

export interface BridgeAction {
  type: "context-prepass" | "shuffle-material" | "parse-output" | "custom";
  /** For parse-output: which agent produced the file */
  agent?: string;
  /** For parse-output: filename to parse (relative to session dir) */
  file?: string;
  /** For custom: exported function name in the program file */
  handler?: string;
}

// ── Graph-based Program ─────────────────────────────────────────

/** A node in the program graph (replaces indexed Phase) */
export interface ProgramNode {
  description?: string;
  agents: AgentSpec[] | DynamicAgents;
  gate?: string | "all";
  layout?: PhaseLayout;
  prelaunch?: BridgeAction[];
  hooks?: PipelineHook[];
}

/** An edge between nodes */
export interface ProgramEdge {
  from: string;
  to: string;
  /** Bash check: exit 0 = take this edge */
  condition?: string;
  /** For manifest readability */
  label?: string;
  /** Evaluation order (lower = first). Default 0. */
  priority?: number;
  /** Safety valve for back-edges (cycles) */
  maxIterations?: number;
}

/** Graph-based program (the primary program format) */
export interface ProgramGraph {
  name: string;
  description?: string;
  nodes: Record<string, ProgramNode>;
  edges: ProgramEdge[];
  /** Starting node name */
  entry: string;
  defaults?: ProgramDefaults;
  material?: ProgramMaterial;
}

// ── Compiled Artifacts ─────────────────────────────────────────

export interface CompiledPlan {
  /** Program metadata */
  program: { name: string; description?: string };
  /** All compiled phases (eager + deferred placeholders) */
  phases: CompiledPhase[];
  /** All windows to create */
  windows: CompiledWindow[];
  /** All workers to provision */
  workers: CompiledWorker[];
  /** All hooks to write */
  hooks: CompiledHook[];
  /** Session directory path */
  sessionDir: string;
  /** Path to the program file (for bridge re-import) */
  programPath: string;
}

export interface CompiledPhase {
  index: number;
  name: string;
  status: "compiled" | "deferred";
  agentCount: number;
  /** Names of agents in this phase */
  agentNames: string[];
  /** Whether this phase uses dynamic agent generation */
  dynamic: boolean;
  /** Estimate for deferred phases */
  estimate?: number;
  /** For graph-based programs: the node name */
  nodeName?: string;
}

export interface CompiledWindow {
  name: string;
  paneCount: number;
  /** Phase this window belongs to */
  phase: string;
  /** "tiled" | "even-horizontal" etc */
  layout?: string;
}

export interface CompiledWorker {
  name: string;
  role: string;
  model: string;
  /** Path to the generated seed file */
  seedPath: string;
  /** Path to the generated launch wrapper */
  wrapperPath: string;
  /** Window name this worker is assigned to */
  window: string;
  /** Pane index within the window */
  paneIndex: number;
  /** Phase index */
  phaseIndex: number;
  /** Extra env vars for the launch wrapper */
  env?: Record<string, string>;
}

export interface CompiledHook {
  /** Worker whose Stop event triggers this hook */
  workerName: string;
  /** Phase index this hook transitions to */
  targetPhaseIndex: number;
  /** Path to the generated hook script */
  scriptPath: string;
  /** Session dir path */
  sessionDirPath: string;
  /** For gate:"all" — expected done marker count */
  gateCount?: number;
  /** For graph-based programs: target node name */
  targetNodeName?: string;
}

// ── Pipeline State (persisted across phases) ───────────────────

export interface ProgramPipelineState {
  /** Path to the program file */
  programPath: string;
  /** Original options passed to the program function */
  opts: Record<string, unknown>;
  /** Program name */
  programName: string;
  /** Tmux session name */
  tmuxSession: string;
  /** Session directory */
  sessionDir: string;
  /** Project root */
  projectRoot: string;
  /** Work directory (may be worktree) */
  workDir: string;
  /** Fleet project name */
  fleetProject: string;
  /** Session hash (for naming) */
  sessionHash: string;
  /** Program defaults */
  defaults: ProgramDefaults;
  /** Per-phase state (outputs, done markers, etc.) — keyed by index or node name */
  phaseState: Record<number | string, Record<string, unknown>>;
  /** Compiled phases (updated as deferred phases compile) */
  compiledPhases: CompiledPhase[];
  /** For graph-based programs: maps node name → stable index */
  nodeIndexMap?: Record<string, number>;
  /** Template directory */
  templateDir: string;
  /** Validator path */
  validatorPath: string;
  /** Material info */
  material?: {
    materialFile: string;
    materialType: string;
    diffLines: number;
    diffDesc: string;
    materialTypesStr: string;
    hasDiff: boolean;
    hasContent: boolean;
    changedFiles: string[];
  };

  /** Tracks iterations for cyclic phases */
  cycleCount?: Record<number, number>;

  // ── Deep-review specific state (carried from legacy PipelineState) ──
  /** Role designer result (populated after Phase 0) */
  roleResult?: {
    useDynamicRoles: boolean;
    focusAreas: string[];
    numFocus: number;
    totalWorkers: number;
    passesPerFocus: number;
    roleNames: string;
  };
  /** Review config (REVIEW.md content, may be improved by Phase 0.5) */
  reviewConfig?: string;
  /** Spec text */
  spec?: string;
  /** Worker names (populated during worker phase compilation) */
  workerNames?: string[];
  /** Coordinator name */
  coordinatorName?: string;
  /** Judge name */
  judgeName?: string;
  /** Verifier names */
  verifierNames?: string[];
}

// ── Helper type guards ─────────────────────────────────────────

export function isDynamic(agents: AgentSpec[] | DynamicAgents): agents is DynamicAgents {
  return !Array.isArray(agents) && "generator" in agents;
}

export function isStaticAgents(agents: AgentSpec[] | DynamicAgents): agents is AgentSpec[] {
  return Array.isArray(agents);
}
