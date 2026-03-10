import type { Command } from "commander";
import { readdirSync } from "node:fs";
import { FLEET_DATA, resolveProject } from "../lib/paths";
import { addGlobalOpts } from "../index";
import { runCreate } from "./create";

/** Find the next available run-NNN name */
function nextRunName(project: string): string {
  const projectDir = `${FLEET_DATA}/${project}`;
  let existing: string[] = [];
  try {
    existing = readdirSync(projectDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith("run-"))
      .map(d => d.name);
  } catch {}

  let n = 1;
  while (existing.includes(`run-${n}`)) n++;
  return `run-${n}`;
}

export function register(parent: Command): void {
  const sub = parent
    .command("run [name]")
    .description("Launch an interactive worker (like claude)")
    .option("--model <model>", "Override model")
    .option("--effort <effort>", "Override effort")
    .option("--permission-mode <mode>", "Override permission mode")
    .option("--window <name>", "tmux window group")
    .option("--window-index <index>", "Explicit window position")
    .option("--type <type>", "Worker archetype template");
  addGlobalOpts(sub)
    .action(async (name: string | undefined, opts: {
      model?: string; effort?: string; permissionMode?: string;
      window?: string; windowIndex?: string; type?: string;
    }, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      const project = globalOpts.project as string || resolveProject();
      const workerName = name || nextRunName(project);

      await runCreate(workerName, "Interactive session", {
        model: opts.model,
        effort: opts.effort,
        permissionMode: opts.permissionMode,
        window: opts.window || workerName,
        windowIndex: opts.windowIndex,
        type: opts.type,
        noLaunch: false,
      }, globalOpts);
    });
}
