import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLEET_DATA, FLEET_DIR, DEFAULT_SESSION, resolveProject,
} from "../lib/paths";
import { getFleetConfig } from "../lib/config";
import {
  sessionExists, createSession, windowExists, createWindow,
  setPaneTitle, sendKeys, sendEnter, waitForPrompt, pasteBuffer,
} from "../lib/tmux";
import { info, ok, warn } from "../lib/fmt";
import { addGlobalOpts } from "../index";

const WINDOW_NAME = "fleet-onboard";

/** Detect if we're inside a tmux pane already */
function currentTmuxPane(): string | null {
  return process.env.TMUX_PANE || null;
}

/**
 * The seed is intentionally lean — it tells the agent WHERE to find
 * authoritative docs (CLAUDE.md, README.md, templates) rather than
 * duplicating them. The agent reads the source files directly.
 *
 * Source of truth: templates/onboarding-architect.md
 */
function buildSeed(): string {
  const templatePath = join(FLEET_DIR, "templates/onboarding-architect.md");
  return readFileSync(templatePath, "utf-8");
}

/**
 * Inject @fleet.md reference into global CLAUDE.md so every session
 * has fleet context. Creates symlink ~/.claude/fleet.md → fleet CLAUDE.md.
 */
function injectFleetContext(): void {
  const HOME = process.env.HOME || "/tmp";
  const globalClaudeMd = join(HOME, ".claude/CLAUDE.md");
  const symlinkPath = join(HOME, ".claude/fleet.md");
  const fleetClaudeMd = join(FLEET_DIR, "CLAUDE.md");

  // Create symlink
  if (!existsSync(symlinkPath)) {
    Bun.spawnSync(["ln", "-sfn", fleetClaudeMd, symlinkPath]);
  }

  // Add @fleet.md to global CLAUDE.md if not already there
  if (existsSync(globalClaudeMd)) {
    const content = readFileSync(globalClaudeMd, "utf-8");
    if (!content.includes("@fleet.md") && !content.includes("@claude-fleet")) {
      // Find a good insertion point — after </tools> if it exists, otherwise append
      const toolsEnd = content.indexOf("</tools>");
      if (toolsEnd !== -1) {
        const insertAt = content.indexOf("\n", toolsEnd) + 1;
        const before = content.slice(0, insertAt);
        const after = content.slice(insertAt);
        writeFileSync(globalClaudeMd, `${before}\n@fleet.md\n${after}`);
      } else {
        writeFileSync(globalClaudeMd, `${content}\n@fleet.md\n`);
      }
      ok("Added @fleet.md to ~/.claude/CLAUDE.md");
    }
  }
}

