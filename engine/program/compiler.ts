/**
 * Compiler — walks a Program declaration and produces CompiledPlan.
 *
 * Single code path: all programs (Phase[] or ProgramGraph) compile through
 * the graph pipeline. Phase[] programs are auto-converted via phasesToGraph().
 *
 * Two compilation modes:
 *   - Eager: static phases whose agent count is known at launch.
 *   - Deferred: dynamic phases compiled by the bridge at runtime.
 *
 * The compiler calls seed-resolver, hook-generator, fleet-provision for each node.
 */
import { writeFileSync, readFileSync as fsReadFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Program,
  ProgramGraph,
  ProgramEdge,
  Phase,
  AgentSpec,
  CompiledPlan,
  CompiledPhase,
  CompiledWindow,
  CompiledWorker,
  ProgramPipelineState,
} from "./types";
import { generatePipelineContext } from "./pipeline-context";
import { isDynamic } from "./types";
import { resolveSeedToFile, buildStateVars } from "./seed-resolver";
import { installPipelineHooks, installToolRestrictionHooks } from "./hook-generator";
import { FLEET_DATA } from "../../cli/lib/paths";
import { phasesToGraph, topologicalSort, buildNodeIndexMap, outgoingEdges, END_SENTINEL } from "./graph";

const HOME = process.env.HOME || "/tmp";

/**
 * Compile a full program (eager pass).
 * Always uses graph path — Phase[] programs auto-convert via phasesToGraph().
 */
export function compile(
  program: Program,
  state: ProgramPipelineState,
): CompiledPlan {
  const g = program.graph || phasesToGraph(program);
  return compileGraph(g, state);
}

/**
 * Compile a single phase from resolved agent specs.
 * Used both during eager compilation and by the bridge for deferred phases.
 */
export function compilePhase(
  phaseIndex: number,
  agents: AgentSpec[],
  phase: Phase,
  state: ProgramPipelineState,
  graph?: ProgramGraph,
): {
  phase: CompiledPhase;
  windows: CompiledWindow[];
  workers: CompiledWorker[];
} {
  const stateVars = buildStateVars(state);
  const defaultModel = state.defaults.model || "sonnet";
  const panesPerWindow = phase.layout?.panesPerWindow || 4;

  // Group agents by window
  const windowMap = new Map<string, AgentSpec[]>();
  for (const agent of agents) {
    const win = agent.window || phase.name;
    if (!windowMap.has(win)) windowMap.set(win, []);
    windowMap.get(win)!.push(agent);
  }

  const windows: CompiledWindow[] = [];
  const workers: CompiledWorker[] = [];

  for (const [winName, winAgents] of windowMap) {
    // Split large windows into multiple (4 panes each)
    const numSubWindows = Math.ceil(winAgents.length / panesPerWindow);

    for (let sw = 0; sw < numSubWindows; sw++) {
      const subAgents = winAgents.slice(sw * panesPerWindow, (sw + 1) * panesPerWindow);
      const windowName = numSubWindows > 1 ? `${winName}-${sw + 1}` : winName;

      windows.push({
        name: windowName,
        paneCount: subAgents.length,
        phase: phase.name,
        layout: phase.layout?.algorithm || "tiled",
      });

      for (let p = 0; p < subAgents.length; p++) {
        const agent = subAgents[p];
        const model = agent.model || defaultModel;

        // Generate pipeline context (unless agent opts out)
        let pipelineContext: string | undefined;
        if (graph && !agent.noPipelineContext) {
          pipelineContext = generatePipelineContext(agent, phase.name, agents, graph, state);
        }

        // Per-agent results directory (available as {{RESULTS_DIR}} in seed templates)
        const resultsDir = join(state.sessionDir, "results", agent.name);

        // Resolve seed
        const seedPath = resolveSeedToFile(
          agent,
          state,
          state.sessionDir,
          { ...stateVars, RESULTS_DIR: resultsDir, ...(agent.vars || {}) },
          pipelineContext,
        );

        const wrapperPath = join(state.sessionDir, `run-${agent.name}.sh`);

        workers.push({
          name: agent.name,
          role: agent.role,
          model,
          runtime: agent.runtime,
          customLauncher: agent.customLauncher,
          seedPath,
          wrapperPath,
          window: windowName,
          paneIndex: p,
          phaseIndex,
          sleepDuration: agent.sleepDuration,
          env: agent.env,
          permissionMode: agent.permissionMode,
          timeout: agent.timeout,
        });
      }
    }
  }

  const compiledPhase: CompiledPhase = {
    index: phaseIndex,
    name: phase.name,
    status: "compiled",
    agentCount: agents.length,
    agentNames: agents.map(a => a.name),
    dynamic: false,
  };

  return { phase: compiledPhase, windows, workers };
}

/**
 * Resolve which agents are the "gate" for a phase.
 * - Default: last agent only
 * - "all": all agents
 * - specific name: that agent
 */
function resolveGateAgents(phase: Phase, agents: AgentSpec[]): AgentSpec[] {
  if (!phase.gate || phase.gate === "all") {
    return phase.gate === "all" ? agents : [agents[agents.length - 1]];
  }

  const named = agents.find(a => a.name === phase.gate);
  return named ? [named] : [agents[agents.length - 1]];
}

