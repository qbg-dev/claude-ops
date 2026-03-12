/**
 * Worker builder helpers — reduce ceremony when declaring agents in programs.
 *
 * workerTeam() generates N agents with auto window grouping.
 * coordinator() creates a standard coordinator agent.
 */
import type { AgentSpec, SeedSpec } from "./types";

/**
 * Generate a team of workers with auto window grouping.
 *
 * Example:
 *   workerTeam({
 *     prefix: "worker",
 *     count: 8,
 *     role: "reviewer",
 *     seed: { template: "deep-review/worker-seed.md" },
 *     varsPerWorker: (i) => ({ SPECIALIZATION: focusAreas[i] }),
 *   })
 *   // → 8 AgentSpec[] across 2 windows (workers-1, workers-2)
 */
export function workerTeam(opts: {
  prefix: string;
  count: number;
  role: string;
  model?: string;
  seed: SeedSpec;
  varsPerWorker?: (index: number) => Record<string, string>;
  panesPerWindow?: number;
  windowPrefix?: string;
  hooks?: AgentSpec["hooks"];
  sleepDuration?: number | null;
}): AgentSpec[] {
  const agents: AgentSpec[] = [];
  const ppw = opts.panesPerWindow || 4;
  const winPrefix = opts.windowPrefix || opts.prefix + "s";

  for (let i = 0; i < opts.count; i++) {
    const windowGroup = Math.floor(i / ppw) + 1;
    const vars = opts.varsPerWorker ? opts.varsPerWorker(i) : {};

    agents.push({
      name: `${opts.prefix}-${i + 1}`,
      role: opts.role,
      model: opts.model,
      seed: opts.seed,
      window: `${winPrefix}-${windowGroup}`,
      vars,
      hooks: opts.hooks,
      sleepDuration: opts.sleepDuration,
    });
  }

  return agents;
}

/**
 * Create a standard coordinator agent.
 */
export function coordinator(opts: {
  name?: string;
  role?: string;
  model?: string;
  seed: SeedSpec;
  window?: string;
  vars?: Record<string, string>;
  hooks?: AgentSpec["hooks"];
}): AgentSpec {
  return {
    name: opts.name || "coordinator",
    role: opts.role || "coordinator",
    model: opts.model,
    seed: opts.seed,
    window: opts.window || "coordinator",
    vars: opts.vars,
    hooks: opts.hooks,
  };
}