export function register(parent: Command): void {
  const sub = parent
    .command("onboard")
    .description("Set up fleet infrastructure and launch the fleet architect agent")
    .option("--model <model>", "Override model", "opus")
    .option("--effort <effort>", "Override effort", "high")
    .option("--skip-setup", "Skip fleet setup (already done)");
  addGlobalOpts(sub)
    .action(async (opts: { model: string; effort: string; skipSetup?: boolean }, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals();
      const project = globalOpts.project as string || resolveProject();
      const fleetConfig = getFleetConfig(project);
      const session = fleetConfig?.tmux_session || DEFAULT_SESSION;

      // Step 1: Run fleet setup (unless skipped)
      if (!opts.skipSetup) {
        info("Running fleet setup first...");
        const setupResult = Bun.spawnSync(
          ["bun", "run", join(FLEET_DIR, "cli/index.ts"), "setup"],
          { stdout: "inherit", stderr: "inherit" },
        );
        if (setupResult.exitCode !== 0) {
          warn("Fleet setup had issues — details above. Common fixes:");
          console.log("");
          console.log("  Fleet Mail not available? Two paths:");
          console.log("    1. Install Rust:  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh");
          console.log("       Then re-run:   fleet onboard");
          console.log("    2. Use remote:    fleet mail-server connect http://your-server:8026");
          console.log("");
          warn("Continuing with onboard anyway — some features may not work without Fleet Mail");
        }
        console.log("");
      }

      // Step 2: Inject @fleet.md into global CLAUDE.md
      injectFleetContext();

      // Step 3: Install full hook manifest (setup only installs 4 events; manifest has 18)
      info("Installing full hook manifest...");
      const setupHooks = join(FLEET_DIR, "scripts/setup-hooks.sh");
      if (existsSync(setupHooks)) {
        const hookResult = Bun.spawnSync(["bash", setupHooks], {
          stdout: "inherit", stderr: "inherit",
        });
        if (hookResult.exitCode !== 0) {
          warn("Hook installation had issues");
        }
      }

      // Step 4: Install watchdog if not already
      const watchdogPlist = join(
        process.env.HOME || "/tmp",
        "Library/LaunchAgents/com.tmux-agents.watchdog.plist",
      );
      if (!existsSync(watchdogPlist)) {
        info("Installing watchdog daemon...");
        // Prefer Rust binary (boring-watchdog) over TypeScript
        const rustBinary = join(FLEET_DIR, "extensions/watchdog-rs/target/release/boring-watchdog");
        const rustCargoDir = join(FLEET_DIR, "extensions/watchdog-rs");
        if (existsSync(join(rustCargoDir, "Cargo.toml"))) {
          // Build Rust watchdog if not already built
          if (!existsSync(rustBinary)) {
            info("Building Rust watchdog (boring-watchdog)...");
            const build = Bun.spawnSync(
              ["cargo", "build", "--release"],
              { cwd: rustCargoDir, stdout: "inherit", stderr: "inherit" },
            );
            if (build.exitCode !== 0) {
              warn("Rust build failed — falling back to TypeScript watchdog");
            }
          }
          if (existsSync(rustBinary)) {
            const install = Bun.spawnSync(
              [rustBinary, "install"],
              { stdout: "inherit", stderr: "inherit" },
            );
            if (install.exitCode === 0) {
              ok("Rust watchdog (boring-watchdog) installed");
            } else {
              warn("Rust watchdog install failed — falling back to TypeScript");
            }
          }
        }
        // Fallback to TypeScript watchdog
        if (!existsSync(watchdogPlist)) {
          const installScript = join(FLEET_DIR, "extensions/watchdog/install.sh");
          if (existsSync(installScript)) {
            Bun.spawnSync(["bash", installScript], {
              stdout: "inherit", stderr: "inherit",
              env: { ...process.env, PROJECT_ROOT: process.cwd() },
            });
          }
        }
      } else {
        ok("Watchdog already installed");
      }

      console.log("");

      // Step 5: Launch the fleet architect agent
      info("Launching fleet architect...");

      if (!existsSync(FLEET_DATA)) {
        mkdirSync(FLEET_DATA, { recursive: true });
      }

      // If we're already inside a tmux pane, launch directly here
      const callingPane = currentTmuxPane();
      if (callingPane) {
        info(`Detected TMUX_PANE=${callingPane} — launching in current pane`);
        setPaneTitle(callingPane, "fleet-architect");

        // Write seed to temp file for tmux paste injection
        const seed = buildSeed();
        const seedFile = `/tmp/fleet-onboard-seed-${process.pid}.txt`;
        writeFileSync(seedFile, seed);

        // Launch Claude interactively in current pane.
        // Background subshell injects seed via tmux paste after TUI starts.
        // exec replaces this process so Claude gets the TTY.
        const wrapper = `/tmp/fleet-onboard-wrapper-${process.pid}.sh`;
        const script = `#!/usr/bin/env bash
(sleep 5 && tmux load-buffer "${seedFile}" && tmux paste-buffer -t "${callingPane}" && sleep 1 && tmux send-keys -t "${callingPane}" Enter && sleep 2 && rm -f "${seedFile}" "${wrapper}") &
exec claude --model "${opts.model}" --effort "${opts.effort}" --dangerously-skip-permissions --add-dir "${FLEET_DIR}" --add-dir "${FLEET_DATA}"
`;
        writeFileSync(wrapper, script, { mode: 0o755 });

        info("Handing off to Claude...");
        console.log("");

        // exec the wrapper — this replaces our process
        const { execSync } = require("node:child_process");
        try {
          execSync(`exec bash "${wrapper}"`, {
            cwd: process.cwd(),
            stdio: "inherit",
          });
        } catch {}

        // If we get here (shouldn't with exec), clean up
        ok("Fleet architect session ended.");
        info("To continue onboarding or make changes: fleet onboard");
        process.exit(0);
        return;
      }

      // Not in tmux — create a session/window as before
      let paneId: string;
      if (!sessionExists(session)) {
        paneId = createSession(session, WINDOW_NAME, process.cwd());
      } else if (windowExists(session, WINDOW_NAME)) {
        const result = Bun.spawnSync(
          ["tmux", "list-panes", "-t", `${session}:${WINDOW_NAME}`, "-F", "#{pane_id}"],
          { stderr: "pipe" },
        );
        if (result.exitCode === 0) {
          const existingPane = result.stdout.toString().trim().split("\n")[0];
          if (existingPane) {
            ok(`Onboard window already exists — focusing pane ${existingPane}`);
            Bun.spawnSync(["tmux", "select-pane", "-t", existingPane]);
            Bun.spawnSync(["tmux", "select-window", "-t", `${session}:${WINDOW_NAME}`]);
            return;
          }
        }
        paneId = createWindow(session, WINDOW_NAME, process.cwd());
      } else {
        paneId = createWindow(session, WINDOW_NAME, process.cwd());
      }

      setPaneTitle(paneId, "fleet-architect");

      // Launch claude with fleet dir (agent reads CLAUDE.md, README.md, templates)
      let launchCmd = `claude --model "${opts.model}" --effort "${opts.effort}"`;
      launchCmd += ` --dangerously-skip-permissions`;
      launchCmd += ` --add-dir "${FLEET_DIR}"`;
      launchCmd += ` --add-dir "${FLEET_DATA}"`;

      sendKeys(paneId, launchCmd);
      sendEnter(paneId);

      info("Waiting for Claude TUI...");
      const ready = await waitForPrompt(paneId);
      if (!ready) warn("TUI timeout after 60s, proceeding anyway");
      await Bun.sleep(2000);

      const seed = buildSeed();
      const pasted = pasteBuffer(paneId, seed);
      if (pasted) {
        await Bun.sleep(3000);
        sendEnter(paneId);
      } else {
        warn("Failed to inject seed — agent launched without onboarding prompt");
      }

      ok(`Fleet architect launched in ${session}:${WINDOW_NAME} (pane ${paneId})`);
      info("Switch to it with: fleet attach fleet-onboard");
      info("To continue onboarding or make changes: fleet onboard");
    });
}
