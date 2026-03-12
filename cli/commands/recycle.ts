import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DATA, DEFAULT_SESSION, workerDir, resolveProject } from "../lib/paths";
import { getConfig, getFleetConfig, getState, writeJsonLocked } from "../lib/config";
import { info, ok, warn, fail } from "../lib/fmt";
import { listPaneIds, killPane } from "../lib/tmux";
import { launchInTmux } from "../lib/launch";
import { syncWorktree } from "../lib/worktree";
import { addGlobalOpts } from "../index";

/**
 * fleet recycle <name> — Stop + restart a worker with fresh context.
 * Kills the existing pane, then immediately relaunches (no watchdog race).
 * The watchdog sees the new pane as alive and skips it.
 */
export function register(parent: Command): void {
  const sub = parent
    .command("recycle [name]")
    .description("Restart a worker with fresh context (stop + start, no watchdog race)")
    .option("-a, --all", "Recycle all workers");
  addGlobalOpts(sub)
    .action(async (name: string | undefined, opts: { all?: boolean }, cmd: Command) => {
      const project = cmd.optsWithGlobals().project as string || resolveProject();

      if (opts.all) {
        const projectDir = join(FLEET_DATA, project);
        if (!existsSync(projectDir)) fail(`Project '${project}' not found`);
        const { readdirSync } = await import("node:fs");
        const workers = readdirSync(projectDir, { withFileTypes: true })
          .filter(d => d.isDirectory() && !["missions", "_user", "_config"].includes(d.name))
          .map(d => d.name);
        for (const w of workers) {
          await recycleOne(w, project);
        }
        ok(`Recycled ${workers.length} workers`);
        return;
      }

      if (!name) return fail("Provide a worker name or use --all");
      await recycleOne(name, project);
    });
}

async function recycleOne(name: string, project: string): Promise<void> {
  const dir = workerDir(project, name);
  if (!existsSync(dir)) { warn(`Worker '${name}' not found`); return; }

  const state = getState(project, name);
  const panes = listPaneIds();
  const paneId = state?.pane_id;

  // 1. Kill existing pane if alive
  if (paneId && panes.has(paneId)) {
    killPane(paneId);
    info(`Killed pane ${paneId}`);
  }

  // 2. Clear sleep/recycling state so it launches clean
  const statePath = join(dir, "state.json");
  if (existsSync(statePath)) {
    try {
      const stateData = JSON.parse(require("node:fs").readFileSync(statePath, "utf-8"));
      stateData.status = "active";
      delete stateData.sleep_until;
      if (stateData.custom) delete stateData.custom.sleep_until;
      writeJsonLocked(statePath, stateData);
    } catch {}
  }

  // 3. Immediately relaunch (no watchdog dependency)
  const config = getConfig(project, name);
  if (!config) { warn(`No config for '${name}', skipping relaunch`); return; }

  const window = config.window || name;
  const fleetConfig = getFleetConfig(project);
  const session = fleetConfig?.tmux_session || DEFAULT_SESSION;

  // Re-sync worktree files before relaunch
  if (config.worktree) {
    const projectRoot = config.worktree.replace(/-w-[^/]+$/, "");
    syncWorktree({ name, project, projectRoot, worktreeDir: config.worktree });
  }

  try {
    await launchInTmux(name, project, session, window);
    ok(`Recycled '${name}' (stop + start)`);
  } catch (e) {
    warn(`Killed '${name}' but relaunch failed: ${e}`);
    info("Watchdog will pick it up on next poll");
  }
}
