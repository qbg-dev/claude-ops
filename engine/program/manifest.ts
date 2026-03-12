/**
 * Manifest generation — human-readable pipeline overview for window 0.
 *
 * Generated from the Program declaration at launch.
 * Updated by the bridge when dynamic phases compile (replaces DYNAMIC placeholders).
 * Always uses graph-native format (Phase[] auto-converted by compiler).
 */
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Program, ProgramGraph, CompiledPhase, ProgramPipelineState } from "./types";
import { isDynamic } from "./types";
import { phasesToGraph, topologicalSort, outgoingEdges, END_SENTINEL } from "./graph";

/**
 * Generate the initial manifest from the program declaration.
 * Always uses graph format — Phase[] programs auto-convert.
 */
export function generateManifest(
  program: Program,
  state: ProgramPipelineState,
  compiledPhases: CompiledPhase[],
): string {
  const g = program.graph || phasesToGraph(program);
  return generateGraphManifest(g, state, compiledPhases);
}

/**
 * Generate manifest for a graph-based program.
 * Shows nodes, edges (with conditions/labels), and topology.
 */
function generateGraphManifest(
  g: ProgramGraph,
  state: ProgramPipelineState,
  compiledPhases: CompiledPhase[],
): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const sorted = topologicalSort(g);

  // Node listing
  let nodesSection = "";
  for (let i = 0; i < sorted.length; i++) {
    const nodeName = sorted[i];
    const node = g.nodes[nodeName];
    const compiled = compiledPhases.find(p => p.nodeName === nodeName);
    const isEntry = nodeName === g.entry;
    const status = isEntry ? "RUNNING" : compiled?.status === "compiled" ? "READY" : "PENDING";
    const dynamic = isDynamic(node.agents) ? ", DYNAMIC" : "";

    nodesSection += `  ${isEntry ? ">" : " "} ${nodeName.padEnd(24)} [${status}${dynamic}]\n`;

    if (compiled?.status === "compiled") {
      for (const name of compiled.agentNames) {
        nodesSection += `      ${name}\n`;
      }
    } else if (isDynamic(node.agents)) {
      const est = node.agents.estimate || "?";
      nodesSection += `      ~${est} agents (dynamic)\n`;
    } else {
      for (const agent of node.agents) {
        const model = agent.model || state.defaults.model || "default";
        nodesSection += `      ${agent.name} (${model})\n`;
      }
    }

    if (node.hooks && node.hooks.length > 0) {
      nodesSection += `      Hooks: ${node.hooks.map(h => `${h.event}:${h.type}`).join(", ")}\n`;
    }

    nodesSection += "\n";
  }

  // Edge table
  let edgesSection = "";
  for (const edge of g.edges) {
    const cond = edge.condition ? ` [if: ${edge.condition.slice(0, 50)}${edge.condition.length > 50 ? "..." : ""}]` : "";
    const iter = edge.maxIterations ? ` (max ${edge.maxIterations}x)` : "";
    const label = edge.label ? ` "${edge.label}"` : "";
    edgesSection += `  ${edge.from} -> ${edge.to}${label}${cond}${iter}\n`;
  }

  // Topology line: entry -> ... -> terminal
  const terminals = sorted.filter(n => {
    const edges = outgoingEdges(g, n);
    return edges.length === 0 || edges.every(e => e.to === END_SENTINEL);
  });
  const topology = `  ${g.entry} -> ... -> ${terminals.join(", ") || "$end"}`;

  // Window listing
  let windowList = "  :0 manifest\n";
  const windowNames = new Set<string>();
  for (const nodeName of sorted) {
    const node = g.nodes[nodeName];
    if (isDynamic(node.agents)) {
      const est = node.agents.estimate || 4;
      const numWindows = Math.ceil(est / (node.layout?.panesPerWindow || 4));
      for (let w = 1; w <= numWindows; w++) windowNames.add(`${nodeName}-${w}`);
    } else {
      for (const agent of node.agents) windowNames.add(agent.window || nodeName);
    }
  }
  for (const name of windowNames) windowList += `  :${name}\n`;

  const manifest = `═══════════════════════════════════════════════════
  PIPELINE: ${g.name} (graph)
  Session:  ${state.tmuxSession}
  Created:  ${now}
═══════════════════════════════════════════════════

${state.material ? `MATERIAL
────────
  Scope:     ${state.material.diffDesc || state.material.materialType}
  Lines:     ${state.material.diffLines}
  Type:      ${state.material.materialType}
${state.spec ? `  Spec:      ${state.spec}\n` : ""}
` : ""}NODES (${sorted.length})
──────${sorted.length >= 10 ? "─" : ""}
${nodesSection}
EDGES (${g.edges.length})
──────${g.edges.length >= 10 ? "─" : ""}
${edgesSection}
TOPOLOGY
────────
${topology}

WINDOWS
───────
${windowList}
FILES
─────
  Program:  ${state.programPath}
  State:    ${state.sessionDir}/pipeline-state.json
  Cleanup:  ${state.sessionDir}/cleanup.sh
  Manifest: ${state.sessionDir}/manifest.txt

ATTACH
──────
  tmux switch-client -t ${state.tmuxSession}
  tmux a -t ${state.tmuxSession}
`;

  const manifestPath = join(state.sessionDir, "manifest.txt");
  writeFileSync(manifestPath, manifest);
  return manifestPath;
}

/**
 * Update manifest after a dynamic phase compiles.
 * Replaces the DYNAMIC placeholder with actual agent details.
 */
export function updateManifest(
  state: ProgramPipelineState,
  phaseIndex: number,
  agentNames: string[],
): void {
  const manifestPath = join(state.sessionDir, "manifest.txt");
  if (!existsSync(manifestPath)) return;

  let content = readFileSync(manifestPath, "utf-8");

  // Replace PENDING status with COMPILED
  const pendingPattern = new RegExp(
    `(Phase ${phaseIndex}: \\S+\\s+)\\[PENDING[^\\]]*\\]`,
  );
  content = content.replace(pendingPattern, `$1[COMPILED]`);

  // Replace estimate line with actual agents
  const dynamicPattern = new RegExp(
    `    ~\\d+\\?? agents — count determined by previous phase\\n(    Fallback: \\d+ static agents\\n)?`,
  );
  const agentList = agentNames.map(n => `    ${n}`).join("\n") + "\n";
  content = content.replace(dynamicPattern, agentList);

  writeFileSync(manifestPath, content);
}
