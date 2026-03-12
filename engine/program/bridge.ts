#!/usr/bin/env bun
/**
 * Generic pipeline bridge — handles phase transitions for any program.
 *
 * Entry points:
 *   bun bridge.ts <session-dir> <phase-index>        — legacy Phase[] path
 *   bun bridge.ts <session-dir> --node <node-name>   — graph-native path
 *
 * Called by Stop hook scripts when a phase's gate agent completes.
 * Loads the program file, resolves dynamic agents, runs prelaunch actions,
 * compiles the phase, provisions fleet workers, adjusts tmux layout,
 * and launches agents.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Program,
  AgentSpec,
  Phase,
  BridgeAction,
  ProgramPipelineState,
} from "./types";
import { isDynamic } from "./types";
import { compilePhase, savePipelineState } from "./compiler";
import { provisionWorkers, generateLaunchWrapper, generateCleanupScript } from "./fleet-provision";
import { installStopHook, installPipelineHooks } from "./hook-generator";
import { addWindowsToSession, launchAgents, launchInPlanningWindow } from "./tmux-layout";
import { updateManifest } from "./manifest";
import { FLEET_DATA } from "../../cli/lib/paths";
import { outgoingEdges, buildNodeIndexMap } from "./graph";

/**
 * Run a bridge transition for a specific phase.
 */
async function runBridge(sessionDir: string, phaseIndex: number): Promise<void> {
  console.log(`[bridge] Phase ${phaseIndex}: loading pipeline state...`);

  // Load pipeline state
  const stateRaw = readFileSync(join(sessionDir, "pipeline-state.json"), "utf-8");
  const state: ProgramPipelineState = JSON.parse(stateRaw);

  // Import the program file
  const programModule = await import(state.programPath);
  const programFn = programModule.default;

  if (typeof programFn !== "function") {
    throw new Error(`Program file must export a default function, got: ${typeof programFn}`);
  }

  const program: Program = programFn(state.opts);
  const phase = program.phases[phaseIndex];

  if (!phase) {
    throw new Error(`Phase ${phaseIndex} not found in program (${program.phases.length} phases)`);
  }

  // Track cycle count for cyclic phases
  if (!state.cycleCount) state.cycleCount = {};
  if (state.cycleCount[phaseIndex] !== undefined) {
    state.cycleCount[phaseIndex]++;
    console.log(`[bridge] Phase ${phaseIndex}: ${phase.name} (cycle ${state.cycleCount[phaseIndex]})`);
  } else {
    state.cycleCount[phaseIndex] = 0;
    console.log(`[bridge] Phase ${phaseIndex}: ${phase.name}`);
  }

  // 1. Run prelaunch actions
  if (phase.prelaunch) {
    for (const action of phase.prelaunch) {
      await runPrelaunchAction(action, state, programModule);
    }
  }

  // 2. Resolve agents (static or dynamic)
  let agents: AgentSpec[];
  if (isDynamic(phase.agents)) {
    const generatorName = phase.agents.generator;
    const generatorFn = programModule[generatorName];

    if (typeof generatorFn !== "function") {
      console.log(`[bridge] WARN: Generator ${generatorName} not found, using fallback`);
      agents = phase.agents.fallback || [];
    } else {
      try {
        agents = generatorFn(state, state.defaults);
        console.log(`[bridge] Generator ${generatorName} produced ${agents.length} agents`);
      } catch (err) {
        console.log(`[bridge] WARN: Generator failed: ${err}, using fallback`);
        agents = phase.agents.fallback || [];
      }
    }
  } else {
    agents = phase.agents;
  }

  if (agents.length === 0) {
    console.log("[bridge] No agents to launch — skipping phase");
    return;
  }

  // 3. Compile phase -> workers, windows, seeds
  console.log(`[bridge] Compiling ${agents.length} agents...`);
  const compiled = compilePhase(phaseIndex, agents, phase, state);

  // 4. Provision fleet dirs + Fleet Mail
  console.log(`[bridge] Provisioning fleet (${compiled.workers.length} workers)...`);
  await provisionWorkers(compiled.workers, state);

  // 5. Generate launch wrappers
  for (const worker of compiled.workers) {
    generateLaunchWrapper(worker, state);
  }

  // 6. Install stop hooks (if there's a next phase)
  const nextPhaseIndex = resolveNextPhase(phase, phaseIndex, program.phases.length);
  if (nextPhaseIndex !== null) {
    const gateAgents = resolveGateAgents(phase, agents);
    const isGateAll = phase.gate === "all";

    // Build convergence opts if this phase cycles
    const convergenceOpts = phase.convergence ? {
      check: phase.convergence.check,
      maxIterations: phase.convergence.maxIterations || 10,
      nextPhase: nextPhaseIndex,
      cyclePhase: typeof phase.next === "number" ? phase.next : phaseIndex,
    } : undefined;

    for (const gateAgent of gateAgents) {
      installStopHook(
        gateAgent.name,
        state.fleetProject,
        "",
        state.sessionDir,
        nextPhaseIndex,
        {
          ...(isGateAll ? { gateCount: gateAgents.length } : {}),
          ...(convergenceOpts ? { convergence: convergenceOpts } : {}),
        },
      );
    }
  }

  // 6b. Install phase-level and per-agent pipeline hooks
  if (phase.hooks && phase.hooks.length > 0) {
    for (const agent of agents) {
      const workerHooksDir = join(FLEET_DATA, state.fleetProject, agent.name, "hooks");
      await installPipelineHooks(workerHooksDir, phase.hooks, state.programName);
    }
  }
  for (const agent of agents) {
    if (agent.hooks && agent.hooks.length > 0) {
      const workerHooksDir = join(FLEET_DATA, state.fleetProject, agent.name, "hooks");
      await installPipelineHooks(workerHooksDir, agent.hooks, state.programName);
    }
  }

  // 7. Adjust tmux layout
  addWindowsToSession(state.tmuxSession, compiled.windows, state.projectRoot);

  // 8. Launch agents
  // Check if this is a planning-phase agent (single agent, small window)
  const isPlanningPhase = compiled.workers.length <= 2 &&
    compiled.workers.every(w => w.window === "planning" || w.window === phase.name);

  if (isPlanningPhase && compiled.workers.length === 1) {
    launchInPlanningWindow(compiled.workers[0], state.tmuxSession, state, 1);
  } else {
    launchAgents(compiled.workers, state.tmuxSession, state);
  }

  // 9. Update manifest
  updateManifest(state, phaseIndex, compiled.phase.agentNames);

  // 10. Update pipeline state
  state.compiledPhases[phaseIndex] = compiled.phase;
  // Store worker names from this phase
  const workerNames = compiled.workers.map(w => w.name);
  state.phaseState[phaseIndex] = {
    ...state.phaseState[phaseIndex],
    workerNames,
    compiled: true,
  };

  // Propagate worker names to state (for deep-review compat)
  if (!state.workerNames) state.workerNames = [];
  state.workerNames.push(...workerNames);

  // Generate cleanup script
  generateCleanupScript(state);

  savePipelineState(state);

  console.log(`[bridge] Phase ${phaseIndex} launched: ${agents.length} agents`);
  console.log(`[bridge] Session: ${state.tmuxSession}`);
}

