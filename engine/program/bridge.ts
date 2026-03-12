#!/usr/bin/env bun
/**
 * Generic pipeline bridge — handles phase transitions for any program.
 *
 * Entry point: bun bridge.ts <session-dir> <phase-index>
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
import { installStopHook } from "./hook-generator";
import { addWindowsToSession, launchAgents, launchInPlanningWindow } from "./tmux-layout";
import { updateManifest } from "./manifest";
import { createBridgeFifos } from "./fifo";

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

  console.log(`[bridge] Phase ${phaseIndex}: ${phase.name}`);

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

  // 3. Compile phase → workers, windows, seeds
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
  if (phaseIndex < program.phases.length - 1) {
    const nextPhaseIndex = phaseIndex + 1;
    const gateAgents = resolveGateAgents(phase, agents);
    const isGateAll = phase.gate === "all";

    // Create bridge FIFO for next phase
    createBridgeFifos(state.sessionDir, [nextPhaseIndex]);

    for (const gateAgent of gateAgents) {
      installStopHook(
        gateAgent.name,
        state.fleetProject,
        "",
        state.sessionDir,
        nextPhaseIndex,
        isGateAll ? { gateCount: gateAgents.length } : undefined,
      );
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
          Bun.spawnSync(
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

// ── CLI entry point ──────────────────────────────────────────────

if (import.meta.main) {
  const sessionDir = process.argv[2];
  const phaseIndex = parseInt(process.argv[3], 10);

  if (!sessionDir || isNaN(phaseIndex)) {
    console.error("Usage: bun bridge.ts <session-dir> <phase-index>");
    process.exit(1);
  }

  if (!existsSync(join(sessionDir, "pipeline-state.json"))) {
    console.error(`Pipeline state not found: ${sessionDir}/pipeline-state.json`);
    process.exit(1);
  }

  try {
    await runBridge(sessionDir, phaseIndex);
  } catch (err) {
    console.error(`[bridge] FATAL: ${err}`);
    process.exit(1);
  }
}