// ── Graph Compilation ─────────────────────────────────────────

/**
 * Compile a ProgramGraph into a CompiledPlan.
 * Topological sort assigns stable indices. Edges become stop hook scripts
 * with embedded condition evaluation.
 */
export function compileGraph(
  g: ProgramGraph,
  state: ProgramPipelineState,
): CompiledPlan {
  const nodeIndexMap = buildNodeIndexMap(g);
  state.nodeIndexMap = nodeIndexMap;

  const plan: CompiledPlan = {
    program: { name: g.name, description: g.description },
    phases: [],
    windows: [],
    workers: [],
    hooks: [],
    sessionDir: state.sessionDir,
    programPath: state.programPath,
  };

  const sorted = topologicalSort(g);

  for (const nodeName of sorted) {
    const node = g.nodes[nodeName];
    const idx = nodeIndexMap[nodeName];

    // Build a Phase-like object for compilePhase compat
    const phaseCompat: Phase = {
      name: nodeName,
      description: node.description,
      agents: node.agents,
      gate: node.gate,
      layout: node.layout,
      prelaunch: node.prelaunch,
      hooks: node.hooks,
    };

    if (isDynamic(node.agents)) {
      // Deferred
      const estimate = node.agents.estimate || 4;
      plan.phases.push({
        index: idx,
        name: nodeName,
        status: "deferred",
        agentCount: estimate,
        agentNames: [],
        dynamic: true,
        estimate,
        nodeName,
      });

      const panesPerWindow = node.layout?.panesPerWindow || 4;
      const numWindows = Math.ceil(estimate / panesPerWindow);
      for (let w = 1; w <= numWindows; w++) {
        plan.windows.push({
          name: `${nodeName}-${w}`,
          paneCount: Math.min(panesPerWindow, estimate - (w - 1) * panesPerWindow),
          phase: nodeName,
          layout: node.layout?.algorithm || "tiled",
        });
      }
    } else {
      // Eager
      const compiled = compilePhase(idx, node.agents, phaseCompat, state, g);
      compiled.phase.nodeName = nodeName;
      plan.phases.push(compiled.phase);
      plan.windows.push(...compiled.windows);
      plan.workers.push(...compiled.workers);
    }

    // Install stop hooks based on outgoing edges
    const edges = outgoingEdges(g, nodeName);
    if (edges.length > 0 && !isDynamic(node.agents)) {
      const gateAgents = resolveGateAgents(phaseCompat, node.agents as AgentSpec[]);
      const isGateAll = node.gate === "all";

      for (const gateAgent of gateAgents) {
        // Generate edge-aware stop hook
        installGraphStopHook(
          gateAgent.name,
          state.fleetProject,
          state.sessionDir,
          nodeName,
          edges,
          nodeIndexMap,
          isGateAll ? gateAgents.length : undefined,
        );

        // Pick the default (unconditional or highest-priority) target for CompiledHook
        const defaultTarget = edges.find(e => !e.condition) || edges[0];
        const targetIdx = defaultTarget.to === END_SENTINEL ? -1 : nodeIndexMap[defaultTarget.to];

        plan.hooks.push({
          workerName: gateAgent.name,
          targetPhaseIndex: targetIdx,
          targetNodeName: defaultTarget.to,
          scriptPath: join(
            HOME, ".claude/fleet", state.fleetProject,
            gateAgent.name, "hooks", `node-${nodeName}-stop.sh`,
          ),
          sessionDirPath: state.sessionDir,
          gateCount: isGateAll ? gateAgents.length : undefined,
        });
      }
    }

    // Install pipeline hooks (phase-level + per-agent)
    if (node.hooks && node.hooks.length > 0 && !isDynamic(node.agents)) {
      for (const agent of node.agents as AgentSpec[]) {
        const workerHooksDir = join(FLEET_DATA, state.fleetProject, agent.name, "hooks");
        installPipelineHooks(workerHooksDir, node.hooks, g.name).catch(() => {});
      }
    }
    if (!isDynamic(node.agents)) {
      for (const agent of node.agents as AgentSpec[]) {
        if (agent.hooks && agent.hooks.length > 0) {
          const workerHooksDir = join(FLEET_DATA, state.fleetProject, agent.name, "hooks");
          installPipelineHooks(workerHooksDir, agent.hooks, g.name).catch(() => {});
        }
        // Install tool restriction hooks from allowedTools/deniedTools
        if (agent.allowedTools?.length || agent.deniedTools?.length) {
          const workerHooksDir = join(FLEET_DATA, state.fleetProject, agent.name, "hooks");
          installToolRestrictionHooks(workerHooksDir, agent.allowedTools, agent.deniedTools).catch(() => {});
        }
      }
    }
  }

  return plan;
}

/**
 * Generate a graph-aware stop hook that evaluates edge conditions.
 * Edges are checked in priority order. First condition that exits 0 wins.
 * Back-edges respect maxIterations.
 */
