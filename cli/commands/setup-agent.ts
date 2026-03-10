import type { Command } from "commander";
import { existsSync } from "node:fs";
import {
  FLEET_DATA, FLEET_DIR, DEFAULT_SESSION, resolveProject,
} from "../lib/paths";
import { getFleetConfig } from "../lib/config";
import {
  sessionExists, createSession, windowExists, createWindow,
  setPaneTitle, sendKeys, sendEnter, waitForPrompt, pasteBuffer,
} from "../lib/tmux";
import { info, ok, warn, fail } from "../lib/fmt";
import { addGlobalOpts } from "../index";

const WINDOW_NAME = "fleet-config";

const SEED = `You are the Fleet Configuration Agent — an interactive assistant for managing the fleet CLI and its workers.

Your context directories:
- Fleet data: All worker configs, states, defaults, fleet.json
- Fleet source: CLI code, MCP server, templates, hooks

You can help with:
- Viewing and modifying worker configs (model, effort, permissions, hooks, sleep_duration)
- Setting up new projects (fleet.json, defaults.json)
- Reviewing fleet health (dead workers, stale states, missing worktrees)
- Configuring Fleet Mail connections
- Registering/updating the MCP server
- Managing defaults and templates

Start by reading the fleet data directory to understand the current setup, then ask what the user would like to configure.`;

export function register(parent: Command): void {
  const sub = parent
    .command("setup-agent")
    .description("Launch interactive fleet configuration agent")
    .option("--model <model>", "Override model", "opus")
    .option("--effort <effort>", "Override effort", "high");
  addGlobalOpts(sub)
    .action(async (opts: { model: string; effort: string }, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      const project = globalOpts.project as string || resolveProject();
      const fleetConfig = getFleetConfig(project);
      const session = fleetConfig?.tmux_session || DEFAULT_SESSION;

      if (!existsSync(FLEET_DATA)) fail("Fleet not initialized. Run: fleet setup");

      info("Launching fleet configuration agent...");

      // Create pane in a dedicated window
      let paneId: string;
      if (!sessionExists(session)) {
        paneId = createSession(session, WINDOW_NAME, FLEET_DIR);
      } else if (windowExists(session, WINDOW_NAME)) {
        // Reuse existing fleet-config window — just focus it
        const result = Bun.spawnSync(
          ["tmux", "list-panes", "-t", `${session}:${WINDOW_NAME}`, "-F", "#{pane_id}"],
          { stderr: "pipe" },
        );
        if (result.exitCode === 0) {
          const existingPane = result.stdout.toString().trim().split("\n")[0];
          if (existingPane) {
            ok(`Fleet config window already exists — focusing pane ${existingPane}`);
            Bun.spawnSync(["tmux", "select-pane", "-t", existingPane]);
            Bun.spawnSync(["tmux", "select-window", "-t", `${session}:${WINDOW_NAME}`]);
            return;
          }
        }
        paneId = createWindow(session, WINDOW_NAME, FLEET_DIR);
      } else {
        paneId = createWindow(session, WINDOW_NAME, FLEET_DIR);
      }

      setPaneTitle(paneId, "fleet-config");

      // Launch claude with fleet context dirs
      let launchCmd = `cd "${FLEET_DIR}" && claude --model "${opts.model}" --effort "${opts.effort}"`;
      launchCmd += ` --dangerously-skip-permissions`;
      launchCmd += ` --add-dir "${FLEET_DATA}"`;
      launchCmd += ` --add-dir "${FLEET_DIR}"`;

      sendKeys(paneId, launchCmd);
      sendEnter(paneId);

      // Wait for TUI and inject seed
      info("Waiting for Claude TUI...");
      const ready = await waitForPrompt(paneId);
      if (!ready) warn("TUI timeout after 60s, proceeding anyway");
      await Bun.sleep(2000);

      const pasted = pasteBuffer(paneId, SEED);
      if (pasted) {
        await Bun.sleep(3000);
        sendEnter(paneId);
      } else {
        warn("Failed to inject seed — agent launched without context prompt");
      }

      ok(`Fleet config agent launched in ${session}:${WINDOW_NAME} (pane ${paneId})`);
      info("Switch to it with: fleet attach fleet-config (or tmux select-window)");
    });
}
