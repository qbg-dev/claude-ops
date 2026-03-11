import type { Command } from "commander";
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_SESSION, workerDir, resolveProject,
} from "../lib/paths";
import {
  getConfig, getState, getFleetConfig, writeJsonLocked,
} from "../lib/config";
import { info, ok, warn, fail } from "../lib/fmt";
import {
  sessionExists, createSession, windowExists, splitIntoWindow,
  createWindow, setPaneTitle, sendKeys, sendEnter, getPaneTarget,
} from "../lib/tmux";
import { addGlobalOpts } from "../index";

export function register(parent: Command): void {
  const sub = parent
    .command("fork <parent> <child> [mission]")
    .description("Fork from existing session (inherits parent mission if omitted)")
    .option("--model <model>", "Override model");
  addGlobalOpts(sub)
    .action(async (parentName: string, childName: string, mission: string | undefined, opts: { model?: string }, cmd: Command) => {
      const project = cmd.optsWithGlobals().project as string || resolveProject();
      const parentDir = workerDir(project, parentName);
      const parentState = getState(project, parentName);
      const parentConfig = getConfig(project, parentName);

      if (!existsSync(parentDir)) return fail(`Parent '${parentName}' not found`);
      if (!parentState) return fail(`Parent '${parentName}' has no state`);
      if (!parentState.pane_id) return fail(`Parent '${parentName}' has no active pane`);
      if (!parentState.session_id) return fail(`Parent '${parentName}' has no session_id`);
      if (!parentConfig) return fail(`Parent '${parentName}' has no config`);

      const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
      if (!NAME_RE.test(childName)) fail(`Name must be kebab-case: ${childName}`);

      const childDir = workerDir(project, childName);
      if (existsSync(childDir)) fail(`Worker '${childName}' already exists`);

      // Always include parent mission as context; combine with inline directive if provided
      const parentMissionPath = join(parentDir, "mission.md");
      const parentMission = existsSync(parentMissionPath)
        ? readFileSync(parentMissionPath, "utf-8").trim()
        : "";

      if (mission) {
        // Combine: parent context + new directive
        mission = parentMission
          ? `# Forked from ${parentName}\n\n## Original mission\n${parentMission}\n\n## Your directive\n${mission}`
          : mission;
      } else {
        mission = parentMission || `Forked from ${parentName}`;
      }

      info(`Forking '${childName}' from '${parentName}'`);

      // Create child via runCreate --no-launch
      const { runCreate } = await import("./create");
      await runCreate(childName, mission, {
        model: opts.model,
        noLaunch: true,
      }, cmd.optsWithGlobals());

      // Update meta.forked_from
      const childConfigPath = join(childDir, "config.json");
      const childConfig = getConfig(project, childName);
      if (childConfig) {
        childConfig.meta.forked_from = parentName;
        writeJsonLocked(childConfigPath, childConfig);
      }

      // Copy parent session data to child's project dir
      const HOME = process.env.HOME || "/tmp";
      const parentWorktree = parentConfig!.worktree;
      const childWorktree = childConfig?.worktree || "";
      const parentProjSlug = parentWorktree.replace(/\//g, "-");
      const childProjSlug = childWorktree.replace(/\//g, "-");

      const parentProjDir = join(HOME, ".claude/projects", parentProjSlug);
      const childProjDir = join(HOME, ".claude/projects", childProjSlug);
      const sessionId = parentState.session_id;
      const sessionFile = join(parentProjDir, `${sessionId}.jsonl`);

      if (existsSync(sessionFile)) {
        mkdirSync(childProjDir, { recursive: true });
        try {
          copyFileSync(sessionFile, join(childProjDir, `${sessionId}.jsonl`));
          const sessionDir = join(parentProjDir, sessionId);
          if (existsSync(sessionDir)) {
            Bun.spawnSync(["cp", "-r", sessionDir, join(childProjDir, sessionId)]);
          }
          ok("Session data copied");
        } catch {
          warn("Failed to copy session data (non-fatal)");
        }
      }

      // Launch with --resume --fork-session
      const fleetConfig = getFleetConfig(project);
      const session = fleetConfig?.tmux_session || DEFAULT_SESSION;
      const window = childConfig?.window || childName;
      const worktree = childConfig?.worktree || "";

      if (!worktree || !existsSync(worktree)) fail("Child worktree not found");

      let paneId: string;
      if (!sessionExists(session)) {
        paneId = createSession(session, window, worktree);
      } else if (windowExists(session, window)) {
        paneId = splitIntoWindow(session, window, worktree);
      } else {
        paneId = createWindow(session, window, worktree);
      }

      setPaneTitle(paneId, childName);

      const model = childConfig?.model || "opus";
      const effort = childConfig?.reasoning_effort || "high";
      const perm = childConfig?.permission_mode || "bypassPermissions";

      let launchCmd = `cd "${worktree}" && CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME="${childName}" claude`;
      launchCmd += ` --model "${model}" --effort "${effort}"`;
      if (perm === "bypassPermissions") {
        launchCmd += " --dangerously-skip-permissions";
      } else {
        launchCmd += ` --permission-mode "${perm}"`;
      }
      launchCmd += ` --add-dir "${childDir}"`;
      launchCmd += ` --resume "${sessionId}" --fork-session`;

      sendKeys(paneId, launchCmd);
      sendEnter(paneId);

      const paneTarget = getPaneTarget(paneId);
      writeJsonLocked(join(childDir, "state.json"), {
        status: "active",
        pane_id: paneId,
        pane_target: paneTarget,
        tmux_session: session,
        session_id: "",
        past_sessions: [],
        last_relaunch: { at: new Date().toISOString(), reason: "fork" },
        relaunch_count: 0,
        cycles_completed: 0,
        last_cycle_at: null,
        custom: {},
      });

      ok(`Forked '${childName}' from '${parentName}' (pane ${paneId})`);
    });
}
