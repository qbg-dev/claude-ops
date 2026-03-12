/**
 * Graph-native program builder.
 *
 * Programs export a ProgramGraph — a directed graph of nodes (phases) and edges
 * (transitions). The builder provides a fluent API for constructing graphs,
 * embedding sub-programs, and converting legacy Phase[] programs.
 *
 * Reserved sentinel: "$end" — edges to "$end" mean pipeline complete.
 */
import type {
  ProgramGraph,
  ProgramNode,
  ProgramEdge,
  ProgramDefaults,
  ProgramMaterial,
  Program,
} from "./types";

const END_SENTINEL = "$end";

// ── Builder ───────────────────────────────────────────────────

export class ProgramBuilder {
  private _name: string;
  private _description?: string;
  private _nodes: Record<string, ProgramNode> = {};
  private _edges: ProgramEdge[] = [];
  private _entry?: string;
  private _defaults?: ProgramDefaults;
  private _material?: ProgramMaterial;

  constructor(name: string, description?: string) {
    this._name = name;
    this._description = description;
  }

  /** Add a node to the graph */
  node(name: string, node: ProgramNode): this {
    if (name === END_SENTINEL) throw new Error(`"${END_SENTINEL}" is reserved`);
    this._nodes[name] = node;
    // First node added becomes entry by default
    if (!this._entry) this._entry = name;
    return this;
  }

  /** Add an edge between nodes */
  edge(from: string, to: string, opts?: Partial<Omit<ProgramEdge, "from" | "to">>): this {
    this._edges.push({ from, to, ...opts });
    return this;
  }

  /** Set the entry node explicitly */
  entry(name: string): this {
    this._entry = name;
    return this;
  }

  /** Set program defaults */
  defaults(d: ProgramDefaults): this {
    this._defaults = d;
    return this;
  }

  /** Set program material */
  material(m: ProgramMaterial): this {
    this._material = m;
    return this;
  }

  /**
   * Embed a sub-program's graph with prefixed node names.
   * Internal edges are preserved as prefix.from → prefix.to.
   * Entry becomes prefix.entry. No auto-wiring — all connections
   * between subgraphs must be declared with .edge().
   */
  embed(sub: ProgramGraph, opts: { prefix: string }): this {
    const { prefix } = opts;
    const pfx = (name: string) => name === END_SENTINEL ? END_SENTINEL : `${prefix}.${name}`;

    // Copy nodes with prefixed names
    for (const [name, node] of Object.entries(sub.nodes)) {
      this._nodes[pfx(name)] = node;
    }

    // Copy internal edges with prefixed names
    for (const edge of sub.edges) {
      this._edges.push({
        ...edge,
        from: pfx(edge.from),
        to: pfx(edge.to),
      });
    }

    // If this builder has no entry yet, use the sub's entry
    if (!this._entry) {
      this._entry = pfx(sub.entry);
    }

    // Inherit defaults/material if not set
    if (!this._defaults && sub.defaults) this._defaults = sub.defaults;
    if (!this._material && sub.material) this._material = sub.material;

    return this;
  }

  /** Validate and build the ProgramGraph */
  build(): ProgramGraph {
    if (!this._entry) throw new Error("Graph has no entry node");
    if (!this._nodes[this._entry]) throw new Error(`Entry node "${this._entry}" not found`);

    // Validate edges reference existing nodes
    for (const edge of this._edges) {
      if (edge.from !== END_SENTINEL && !this._nodes[edge.from]) {
        throw new Error(`Edge references unknown source node: "${edge.from}"`);
      }
      if (edge.to !== END_SENTINEL && !this._nodes[edge.to]) {
        throw new Error(`Edge references unknown target node: "${edge.to}"`);
      }
    }

    return {
      name: this._name,
      description: this._description,
      nodes: this._nodes,
      edges: this._edges,
      entry: this._entry,
      defaults: this._defaults,
      material: this._material,
    };
  }
}

/** Create a new program graph builder */
export function graph(name: string, description?: string): ProgramBuilder {
  return new ProgramBuilder(name, description);
}

// ── Legacy Conversion ─────────────────────────────────────────

/**
 * Convert a legacy Phase[] program to a ProgramGraph.
 * Each phase becomes a node named after phase.name.
 * Sequential phases get edges, phase.next creates explicit edges,
 * convergence becomes conditional back-edges.
 */
