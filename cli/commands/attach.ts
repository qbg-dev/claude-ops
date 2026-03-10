import { defineCommand } from "citty";
import { resolveProject } from "../lib/paths";
import { getState } from "../lib/config";
import { listPaneIds } from "../lib/tmux";
import { fail } from "../lib/fmt";

export default defineCommand({
  meta: { name: "attach", description: "Focus a worker's tmux pane" },
  args: {
    name:    { type: "positional", description: "Worker name", required: true },
    project: { type: "string", description: "Override project detection" },
  },
  run({ args }) {
    const project = args.project || resolveProject();
    const state = getState(project, args.name);
    if (!state) fail(`Worker '${args.name}' not found in project '${project}'`);

    const paneId = state!.pane_id;
    if (!paneId) fail(`Worker '${args.name}' has no active pane (status: ${state!.status})`);
    if (!listPaneIds().has(paneId)) fail(`Pane ${paneId} no longer exists. Try: fleet start ${args.name}`);

    // Switch to the worker's pane
    const result = Bun.spawnSync(["tmux", "select-pane", "-t", paneId]);
    if (result.exitCode !== 0) {
      // If select-pane fails (e.g., different session), try switch-client
      Bun.spawnSync(["tmux", "switch-client", "-t", paneId]);
    }
  },
});
