import { defineCommand } from "citty";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DATA, workerDir, resolveProject } from "../lib/paths";
import { getState, writeJson } from "../lib/config";
import { info, ok, warn, fail } from "../lib/fmt";
import { gracefulStop, listPaneIds } from "../lib/tmux";

async function stopWorker(name: string, project: string): Promise<void> {
  const dir = workerDir(project, name);
  const statePath = join(dir, "state.json");

  if (!existsSync(statePath)) {
    warn(`State not found for '${name}'`);
    return;
  }

  const state = getState(project, name);
  const paneId = state?.pane_id;

  if (!paneId) {
    warn(`'${name}' has no pane — marking idle`);
    writeJson(statePath, { ...state, status: "idle", pane_id: null, pane_target: null });
    return;
  }

  if (!listPaneIds().has(paneId)) {
    warn(`'${name}' pane ${paneId} is already gone — marking idle`);
    writeJson(statePath, { ...state, status: "idle", pane_id: null, pane_target: null });
    return;
  }

  info(`Stopping '${name}' (pane ${paneId})`);
  await gracefulStop(paneId);

  writeJson(statePath, { ...state, status: "idle", pane_id: null, pane_target: null });
  ok(`Worker '${name}' stopped`);
}

export default defineCommand({
  meta: { name: "stop", description: "Graceful stop" },
  args: {
    name:    { type: "positional", description: "Worker name", required: false },
    all:     { type: "boolean", description: "Stop all workers", default: false },
    project: { type: "string", description: "Override project detection" },
  },
  async run({ args }) {
    const project = args.project || resolveProject();

    if (args.all) {
      const projectDir = join(FLEET_DATA, project);
      if (!existsSync(projectDir)) fail(`Project not found: ${project}`);

      let stopped = 0;
      const workers = readdirSync(projectDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !["missions", "_user", "_config"].includes(d.name))
        .map((d) => d.name);

      for (const w of workers) {
        const state = getState(project, w);
        if (!state || (state.status !== "active" && state.status !== "sleeping")) continue;
        await stopWorker(w, project);
        stopped++;
      }

      if (stopped === 0) info("No active workers to stop");
      return;
    }

    if (!args.name) fail("Usage: fleet stop <name> [--all]");
    await stopWorker(args.name!, project);
  },
});
