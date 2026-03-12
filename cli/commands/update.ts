import type { Command } from "commander";
import { readdirSync } from "node:fs";
import chalk from "chalk";
import { FLEET_DIR, FLEET_DATA } from "../lib/paths";
import { getState, writeJsonLocked } from "../lib/config";
import { listPaneIds, killPane } from "../lib/tmux";
import { ok, info, warn, fail } from "../lib/fmt";

export function register(parent: Command): void {
  parent
    .command("update")
    .description("Pull latest fleet code, install deps, re-run setup")
    .option("--reload", "Recycle all running workers after update")
    .option("--extensions", "Build and install all extensions during setup")
    .action(async (opts: { reload?: boolean; extensions?: boolean }) => {
      console.log(`${chalk.bold("fleet update")} — updating fleet infrastructure\n`);

      // 1. git pull
      info("Pulling latest changes...");
      const pull = Bun.spawnSync(["git", "-C", FLEET_DIR, "pull", "origin", "main"], {
        stdout: "inherit",
        stderr: "inherit",
      });
      if (pull.exitCode !== 0) fail("git pull failed");
      ok("Code updated");

      // 2. bun install
      info("Installing dependencies...");
      const install = Bun.spawnSync(["bun", "install"], {
        cwd: FLEET_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      if (install.exitCode !== 0) fail("bun install failed");
      ok("Dependencies installed");

      // 3. Re-run fleet setup (pass --extensions if requested or if reloading)
      const setupArgs = ["bun", "run", "cli/index.ts", "setup"];
      if (opts.extensions || opts.reload) setupArgs.push("--extensions");
      info(`Running fleet setup${opts.extensions || opts.reload ? " --extensions" : ""}...`);
      const setup = Bun.spawnSync(setupArgs, {
        cwd: FLEET_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      if (setup.exitCode !== 0) fail("fleet setup failed");

      // 4. Recycle all running workers if --reload
      if (opts.reload) {
        console.log("");
        info("Reloading workers...");
        const panes = listPaneIds();
        let recycled = 0;

        let projects: string[];
        try {
          projects = readdirSync(FLEET_DATA, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
        } catch { projects = []; }

        for (const project of projects) {
          let workers: string[];
          try {
            workers = readdirSync(`${FLEET_DATA}/${project}`, { withFileTypes: true })
              .filter(d => d.isDirectory() && !["missions", "_user", "_config"].includes(d.name))
              .map(d => d.name);
          } catch { continue; }

          for (const name of workers) {
            const state = getState(project, name);
            const paneId = state?.pane_id;
            if (paneId && panes.has(paneId)) {
              // Set status to recycling so watchdog respawns with fresh config
              const { join } = require("node:path");
              const statePath = join(FLEET_DATA, project, name, "state.json");
              try {
                const stateData = JSON.parse(require("node:fs").readFileSync(statePath, "utf-8"));
                stateData.status = "recycling";
                delete stateData.sleep_until;
                writeJsonLocked(statePath, stateData);
              } catch {}
              killPane(paneId);
              info(`  Recycled ${name} (${project})`);
              recycled++;
            }
          }
        }

        if (recycled > 0) {
          ok(`Recycled ${recycled} worker(s) — watchdog will respawn with new config`);
        } else {
          warn("No running workers found to reload");
        }
      }

      console.log("");
      ok(chalk.bold("Fleet updated successfully."));
    });
}
