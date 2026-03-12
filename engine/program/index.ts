/**
 * Program API — public exports.
 *
 * The program engine compiles declarative pipeline definitions into
 * fleet's distributed artifacts (hooks, FIFOs, seeds, tmux layout).
 */

// Types
export type {
  Program,
  Phase,
  AgentSpec,
  DynamicAgents,
  BridgeAction,
  SeedSpec,
  PhaseLayout,
  ProgramDefaults,
  ProgramMaterial,
  CompiledPlan,
  CompiledPhase,
  CompiledWindow,
  CompiledWorker,
  CompiledHook,
  CompiledFifo,
  ProgramPipelineState,
} from "./types";
export { isDynamic, isStaticAgents } from "./types";

// Compiler
export { compile, compilePhase, savePipelineState, loadPipelineState } from "./compiler";

// Seed resolver
export { resolveSeed, resolveSeedToFile, substitute, buildStateVars } from "./seed-resolver";

// Hook generator
export { generateStopHook, installStopHook } from "./hook-generator";

// FIFO
export { createFifo, createBridgeFifos, createAgentFifos, bridgeWaitCommands, agentWaitCommands, unblockFifo, unblockFifos } from "./fifo";

// Fleet provisioning
export { provisionWorkers, cleanupPipelineWorkers, buildMailEnvExport, generateLaunchWrapper, generateCleanupScript } from "./fleet-provision";

// Tmux layout
export { createTmuxSession, addWindowsToSession, launchAgent, launchAgents, launchInPlanningWindow, showManifest } from "./tmux-layout";

// Manifest
export { generateManifest, updateManifest } from "./manifest";
