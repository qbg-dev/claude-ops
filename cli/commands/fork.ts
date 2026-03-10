import { defineCommand } from "citty";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import {
  FLEET_DATA, DEFAULT_SESSION, workerDir, resolveProject,
} from "../lib/paths";
import {
  getConfig, getState, getFleetConfig, writeJson,
} from "../lib/config";
import { info, ok, warn, fail } from "../lib/fmt";
import {
  sessionExists, createSession, windowExists, splitIntoWindow,
  createWindow, setPaneTitle, sendKeys, sendEnter, getPaneTarget,
} from "../lib/tmux";

export default defineCommand({
  meta: { name: "fork", description: "Fork from existing session" },
  args: {
    parent:  { type: "positional", description: "Parent worker name", required: true },
    child:   { type: "positional", description: "Child worker name", required: true },
    mission: { type: "positional", description: "Child mission", required: true },
    model:   { type: "string", description: "Override model" },
    project: { type: "string", description: "Override project detection" },
  },
  async run({ args }) {
    const project = args.project || resolveProject();
    const parentDir = workerDir(project, args.parent);
    const parentState = getState(project, args.parent);
    const parentConfig = getConfig(project, args.parent);

    if (!existsSync(parentDir)) fail(`Parent '${args.parent}' not found`);
    if (!parentState?.pane_id) fail(`Parent '${args.parent}' has no active pane`);
    if (!parentState.session_id) fail(`Parent '${args.parent}' has no session_id`);
    if (!parentConfig) fail(`Parent '${args.parent}' has no config`);

    const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
    if (!NAME_RE.test(args.child)) fail(`Name must be kebab-case: ${args.child}`);

    const childDir = workerDir(project, args.child);
    if (existsSync(childDir)) fail(`Worker '${args.child}' already exists`);

    info(`Forking '${args.child}' from '${args.parent}'`);

    // Create child via fleet create --no-launch (inline)
    const { default: createCmd } = await import("./create");
    await createCmd.run!({
      args: {
        name: args.child,
        mission: args.mission,
        model: args.model || "",
        effort: "",
        "permission-mode": "",
        window: "",
        "window-index": "",
        project,
        type: "",
        "no-launch": true,
        json: false,
      },
      rawArgs: [],
      cmd: createCmd,
    } as any);

    // Update meta.forked_from
    const childConfigPath = join(childDir, "config.json");
    const childConfig = getConfig(project, args.child);
    if (childConfig) {
      childConfig.meta.forked_from = args.parent;
      writeJson(childConfigPath, childConfig);
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
    const window = childConfig?.window || args.child;
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

    setPaneTitle(paneId, args.child);

    const model = childConfig?.model || "opus";
    const effort = childConfig?.reasoning_effort || "high";
    const perm = childConfig?.permission_mode || "bypassPermissions";

    let cmd = `cd "${worktree}" && CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME=${args.child} claude`;
    cmd += ` --model ${model} --effort ${effort}`;
    if (perm === "bypassPermissions") {
      cmd += " --dangerously-skip-permissions";
    } else {
      cmd += ` --permission-mode ${perm}`;
    }
    cmd += ` --add-dir ${childDir}`;
    cmd += ` --resume ${sessionId} --fork-session`;

    sendKeys(paneId, cmd);
    sendEnter(paneId);

    const paneTarget = getPaneTarget(paneId);
    writeJson(join(childDir, "state.json"), {
      status: "active",
      pane_id: paneId,
      pane_target: paneTarget,
      tmux_session: session,
      session_id: "",
      past_sessions: [],
      relaunch_count: 0,
      cycles_completed: 0,
      last_cycle_at: null,
      custom: {},
    });

    ok(`Forked '${args.child}' from '${args.parent}' (pane ${paneId})`);
  },
});
