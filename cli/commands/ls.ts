import type { Command } from "commander";
import { readdirSync } from "node:fs";
import { FLEET_DATA } from "../lib/paths";
import { getConfig, getState } from "../lib/config";
import { listPaneIds } from "../lib/tmux";
import chalk from "chalk";
import { table, statusColor } from "../lib/fmt";
import { addGlobalOpts } from "../index";

export function register(parent: Command): void {
  const sub = parent
    .command("list")
    .alias("ls")
    .description("List all workers");
  addGlobalOpts(sub)
    .action((_opts: Record<string, unknown>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      const filterProject = globalOpts.project as string | undefined;
      const json = globalOpts.json as boolean;
      const panes = listPaneIds();
      const results: Array<{
        name: string; project: string; status: string;
        model: string; pane: string; window: string; branch: string; runtime: string;
      }> = [];

      // Iterate project dirs
      let projects: string[];
      try {
        projects = readdirSync(FLEET_DATA, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        projects = [];
      }

      for (const project of projects) {
        if (filterProject && project !== filterProject) continue;

        let workers: string[];
        try {
          workers = readdirSync(`${FLEET_DATA}/${project}`, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !["missions", "_user", "_config"].includes(d.name))
            .map((d) => d.name);
        } catch {
          continue;
        }

        for (const name of workers) {
          const config = getConfig(project, name);
          const state = getState(project, name);
          if (!config || !state) continue;

          let status = state.status || "unknown";
          // Liveness check: active but pane gone → dead
          if (status === "active" && state.pane_id && !panes.has(state.pane_id)) {
            status = "dead";
          }

          results.push({
            name,
            project,
            status,
            model: config.model || "-",
            pane: state.pane_id || "-",
            window: config.window || "-",
            branch: config.branch || "-",
            runtime: config.runtime || "claude",
          });
        }
      }

      if (json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (results.length === 0) {
        console.log("No workers found." + (filterProject ? ` (project: ${filterProject})` : ""));
        console.log(`  Run ${chalk.cyan("fleet create <name> <mission>")} to create one.`);
        return;
      }

      // Show PROJECT column when workers span multiple projects
      const uniqueProjects = new Set(results.map(r => r.project));
      if (uniqueProjects.size > 1) {
        table(
          ["NAME", "PROJECT", "STATUS", "RUNTIME", "MODEL", "PANE", "WINDOW", "BRANCH"],
          results.map((r) => [
            r.name, r.project, statusColor(r.status), r.runtime, r.model, r.pane, r.window, r.branch,
          ]),
        );
      } else {
        table(
          ["NAME", "STATUS", "RUNTIME", "MODEL", "PANE", "WINDOW", "BRANCH"],
          results.map((r) => [
            r.name, statusColor(r.status), r.runtime, r.model, r.pane, r.window, r.branch,
          ]),
        );
      }
    });
}
