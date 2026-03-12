/**
 * Shared launch logic: create/find tmux pane, start agent, inject seed.
 * Used by CLI (`fleet create`/`fleet start`) and MCP (`create_worker`).
 * Supports Claude and Codex runtimes.
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
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

export interface LaunchOptions {
  /** Runtime: "claude" (default) or "codex" */
  runtime?: "claude" | "codex";
  /** Override workerName env for seed generation */
  workerName?: string;
}

/**
 * Launch a worker in a tmux pane. Handles:
 * - Session/window/pane creation
 * - Claude/Codex command construction
 * - Git hook installation in worktree
 * - .mcp.json symlink to project root
 * - TUI wait + seed injection
 * - state.json + legacy registry update
 *
 * Returns the tmux pane ID.
 */
export async function launchInTmux(
  name: string,
  project: string,
  session: string,
  window: string,
  windowIndex?: number,
  options?: LaunchOptions,
): Promise<string> {
  const dir = workerDir(project, name);
  const config = getConfig(project, name);
  if (!config) fail(`No config.json for '${name}'`);

  const worktree = config!.worktree;
  if (!worktree) fail(`No worktree configured for ${name}`);
  if (!existsSync(worktree)) fail(`Worktree not found: ${worktree}`);

  const runtime = options?.runtime || config!.runtime || "claude";
  info(`Launching in tmux (session: ${session}, window: ${window}, runtime: ${runtime})`);

  // ── Symlink .mcp.json to project root ──
  const projectRoot = resolveProjectRootFromWorktree(worktree);
  if (projectRoot && projectRoot !== worktree) {
    const mcpSrc = join(projectRoot, ".mcp.json");
    const mcpDst = join(worktree, ".mcp.json");
    if (existsSync(mcpSrc)) {
      try {
        const { unlinkSync, symlinkSync } = require("node:fs");
        try { unlinkSync(mcpDst); } catch {}
        symlinkSync(mcpSrc, mcpDst);
      } catch {}
    }
  }

  // ── Install git hooks in worktree ──
  installWorktreeGitHooks(worktree, projectRoot);

  // ── Create or find tmux pane ──
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

  // Auto-restore saved layout if available
  try {
    const { readJson: readJsonImport } = await import("../../shared/io");
    const fleetJsonPath = join(FLEET_DATA, project, "fleet.json");
    const fleetJson = readJsonImport(fleetJsonPath) as any;
    if (fleetJson?.layouts?.[window]) {
      Bun.spawnSync(
        ["tmux", "select-layout", "-t", `${session}:${window}`, fleetJson.layouts[window]],
        { stderr: "pipe" }
      );
    }
  } catch {} // non-fatal

  if (createdSession) {
    sendKeys(paneId, `cd "${worktree}"`);
    sendEnter(paneId);
  }

  // ── Build agent command ──
  const { model, reasoning_effort: effort, permission_mode: perm } = config!;
  let cmd: string;

  if (runtime === "codex") {
    cmd = `WORKER_NAME="${name}" WORKER_RUNTIME=codex codex -m "${model}"`;
    if (perm === "bypassPermissions") {
      cmd += " --dangerously-bypass-approvals-and-sandbox";
    } else {
      cmd += " -s danger-full-access -a on-request";
    }
    cmd += ` -c model_reasoning_effort=${effort}`;
    cmd += " --no-alt-screen";
    cmd += ` --add-dir "${dir}"`;
  } else {
    cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME="${name}" claude --model "${model}" --effort "${effort}"`;
    if (perm === "bypassPermissions") {
      cmd += " --dangerously-skip-permissions";
    } else {
      cmd += ` --permission-mode "${perm}"`;
    }
    cmd += ` --add-dir "${dir}"`;
  }

  sendKeys(paneId, cmd);
  sendEnter(paneId);

  // ── Wait for TUI ──
  info("Waiting for TUI...");
  const ready = await waitForPrompt(paneId);
  if (!ready) warn("TUI timeout after 60s, proceeding anyway");
  await Bun.sleep(2000); // settle

  // ── Generate + inject seed ──
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
    const settleMs = Math.min(8000, 2000 + Math.floor(seedContent.length / 4096) * 1000);
    await Bun.sleep(settleMs);
    sendEnter(paneId);

    await Bun.sleep(3000);
    const output = capturePane(paneId, 10);
    if (/command not found|bad pattern|zsh:|bash:/.test(output) && !/❯.*command not found/.test(output)) {
      warn("Detected garbled seed (shell errors) — seed may have leaked into shell");
    }
    if (/❯/.test(output)) sendEnter(paneId);
  }

  // ── Update state.json ──
  const paneTarget = getPaneTarget(paneId);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

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

  updateRegistry(name, project, paneId, paneTarget, session);

  ok(`Worker '${name}' launched in pane ${paneId} (session: ${session}, window: ${window})`);
  return paneId;
}

// ── Git Hook Installation ──

/** Install commit-msg and post-commit hooks in a worktree's git dir */
function installWorktreeGitHooks(worktree: string, projectRoot: string | null): void {
  try {
    const result = Bun.spawnSync(
      ["git", "-C", worktree, "rev-parse", "--absolute-git-dir"],
      { stderr: "pipe" },
    );
    const gitDir = result.exitCode === 0 ? result.stdout.toString().trim() : null;
    if (!gitDir) return;

    const hooksDir = join(gitDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });

    const hookNames = ["commit-msg", "post-commit"];
    for (const hookName of hookNames) {
      // Try project-local, then fleet-level
      let src = projectRoot ? join(projectRoot, `.claude/scripts/worker-${hookName}-hook.sh`) : "";
      if (!src || !existsSync(src)) {
        src = join(FLEET_DIR, `scripts/worker-${hookName}-hook.sh`);
      }
      if (existsSync(src)) {
        const dst = join(hooksDir, hookName);
        if (!existsSync(dst)) {
          copyFileSync(src, dst);
          Bun.spawnSync(["chmod", "+x", dst]);
        }
      }
    }
  } catch {} // non-fatal
}

/** Resolve project root from worktree path (strip -w-<name> suffix) */
function resolveProjectRootFromWorktree(worktree: string): string | null {
  // Worktrees are at PROJECT_ROOT/../PROJECT_NAME-w-WORKER
  const match = worktree.match(/^(.+?)(?:-w-[^/]+)?$/);
  if (match && existsSync(match[1])) return match[1];
  // Fallback: git toplevel
  try {
    const result = Bun.spawnSync(["git", "-C", worktree, "rev-parse", "--show-toplevel"], { stderr: "pipe" });
    return result.exitCode === 0 ? result.stdout.toString().trim() : null;
  } catch { return null; }
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
