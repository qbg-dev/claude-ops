#!/usr/bin/env bun
/**
 * Generic pipeline bridge — handles node transitions for any program.
 *
 * Entry:
 *   bun bridge.ts <session-dir> --node <node-name>   — primary (graph-native)
 *   bun bridge.ts <session-dir> <phase-index>        — compat (looks up node name)
 *
 * Called by Stop hook scripts when a node's gate agent completes.
 * Loads the program file, resolves dynamic agents, runs prelaunch actions,
 * compiles the node, provisions fleet workers, adjusts tmux layout,
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
import { compilePhase, installGraphStopHook, savePipelineState } from "./compiler";
import { provisionWorkers, generateLaunchWrapper, generateCleanupScript } from "./fleet-provision";
import { installPipelineHooks } from "./hook-generator";
import { addWindowsToSession, launchAgents, launchInPlanningWindow } from "./tmux-layout";
import { updateManifest } from "./manifest";
import { FLEET_DATA } from "../../cli/lib/paths";
import { phasesToGraph, outgoingEdges, buildNodeIndexMap } from "./graph";

/**
 * Run a bridge transition for a graph node.
 */
async function runBridge(sessionDir: string, nodeName: string): Promise<void> {
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

  // Always use graph path — auto-convert Phase[] programs
  const g = program.graph || phasesToGraph(program);

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
  const agents = await resolveAgents(node.agents, programModule, state);

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

  // 7. Install pipeline hooks (node-level + per-agent)
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

  // 8. Adjust tmux layout
  addWindowsToSession(state.tmuxSession, compiled.windows, state.projectRoot);

  // 9. Launch agents
  const isPlanningPhase = compiled.workers.length <= 2 &&
    compiled.workers.every(w => w.window === "planning" || w.window === nodeName);

  if (isPlanningPhase && compiled.workers.length === 1) {
    launchInPlanningWindow(compiled.workers[0], state.tmuxSession, state, 1);
  } else {
    launchAgents(compiled.workers, state.tmuxSession, state);
  }

  // 10. Update manifest
  updateManifest(state, phaseIndex, compiled.phase.agentNames);

  // 11. Update pipeline state
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

// ── Shared Helpers ─────────────────────────────────────────────

/**
 * Resolve agents for a node (static or dynamic).
 */
async function resolveAgents(
  agentsDef: import("./types").AgentSpec[] | import("./types").DynamicAgents,
  programModule: Record<string, unknown>,
  state: ProgramPipelineState,
): Promise<AgentSpec[]> {
  if (isDynamic(agentsDef)) {
    const generatorName = agentsDef.generator;
    const generatorFn = programModule[generatorName];

    if (typeof generatorFn !== "function") {
      console.log(`[bridge] WARN: Generator ${generatorName} not found, using fallback`);
      return agentsDef.fallback || [];
    }

    try {
      const agents = (generatorFn as Function)(state, state.defaults);
      console.log(`[bridge] Generator ${generatorName} produced ${agents.length} agents`);
      return agents;
    } catch (err) {
      console.log(`[bridge] WARN: Generator failed: ${err}, using fallback`);
      return agentsDef.fallback || [];
    }
  }

  return agentsDef;
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
      const parserName = action.parser || `parse_${action.agent?.replace(/-/g, "_")}_output`;
      const parserFn = programModule[parserName] as Function | undefined;
      if (parserFn) {
        await parserFn(state);
      } else {
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
          const roleResult = (state.ext?.roleResult as any) || state.roleResult;
          const workerCount = roleResult?.totalWorkers || 8;
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

// ── CLI entry point ──────────────────────────────────────────────

if (import.meta.main) {
  const sessionDir = process.argv[2];

  if (!sessionDir) {
    console.error("Usage: bun bridge.ts <session-dir> <--node name | phase-index>");
    process.exit(1);
  }

  if (!existsSync(join(sessionDir, "pipeline-state.json"))) {
    console.error(`Pipeline state not found: ${sessionDir}/pipeline-state.json`);
    process.exit(1);
  }

  // Parse: --node <name> or <phase-index> (compat: look up node name from index)
  const nodeFlag = process.argv.indexOf("--node");
  let nodeName: string;

  if (nodeFlag !== -1 && process.argv[nodeFlag + 1]) {
    nodeName = process.argv[nodeFlag + 1];
  } else {
    const phaseIndex = parseInt(process.argv[3], 10);
    if (isNaN(phaseIndex)) {
      console.error("Usage: bun bridge.ts <session-dir> <--node name | phase-index>");
      process.exit(1);
    }

    // Look up node name from phase index via nodeIndexMap
    const stateRaw = readFileSync(join(sessionDir, "pipeline-state.json"), "utf-8");
    const state: ProgramPipelineState = JSON.parse(stateRaw);
    const indexMap = state.nodeIndexMap;
    if (!indexMap) {
      console.error(`[bridge] No nodeIndexMap in state — cannot resolve phase ${phaseIndex} to node name`);
      process.exit(1);
    }
    const entry = Object.entries(indexMap).find(([, idx]) => idx === phaseIndex);
    if (!entry) {
      console.error(`[bridge] Phase index ${phaseIndex} not found in nodeIndexMap`);
      process.exit(1);
    }
    nodeName = entry[0];
    console.log(`[bridge] Phase ${phaseIndex} → node "${nodeName}"`);
  }

  try {
    await runBridge(sessionDir, nodeName);
  } catch (err) {
    console.error(`[bridge] FATAL: ${err}`);
    process.exit(1);
  }
}