export function phasesToGraph(program: Program): ProgramGraph {
  const { name, description, phases, defaults, material } = program;
  const builder = new ProgramBuilder(name, description);

  if (phases.length === 0) {
    throw new Error("Cannot convert empty Phase[] to graph");
  }

  // Deduplicate node names (phases can share names across different indices)
  const nodeNames: string[] = [];
  const nameCount: Record<string, number> = {};
  for (const phase of phases) {
    nameCount[phase.name] = (nameCount[phase.name] || 0) + 1;
  }
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    const nodeName = nameCount[phase.name] > 1 ? `${phase.name}-${i}` : phase.name;
    nodeNames.push(nodeName);
  }

  // Add nodes
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];
    builder.node(nodeNames[i], {
      description: phase.description,
      agents: phase.agents,
      gate: phase.gate,
      layout: phase.layout,
      prelaunch: phase.prelaunch,
      hooks: phase.hooks,
    });
  }

  // Add edges
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i];

    if (phase.convergence) {
      // Convergence: conditional back-edge + forward edge
      const cycleTarget = typeof phase.next === "number" ? phase.next : i;
      const forwardTarget = i + 1 < phases.length ? i + 1 : null;

      // Back-edge (cycle): condition is "NOT converged" — i.e., score below threshold
      builder.edge(nodeNames[i], nodeNames[cycleTarget], {
        condition: negateCondition(phase.convergence.check),
        maxIterations: phase.convergence.maxIterations || 10,
        label: "not converged",
        priority: 0,
      });

      // Forward edge (converged or exhausted)
      if (forwardTarget !== null) {
        builder.edge(nodeNames[i], nodeNames[forwardTarget], {
          label: "converged",
          priority: 1,
        });
      } else {
        builder.edge(nodeNames[i], END_SENTINEL, {
          label: "converged",
          priority: 1,
        });
      }
    } else if (phase.next !== undefined && typeof phase.next === "number") {
      // Explicit next
      builder.edge(nodeNames[i], nodeNames[phase.next]);
    } else if (i + 1 < phases.length) {
      // Default sequential
      builder.edge(nodeNames[i], nodeNames[i + 1]);
    }
    // Last phase with no explicit next: implicit $end (no edge needed)
  }

  if (defaults) builder.defaults(defaults);
  if (material) builder.material(material);

  // Set entry to first node
  builder.entry(nodeNames[0]);

  return builder.build();
}

/**
 * Negate a bash condition for convergence back-edges.
 * If check is `test $(cat score.txt) -ge 80`, we want `! (test ...)`.
 */
function negateCondition(check: string): string {
  return `! (${check})`;
}

// ── Graph Utilities ───────────────────────────────────────────

/**
 * Topological sort of graph nodes. Returns node names in execution order.
 * Handles cycles by breaking back-edges (edges with maxIterations).
 */
export function topologicalSort(g: ProgramGraph): string[] {
  const nodes = Object.keys(g.nodes);
  const visited = new Set<string>();
  const result: string[] = [];

  // Build adjacency list (skip back-edges for sort purposes)
  const adj: Record<string, string[]> = {};
  for (const name of nodes) adj[name] = [];
  for (const edge of g.edges) {
    if (edge.to === END_SENTINEL) continue;
    if (edge.maxIterations) continue; // Back-edge — skip for topo sort
    if (adj[edge.from]) adj[edge.from].push(edge.to);
  }

  function visit(name: string) {
    if (visited.has(name)) return;
    visited.add(name);
    for (const next of adj[name] || []) visit(next);
    result.push(name);
  }

  // Start from entry
  visit(g.entry);
  // Visit any disconnected nodes
  for (const name of nodes) visit(name);

  return result.reverse();
}

/**
 * Build a stable index map: node name → integer index.
 * Used for bridge compat (phases indexed by number).
 */
export function buildNodeIndexMap(g: ProgramGraph): Record<string, number> {
  const sorted = topologicalSort(g);
  const map: Record<string, number> = {};
  for (let i = 0; i < sorted.length; i++) {
    map[sorted[i]] = i;
  }
  return map;
}

/**
 * Get outgoing edges from a node, sorted by priority (lower first).
 */
export function outgoingEdges(g: ProgramGraph, nodeName: string): ProgramEdge[] {
  return g.edges
    .filter(e => e.from === nodeName)
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
}

export { END_SENTINEL };
