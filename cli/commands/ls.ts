import { defineCommand } from "citty";
import { readdirSync } from "node:fs";
import { FLEET_DATA } from "../lib/paths";
import { getConfig, getState } from "../lib/config";
import { listPaneIds } from "../lib/tmux";
import { table, statusColor } from "../lib/fmt";

export default defineCommand({
  meta: { name: "ls", description: "List all workers" },
  args: {
    project: { type: "string", description: "Filter by project" },
    json: { type: "boolean", description: "Machine-readable JSON output", default: false },
  },
  run({ args }) {
    const panes = listPaneIds();
    const results: Array<{
      name: string; project: string; status: string;
      model: string; pane: string; window: string; branch: string;
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
      if (args.project && project !== args.project) continue;

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
        });
      }
    }

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (results.length === 0) {
      console.log("  (no workers found)");
      return;
    }

    table(
      ["NAME", "STATUS", "MODEL", "PANE", "WINDOW", "BRANCH"],
      results.map((r) => [
        r.name, statusColor(r.status), r.model, r.pane, r.window, r.branch,
      ]),
    );
  },
});