/**
 * Resolve the next phase index for a phase.
 */
function resolveNextPhase(phase: Phase, currentIndex: number, totalPhases: number): number | null {
  if (phase.next !== undefined) {
    if (typeof phase.next === "number") return phase.next;
    return currentIndex + 1 < totalPhases ? currentIndex + 1 : null;
  }
  return currentIndex + 1 < totalPhases ? currentIndex + 1 : null;
}

/**
 * Run a prelaunch action.
 */
async function runPrelaunchAction(
  action: BridgeAction,
  state: ProgramPipelineState,
  programModule: Record<string, unknown>,
): Promise<void> {
  switch (action.type) {
    case "parse-output": {
      console.log(`[bridge] Prelaunch: parse-output (${action.agent}/${action.file})`);
      // Look for a parser function in the program module
      const parserName = `parse_${action.agent?.replace(/-/g, "_")}_output`;
      const parserFn = programModule[parserName] as Function | undefined;
      if (parserFn) {
        await parserFn(state);
      } else {
        // Default: try to read the file as JSON and store in phaseState
        const filePath = join(state.sessionDir, action.file || "output.json");
        if (existsSync(filePath)) {
          try {
            const data = JSON.parse(readFileSync(filePath, "utf-8"));
            const key = action.agent || "output";
            state.phaseState[0] = { ...state.phaseState[0], [key]: data };
          } catch (err) {
            console.log(`[bridge]   WARN: Failed to parse ${filePath}: ${err}`);
          }
        }
      }
      break;
    }

    case "context-prepass": {
      console.log("[bridge] Prelaunch: context-prepass");
      try {
        const { runContextPrePass } = await import("../../cli/lib/deep-review/context");
        if (state.material?.hasDiff) {
          runContextPrePass(
            { sessionDir: state.sessionDir, workDir: state.workDir, claudeOps: state.programPath.replace(/\/programs\/.*$/, ""), projectRoot: state.projectRoot } as any,
            state.material as any,
          );
        }
      } catch (err) {
        console.log(`[bridge]   WARN: Context pre-pass failed: ${err}`);
      }
      break;
    }

    case "shuffle-material": {
      console.log("[bridge] Prelaunch: shuffle-material");
      try {
        const fleetDir = process.env.CLAUDE_FLEET_DIR || join(process.env.HOME || "/tmp", ".claude-fleet");
        const drContext = join(fleetDir, "bin", "dr-context");
        if (existsSync(drContext) && state.material) {
          const workerCount = state.roleResult?.totalWorkers || 8;
          console.log(`[bridge]   Generating ${workerCount} randomized orderings...`);
          (Bun.spawnSync as any)(
            [drContext, "shuffle", state.material.materialFile, state.sessionDir, String(workerCount)],
            { cwd: state.projectRoot, stderr: "pipe", timeout: 60_000 },
          );
        }
      } catch (err) {
        console.log(`[bridge]   WARN: Material shuffle failed: ${err}`);
      }
      break;
    }

    case "custom": {
      if (action.handler) {
        const handlerFn = programModule[action.handler] as Function | undefined;
        if (handlerFn) {
          console.log(`[bridge] Prelaunch: custom (${action.handler})`);
          await handlerFn(state);
        } else {
          console.log(`[bridge]   WARN: Custom handler ${action.handler} not found`);
        }
      }
      break;
    }
  }
}

