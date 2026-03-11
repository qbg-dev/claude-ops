/**
 * Shared launch logic: create/find tmux pane, start claude, inject seed.
 * Used by both `create` and `start` commands.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  FLEET_DATA, FLEET_DIR, workerDir,
} from "./paths";
import {
  getConfig, getState, writeJsonLocked,
} from "./config";
import {
  sessionExists, createSession, windowExists, splitIntoWindow,
  createWindow, setPaneTitle, sendKeys, sendEnter, capturePane,
  waitForPrompt, pasteBuffer, getPaneTarget,
} from "./tmux";
import { info, ok, warn, fail } from "./fmt";

/**
 * Launch a worker in a tmux pane. Handles:
 * - Session/window/pane creation
 * - claude command construction
 * - TUI wait + seed injection
 * - state.json update
 */
export async function launchInTmux(
  name: string,
  project: string,
  session: string,
  window: string,
  windowIndex?: number,
): Promise<void> {
  const dir = workerDir(project, name);
  const config = getConfig(project, name);
  if (!config) fail(`No config.json for '${name}'`);

  const worktree = config!.worktree;
  if (!worktree) fail(`No worktree configured for ${name}`);
  if (!existsSync(worktree)) fail(`Worktree not found: ${worktree}`);

  info(`Launching in tmux (session: ${session}, window: ${window})`);

  // Create or find pane
  let paneId: string;
  let createdSession = false;

  if (!sessionExists(session)) {
    paneId = createSession(session, window, worktree);
    createdSession = true;
  } else if (windowExists(session, window)) {
    paneId = splitIntoWindow(session, window, worktree);
  } else {
    paneId = createWindow(session, window, worktree, windowIndex);
  }

  setPaneTitle(paneId, name);

  // If we just created the session, the pane starts with a shell prompt
  // but we still need to cd (createSession sets cwd, but if the shell
  // has a custom cd hook it might not be reliable)
  if (createdSession) {
    sendKeys(paneId, `cd "${worktree}"`);
    sendEnter(paneId);
  }

  // Build claude command (quote all values for shell safety)
  const { model, reasoning_effort: effort, permission_mode: perm } = config!;
  let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME="${name}" claude --model "${model}" --effort "${effort}"`;
  if (perm === "bypassPermissions") {
    cmd += " --dangerously-skip-permissions";
  } else {
    cmd += ` --permission-mode "${perm}"`;
  }
  cmd += ` --add-dir "${dir}"`;

  sendKeys(paneId, cmd);
  sendEnter(paneId);

  // Wait for TUI
  info("Waiting for Claude TUI...");
  const ready = await waitForPrompt(paneId);
  if (!ready) warn("TUI timeout after 60s, proceeding anyway");
  await Bun.sleep(2000); // settle

  // Generate + inject seed
  let seedContent: string;
  try {
    const result = Bun.spawnSync(
      [Bun.which("bun") || "bun", "-e", `
        const { generateSeedContent } = await import('${FLEET_DIR}/mcp/worker-fleet/index.ts');
        process.stdout.write(generateSeedContent());
      `],
      {
        env: { ...process.env, WORKER_NAME: name, PROJECT_ROOT: worktree },
        stderr: "pipe",
      },
    );
    seedContent = result.exitCode === 0
      ? result.stdout.toString()
      : `You are worker ${name}. Read mission.md, then start your next cycle.`;
  } catch {
    seedContent = `You are worker ${name}. Read mission.md, then start your next cycle.`;
  }

  const pasted = pasteBuffer(paneId, seedContent);
  if (!pasted) {
    warn("Failed to load seed buffer — worker launched without seed");
  } else {
    // Scale settle time by seed size: 2s base + 1s per 4KB
    const settleMs = Math.min(8000, 2000 + Math.floor(seedContent.length / 4096) * 1000);
    await Bun.sleep(settleMs);
    sendEnter(paneId);

    // Verify seed wasn't garbled: check pane output for shell errors
    // that indicate seed text leaked into zsh instead of Claude's TUI
    await Bun.sleep(3000);
    const output = capturePane(paneId, 10);
    if (/command not found|bad pattern|zsh:|bash:/.test(output) && !/❯.*command not found/.test(output)) {
      warn("Detected garbled seed (shell errors) — seed may have leaked into shell");
    }
    if (/❯/.test(output)) sendEnter(paneId);
  }

  // Update state.json
  const paneTarget = getPaneTarget(paneId);
  // Strip milliseconds from ISO string so watchdog's macOS `date -j -f` can parse it
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

  // Preserve past_sessions
  const oldState = getState(project, name);
  const oldSessionId = oldState?.session_id || "";
  let pastSessions = oldState?.past_sessions || [];
  if (oldSessionId) {
    pastSessions = [oldSessionId, ...pastSessions].slice(0, 10);
  }

  writeJsonLocked(join(dir, "state.json"), {
    status: "active",
    pane_id: paneId,
    pane_target: paneTarget,
    tmux_session: session,
    session_id: "",
    past_sessions: pastSessions,
    last_relaunch: { at: now, reason: "fleet-start" },
    relaunch_count: (oldState?.relaunch_count || 0) + 1,
    cycles_completed: oldState?.cycles_completed || 0,
    last_cycle_at: oldState?.last_cycle_at || null,
    custom: oldState?.custom || {},
  });

  // Update legacy registry
  updateRegistry(name, project, paneId, paneTarget, session);

  ok(`Worker '${name}' launched in pane ${paneId} (session: ${session}, window: ${window})`);
}

/** Backward-compat write to registry.json */
function updateRegistry(
  name: string, project: string,
  paneId: string, paneTarget: string, session: string,
): void {
  const registryPath = join(FLEET_DATA, project, "registry.json");
  if (!existsSync(registryPath)) return;

  const config = getConfig(project, name);
  if (!config) return;

  try {
    const registry = JSON.parse(readFileSync(registryPath, "utf-8"));
    registry[name] = {
      ...(registry[name] || {}),
      pane_id: paneId,
      pane_target: paneTarget,
      tmux_session: session,
      branch: config.branch,
      worktree: config.worktree,
      window: config.window,
      model: config.model,
      permission_mode: config.permission_mode,
      status: "active",
    };
    writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");
  } catch { /* non-fatal */ }
}
