/**
 * Program API — public exports.
 *
 * The program engine compiles declarative pipeline definitions into
 * fleet's distributed artifacts (hooks, seeds, tmux layout).
 */

// Types
export type {
  Program,
  ProgramFlag,
  Phase,
  AgentSpec,
  DynamicAgents,
  BridgeAction,
  SeedSpec,
  PhaseLayout,
  ProgramDefaults,
  ProgramMaterial,
  PipelineHook,
  ConvergenceSpec,
  HookEvent,
  ProgramGraph,
  ProgramNode,
  ProgramEdge,
  CompiledPlan,
  CompiledPhase,
  CompiledWindow,
  CompiledWorker,
  CompiledHook,
  ProgramPipelineState,
} from "./types";
export { isDynamic, isStaticAgents } from "./types";

// Graph builder
export { graph, ProgramBuilder, phasesToGraph, topologicalSort, buildNodeIndexMap, outgoingEdges, END_SENTINEL } from "./graph";

// Compiler
export { compile, compileGraph, compilePhase, installGraphStopHook, savePipelineState, loadPipelineState } from "./compiler";

// Seed resolver
export { resolveSeed, resolveSeedToFile, substitute, buildStateVars, registerPartials } from "./seed-resolver";

// Hook generator
export { installPipelineHooks } from "./hook-generator";

// Hooks bridge (dynamic import to claude-hooks)
export { getHooksIO, getHooksTypes, checkHooksInstalled } from "./hooks-bridge";

// Fleet provisioning
export { provisionWorkers, cleanupPipelineWorkers, buildMailEnvExport, generateLaunchWrapper, generateCleanupScript } from "./fleet-provision";

// Tmux layout
export { createTmuxSession, addWindowsToSession, launchAgent, launchAgents, launchInPlanningWindow, showManifest } from "./tmux-layout";

// Manifest
export { generateManifest, updateManifest } from "./manifest";

// Worker builder helpers
export { workerTeam, coordinator } from "./helpers";
