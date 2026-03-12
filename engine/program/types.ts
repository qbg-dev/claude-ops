/**
 * Program API types — declares a multi-phase agent pipeline
 * that compiles into fleet's distributed artifacts.
 *
 * A Program is a declarative description of phases, agents, hooks,
 * and bridge actions. The compiler walks it to produce:
 *   - Stop hook scripts (parameterized from a generic template)
 *   - FIFO named pipes for inter-phase gating
 *   - Seed prompts (from templates or inline)
 *   - Launch wrappers (per agent)
 *   - Fleet worker directories
 *   - Tmux layout (windows + panes)
 *   - Manifest (human-readable pipeline overview)
 */

// ── Program Declaration ────────────────────────────────────────

export interface Program {
  name: string;
  description?: string;
  phases: Phase[];
  defaults?: ProgramDefaults;
  material?: ProgramMaterial;
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
  /** All FIFOs to create */
  fifos: CompiledFifo[];
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
  /** Session dir sidecar path */
  sessionDirPath: string;
  /** For gate:"all" — expected done marker count */
  gateCount?: number;
}

export interface CompiledFifo {
  name: string;
  path: string;
  /** "bridge" or "agent" — determines the waiting script type */
  type: "bridge" | "agent";
  /** Phase index this FIFO gates */
  phaseIndex: number;
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
  /** Per-phase state (outputs, done markers, etc.) */
  phaseState: Record<number, Record<string, unknown>>;
  /** Compiled phases (updated as deferred phases compile) */
  compiledPhases: CompiledPhase[];
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