/**
 * Resolve which agents are the "gate" for a phase.
 */
function resolveGateAgents(phase: Phase, agents: AgentSpec[]): AgentSpec[] {
  if (!phase.gate || phase.gate === "all") {
    return phase.gate === "all" ? agents : [agents[agents.length - 1]];
  }

  const named = agents.find(a => a.name === phase.gate);
  return named ? [named] : [agents[agents.length - 1]];
}

// ── Graph-Native Bridge ─────────────────────────────────────────

/**
 * Run a bridge transition for a graph node.
 * Similar to runBridge but resolves by node name instead of phase index.
 */
async function runGraphBridge(sessionDir: string, nodeName: string): Promise<void> {
  console.log(`[bridge] Node "${nodeName}": loading pipeline state...`);

  const stateRaw = readFileSync(join(sessionDir, "pipeline-state.json"), "utf-8");
  const state: ProgramPipelineState = JSON.parse(stateRaw);

  // Import the program file
  const programModule = await import(state.programPath);
  const programFn = programModule.default;

  if (typeof programFn !== "function") {
    throw new Error(`Program file must export a default function, got: ${typeof programFn}`);
  }

  const program: Program = programFn(state.opts);
  const g = program.graph;

  if (!g) {
    throw new Error(`Graph bridge called but program has no .graph`);
  }

  const node = g.nodes[nodeName];
  if (!node) {
    throw new Error(`Node "${nodeName}" not found in program graph`);
  }

  // Ensure nodeIndexMap exists
  if (!state.nodeIndexMap) {
    state.nodeIndexMap = buildNodeIndexMap(g);
  }
  const phaseIndex = state.nodeIndexMap[nodeName];

  // Track cycle count
  if (!state.cycleCount) state.cycleCount = {};
  const cycleKey = phaseIndex;
  if (state.cycleCount[cycleKey] !== undefined) {
    state.cycleCount[cycleKey]++;
    console.log(`[bridge] Node "${nodeName}" (cycle ${state.cycleCount[cycleKey]})`);
  } else {
    state.cycleCount[cycleKey] = 0;
    console.log(`[bridge] Node "${nodeName}"`);
  }

  // 1. Run prelaunch actions
  if (node.prelaunch) {
    for (const action of node.prelaunch) {
      await runPrelaunchAction(action, state, programModule);
    }
  }

  // 2. Resolve agents (static or dynamic)
  let agents: AgentSpec[];
  if (isDynamic(node.agents)) {
    const generatorName = node.agents.generator;
    const generatorFn = programModule[generatorName];

    if (typeof generatorFn !== "function") {
      console.log(`[bridge] WARN: Generator ${generatorName} not found, using fallback`);
      agents = node.agents.fallback || [];
    } else {
      try {
        agents = generatorFn(state, state.defaults);
        console.log(`[bridge] Generator ${generatorName} produced ${agents.length} agents`);
      } catch (err) {
        console.log(`[bridge] WARN: Generator failed: ${err}, using fallback`);
        agents = node.agents.fallback || [];
      }
    }
  } else {
    agents = node.agents;
  }

  if (agents.length === 0) {
    console.log("[bridge] No agents to launch — skipping node");
    return;
  }

  // 3. Compile phase
  const phaseCompat: Phase = {
    name: nodeName,
    description: node.description,
    agents: node.agents,
    gate: node.gate,
    layout: node.layout,
    prelaunch: node.prelaunch,
    hooks: node.hooks,
  };

  console.log(`[bridge] Compiling ${agents.length} agents...`);
  const compiled = compilePhase(phaseIndex, agents, phaseCompat, state);

  // 4. Provision fleet dirs + Fleet Mail
  console.log(`[bridge] Provisioning fleet (${compiled.workers.length} workers)...`);
  await provisionWorkers(compiled.workers, state);

  // 5. Generate launch wrappers
  for (const worker of compiled.workers) {
    generateLaunchWrapper(worker, state);
  }

  // 6. Install stop hooks based on outgoing edges
  const edges = outgoingEdges(g, nodeName);
  if (edges.length > 0) {
    const gateAgents = resolveGateAgents(phaseCompat, agents);
    const isGateAll = node.gate === "all";

    for (const gateAgent of gateAgents) {
      // Reuse the graph stop hook generator from compiler
      const { installGraphStopHook } = await import("./compiler");
      installGraphStopHook(
        gateAgent.name,
        state.fleetProject,
        state.sessionDir,
        nodeName,
        edges,
        state.nodeIndexMap!,
        isGateAll ? gateAgents.length : undefined,
      );
    }
  }

  // 6b. Install pipeline hooks
  if (node.hooks && node.hooks.length > 0) {
    for (const agent of agents) {
      const workerHooksDir = join(FLEET_DATA, state.fleetProject, agent.name, "hooks");
      await installPipelineHooks(workerHooksDir, node.hooks, g.name);
    }
  }
  for (const agent of agents) {
    if (agent.hooks && agent.hooks.length > 0) {
      const workerHooksDir = join(FLEET_DATA, state.fleetProject, agent.name, "hooks");
      await installPipelineHooks(workerHooksDir, agent.hooks, g.name);
    }
  }

  // 7. Adjust tmux layout
  addWindowsToSession(state.tmuxSession, compiled.windows, state.projectRoot);

  // 8. Launch agents
  const isPlanningPhase = compiled.workers.length <= 2 &&
    compiled.workers.every(w => w.window === "planning" || w.window === nodeName);

  if (isPlanningPhase && compiled.workers.length === 1) {
    launchInPlanningWindow(compiled.workers[0], state.tmuxSession, state, 1);
  } else {
    launchAgents(compiled.workers, state.tmuxSession, state);
  }

  // 9. Update manifest
  updateManifest(state, phaseIndex, compiled.phase.agentNames);

  // 10. Update pipeline state
  state.compiledPhases[phaseIndex] = compiled.phase;
  const workerNames = compiled.workers.map(w => w.name);
  state.phaseState[nodeName] = {
    ...((state.phaseState[nodeName] as Record<string, unknown>) || {}),
    workerNames,
    compiled: true,
  };

  if (!state.workerNames) state.workerNames = [];
  state.workerNames.push(...workerNames);

  generateCleanupScript(state);
  savePipelineState(state);

  console.log(`[bridge] Node "${nodeName}" launched: ${agents.length} agents`);
  console.log(`[bridge] Session: ${state.tmuxSession}`);
}

// ── CLI entry point ──────────────────────────────────────────────

if (import.meta.main) {
  const sessionDir = process.argv[2];

  if (!sessionDir) {
    console.error("Usage: bun bridge.ts <session-dir> <phase-index|--node name>");
    process.exit(1);
  }

  if (!existsSync(join(sessionDir, "pipeline-state.json"))) {
    console.error(`Pipeline state not found: ${sessionDir}/pipeline-state.json`);
    process.exit(1);
  }

  // Parse: --node <name> or <phase-index>
  const nodeFlag = process.argv.indexOf("--node");
  let task: Promise<void>;

  if (nodeFlag !== -1 && process.argv[nodeFlag + 1]) {
    const nodeName = process.argv[nodeFlag + 1];
    task = runGraphBridge(sessionDir, nodeName);
  } else {
    const phaseIndex = parseInt(process.argv[3], 10);
    if (isNaN(phaseIndex)) {
      console.error("Usage: bun bridge.ts <session-dir> <phase-index|--node name>");
      process.exit(1);
    }
    task = runBridge(sessionDir, phaseIndex);
  }

  try {
    await task;
  } catch (err) {
    console.error(`[bridge] FATAL: ${err}`);
    process.exit(1);
  }
}
