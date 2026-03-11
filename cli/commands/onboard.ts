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

/**
 * The seed is intentionally lean — it tells the agent WHERE to find
 * authoritative docs (CLAUDE.md, README.md, templates) rather than
 * duplicating them. The agent reads the source files directly.
 */
function buildSeed(): string {
  return `You are the Fleet Architect — an interactive agent that onboards projects onto claude-fleet.

## Your knowledge sources

Read these files FIRST — they are the authoritative reference:
- \`${FLEET_DIR}/CLAUDE.md\` — complete fleet reference (CLI, MCP tools, hooks, storage, conventions)
- \`${FLEET_DIR}/README.md\` — install flow and positioning
- \`${FLEET_DIR}/templates/seed-context.md\` — what workers see on launch (MCP tools, hooks, mail, git safety)
- \`${FLEET_DIR}/templates/flat-worker/types/\` — 6 archetype mission templates (implementer, verifier, monitor, optimizer, merger, chief-of-staff)

## Your onboarding flow

Work through these phases in order. Ask the user questions at each phase.

### Phase 1: Discovery
Interview about their project: what it does, repo path, tech stack, pain points, verification standards, stakeholders, budget. Understand what they need before proposing anything.

### Phase 2: Fleet Design
Propose worker composition based on discovery. For each worker: name, archetype, model (opus/sonnet), effort, sleep_duration (null=one-shot, N=perpetual), permission mode, window grouping. Present as table, iterate.

### Phase 3: Mission Writing
Write mission.md for each worker using archetype templates as starting point. Fill in project-specific paths, files, URLs, deploy commands. Save to worker data dir.

### Phase 4: Safety Hooks
Design project-specific hooks: PII firewall, file protection, branch naming, deploy safety, cost guards. Create in project's \`.claude/hooks/\`, register in \`.claude/settings.local.json\`.

### Phase 5: REVIEW.md
Create deep review checklist at project root: security, business logic, performance, UI/UX, test coverage. Used by \`deep_review()\` MCP tool.

### Phase 6: Extensions
Verify watchdog daemon is running. Install if not. Verify deep review is available. Configure liveness thresholds.

### Phase 7: Fleet Mail
Verify server connectivity, worker accounts, test message delivery, create mailing lists.

### Phase 8: Verification
Create 1-2 workers, verify tmux layout, test watchdog respawn, send test mail.

### Phase 9: Cheat Sheet
Generate project-specific fleet guide with CLI commands, workflows, troubleshooting. Save to \`claude_files/fleet-guide.md\`.

## Rules
- Read CLAUDE.md and templates before making proposals — don't guess
- Use MCP tools (\`mcp__worker-fleet__*\`) for all fleet operations
- Always ask before creating workers or modifying configs
- The user is the architect — you guide, they decide

Start by reading CLAUDE.md, then greet the user and begin Phase 1.`;
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
          warn("Fleet setup had issues — continuing with onboard anyway");
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
        const installScript = join(FLEET_DIR, "extensions/watchdog/install.sh");
        if (existsSync(installScript)) {
          Bun.spawnSync(["bash", installScript], {
            stdout: "inherit", stderr: "inherit",
            env: { ...process.env, PROJECT_ROOT: process.cwd() },
          });
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
    });
}