export function installGraphStopHook(
  workerName: string,
  project: string,
  sessionDir: string,
  fromNode: string,
  edges: ProgramEdge[],
  nodeIndexMap: Record<string, number>,
  gateCount?: number,
): void {
  const { mkdirSync, writeFileSync: wfs } = require("node:fs") as typeof import("node:fs");
  const workerHooksDir = join(FLEET_DATA, project, workerName, "hooks");
  mkdirSync(workerHooksDir, { recursive: true });

  const scriptName = `node-${fromNode}-stop.sh`;
  const destScript = join(workerHooksDir, scriptName);
  const FLEET_DIR_DEFAULT = join(process.env.HOME || "/tmp", ".claude-fleet");

  let script = `#!/usr/bin/env bash
# ${workerName} Stop -> edge evaluation from node "${fromNode}"
set -euo pipefail
SESSION_DIR="${sessionDir}"
FLEET_DIR="\${CLAUDE_FLEET_DIR:-${FLEET_DIR_DEFAULT}}"
`;

  // Gate-all preamble
  if (gateCount && gateCount > 1) {
    script += `
echo "done" > "$SESSION_DIR/${workerName}.done"
ACTUAL=$(ls "$SESSION_DIR"/*.done 2>/dev/null | wc -l | tr -d ' ')
if [ "$ACTUAL" -lt ${gateCount} ]; then
  exit 0
fi
`;
  }

  // Edge evaluation — check conditions in priority order
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const target = edge.to;
    const targetIdx = target === END_SENTINEL ? -1 : nodeIndexMap[target];

    if (edge.maxIterations) {
      // Back-edge with cycle limit
      const counterFile = `"$SESSION_DIR/cycle-${fromNode}-to-${target}.count"`;
      script += `
# Edge ${i}: ${edge.label || `${fromNode} -> ${target}`} (max ${edge.maxIterations} iterations)
CYCLE=$(cat ${counterFile} 2>/dev/null || echo 0)
`;
      if (edge.condition) {
        script += `if [ "$CYCLE" -lt ${edge.maxIterations} ] && (${edge.condition}); then
  echo $((CYCLE + 1)) > ${counterFile}
`;
      } else {
        script += `if [ "$CYCLE" -lt ${edge.maxIterations} ]; then
  echo $((CYCLE + 1)) > ${counterFile}
`;
      }

      if (target === END_SENTINEL) {
        script += `  exit 0\nfi\n`;
      } else {
        script += `  nohup bun "$FLEET_DIR/engine/program/bridge.ts" "$SESSION_DIR" "${targetIdx}" \\
    >> "$SESSION_DIR/bridge-${targetIdx}.log" 2>&1 &
  exit 0
fi
`;
      }
    } else if (edge.condition) {
      // Conditional edge
      script += `
# Edge ${i}: ${edge.label || `${fromNode} -> ${target}`} (conditional)
if (${edge.condition}); then
`;
      if (target === END_SENTINEL) {
        script += `  exit 0\nfi\n`;
      } else {
        script += `  nohup bun "$FLEET_DIR/engine/program/bridge.ts" "$SESSION_DIR" "${targetIdx}" \\
    >> "$SESSION_DIR/bridge-${targetIdx}.log" 2>&1 &
  exit 0
fi
`;
      }
    } else {
      // Unconditional edge (default)
      if (target === END_SENTINEL) {
        script += `
# Edge ${i}: ${edge.label || "pipeline complete"} (unconditional -> $end)
exit 0
`;
      } else {
        script += `
# Edge ${i}: ${edge.label || `${fromNode} -> ${target}`} (unconditional)
nohup bun "$FLEET_DIR/engine/program/bridge.ts" "$SESSION_DIR" "${targetIdx}" \\
  >> "$SESSION_DIR/bridge-${targetIdx}.log" 2>&1 &
exit 0
`;
      }
    }
  }

  // Fallback: if no edge matched, pipeline is done
  script += `
# No edge matched — pipeline complete
exit 0
`;

  wfs(destScript, script, { mode: 0o755 });

  // Write hooks.json
  const hooks = {
    hooks: [{
      id: "dh-1",
      event: "Stop",
      description: `Graph: edge evaluation from node "${fromNode}" (${workerName})`,
      blocking: false,
      completed: false,
      status: "active" as const,
      lifetime: "persistent" as const,
      script_path: scriptName,
      registered_by: "program-api",
      ownership: "creator" as const,
      added_at: new Date().toISOString(),
    }],
  };

  wfs(join(workerHooksDir, "hooks.json"), JSON.stringify(hooks, null, 2));
}

/**
 * Serialize pipeline state for bridge scripts.
 */
export function savePipelineState(state: ProgramPipelineState): void {
  writeFileSync(
    join(state.sessionDir, "pipeline-state.json"),
    JSON.stringify(state, null, 2),
  );
}

/**
 * Load pipeline state from session directory.
 */
export function loadPipelineState(sessionDir: string): ProgramPipelineState {
  const content = fsReadFileSync(join(sessionDir, "pipeline-state.json"), "utf-8");
  return JSON.parse(content) as ProgramPipelineState;
}
