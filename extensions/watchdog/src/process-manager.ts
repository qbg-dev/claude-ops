/**
 * Process lifecycle: kill agent, relaunch, resume in pane.
 * Handles Claude/Codex TUI detection, dialog auto-accept, and spawn hooks.
 */

import { join } from "path";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { randomBytes } from "crypto";
import { logInfo, logWarn } from "./logger";
import { FLEET_DATA } from "./config";
import type { WorkerSnapshot } from "./types";
import { executeSpawnHooks, type SpawnHookContext } from "./spawn-hooks";

/** Tmux helper */
function tmux(...args: string[]): { ok: boolean; stdout: string } {
  const result = Bun.spawnSync(["tmux", ...args], { stderr: "pipe" });
  return { ok: result.exitCode === 0, stdout: result.stdout.toString().trim() };
}

/** Kill the agent process tree running in a pane */
export function killAgentInPane(paneId: string): void {
  const { stdout } = tmux(
    "list-panes", "-a", "-F", "#{pane_id} #{pane_pid}",
  );
  for (const line of stdout.split("\n")) {
    const [id, pidStr] = line.split(" ");
    if (id === paneId && pidStr) {
      Bun.spawnSync(["pkill", "-TERM", "-P", pidStr], { stderr: "pipe" });
      Bun.sleepSync(2000);
      Bun.spawnSync(["pkill", "-KILL", "-P", pidStr], { stderr: "pipe" });
      Bun.sleepSync(1000);
      return;
    }
  }
}

/** Build the agent launch command from worker snapshot */
export function buildAgentCmd(snap: WorkerSnapshot, projectName: string, sessionId?: string): string {
  const workerDir = join(FLEET_DATA, projectName, snap.name);

  if (snap.runtime === "codex") {
    if (sessionId) return `codex resume ${sessionId}`;
    let cmd = `codex -m ${snap.model}`;
    if (snap.permissionMode === "bypassPermissions") {
      cmd += " --dangerously-bypass-approvals-and-sandbox";
    } else {
      cmd += " -s workspace-write -a on-request";
    }
    if (snap.reasoningEffort) cmd += ` -c model_reasoning_effort=${snap.reasoningEffort}`;
    cmd += " --no-alt-screen";
    return cmd;
  }

  // Claude Code (default)
  let cmd = `CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME=${snap.name} claude --model ${snap.model}`;
  if (snap.permissionMode === "bypassPermissions") cmd += " --dangerously-skip-permissions";
  if (snap.reasoningEffort) cmd += ` --effort ${snap.reasoningEffort}`;
  cmd += ` --add-dir ${workerDir}`;
  if (sessionId) cmd += ` --resume ${sessionId}`;
  return cmd;
}

/** Generate seed content for a worker (via bun subprocess) */
export function generateSeed(workerName: string, projectRoot: string): string {
  const claudeOps = process.env.CLAUDE_FLEET_DIR || join(process.env.HOME!, ".claude-fleet");
  const result = Bun.spawnSync(
    [Bun.which("bun") || "bun", "-e", `
      const { generateSeedContent } = await import(process.env._FLEET_OPS_DIR + '/mcp/worker-fleet/index.ts');
      process.stdout.write(generateSeedContent(process.env.WORKER_NAME));
    `],
    {
      env: { ...process.env, WORKER_NAME: workerName, PROJECT_ROOT: projectRoot, _FLEET_OPS_DIR: claudeOps },
      stderr: "pipe",
    },
  );
  if (result.exitCode === 0) {
    return result.stdout.toString();
  }
  return `Watchdog respawn. You are worker ${workerName}. Read mission.md, then start your next cycle.`;
}

/** TUI ready pattern by runtime */
function tuiPattern(runtime: string): string {
  return runtime === "codex" ? "codex" : "bypass permissions";
}

/** Grace period before resume-killing an agent (ms) */
const GRACEFUL_TIMEOUT_MS = 90_000; // 1.5 minutes
const GRACEFUL_POLL_MS = 5_000;

/**
 * Graceful shutdown: warn the agent it's about to be restarted,
 * give it time to save state, and allow early readiness signaling.
 *
 * Injects a message into the pane telling the agent to wrap up.
 * The agent can `touch <readyFile>` to signal immediate readiness.
 * Otherwise waits the full grace period before returning.
 */
export async function gracefulShutdown(paneId: string, workerName: string, reason: string): Promise<void> {
  const nonce = randomBytes(4).toString("hex");
  const readyFile = `/tmp/worker-${workerName}-ready-${nonce}.signal`;
  const graceSec = Math.round(GRACEFUL_TIMEOUT_MS / 1000);

  const message = [
    `GRACEFUL RESTART NOTICE (reason: ${reason})`,
    ``,
    `You will be restarted in ${graceSec} seconds. Please:`,
    `1. Save important state via update_state() or save_checkpoint()`,
    `2. Commit any in-progress work`,
    `3. Note down anything you need to remember`,
    ``,
    `To signal you're ready for immediate restart, run:`,
    `touch ${readyFile}`,
  ].join("\n");

  // Inject warning message via tmux buffer
  const msgFile = `/tmp/worker-${workerName}-graceful-msg.txt`;
  writeFileSync(msgFile, message);
  try {
    const bufName = `graceful-${workerName}-${process.pid}`;
    tmux("delete-buffer", "-b", bufName);
    const load = tmux("load-buffer", "-b", bufName, msgFile);
    if (!load.ok) {
      logWarn("GRACEFUL", "failed to load warning into tmux buffer, skipping grace period", workerName);
      return;
    }
    tmux("paste-buffer", "-b", bufName, "-t", paneId, "-d");
    await Bun.sleep(500);
    tmux("send-keys", "-t", paneId, "-H", "0d");
  } finally {
    try { unlinkSync(msgFile); } catch {}
  }

  logInfo("GRACEFUL", `sent restart warning, waiting up to ${graceSec}s (ready file: ${readyFile})`, workerName);

  // Poll for readiness signal or timeout
  const start = Date.now();
  while (Date.now() - start < GRACEFUL_TIMEOUT_MS) {
    await Bun.sleep(GRACEFUL_POLL_MS);
    if (existsSync(readyFile)) {
      const elapsed = Math.round((Date.now() - start) / 1000);
      logInfo("GRACEFUL", `worker signaled readiness after ${elapsed}s`, workerName);
      try { unlinkSync(readyFile); } catch {}
      return;
    }
  }

  logInfo("GRACEFUL", `grace period expired (${graceSec}s), proceeding with restart`, workerName);
  try { unlinkSync(readyFile); } catch {}
}

/**
 * Resume a worker in its existing pane (unstick or sleep-respawn).
 * Sends a graceful shutdown warning, waits for readiness, then restarts
 * with TUI + on_spawn hooks (default: seed-inject).
 */
export async function resumeInPane(
  snap: WorkerSnapshot,
  projectName: string,
  projectRoot: string,
  reason: string,
): Promise<void> {
  const paneId = snap.paneId!;

  // 1. Graceful shutdown: warn agent, wait for readiness or timeout
  await gracefulShutdown(paneId, snap.name, reason);

  // 2. Kill existing agent
  killAgentInPane(paneId);

  // 3. Build and send agent command
  const cmd = buildAgentCmd(snap, projectName);
  tmux("send-keys", "-t", paneId, cmd);
  tmux("send-keys", "-t", paneId, "-H", "0d");

  logInfo("RESUME", `${snap.runtime} — fresh start in pane ${paneId} (reason: ${reason})`, snap.name);

  // 4. Wait for TUI, then execute spawn hooks
  const ctx: SpawnHookContext = {
    workerName: snap.name,
    paneId,
    projectRoot,
    projectName,
    reason,
    runtime: snap.runtime,
    worktree: snap.worktree || projectRoot,
  };
  const ready = await waitForTui(paneId, snap.name, snap.runtime);
  if (ready) {
    await executeSpawnHooks(snap.onSpawn, ctx);
  }
}

/**
 * Relaunch a worker in a new pane (dead pane respawn).
 * The caller has already created the new pane.
 */
export async function relaunchInPane(
  paneId: string,
  snap: WorkerSnapshot,
  projectName: string,
  projectRoot: string,
): Promise<void> {
  const worktree = snap.worktree || projectRoot;

  // Kill any existing agent before launching new one (prevents orphan accumulation)
  killAgentInPane(paneId);

  // cd + launch agent
  tmux("send-keys", "-t", paneId, `cd "${worktree}"`);
  tmux("send-keys", "-t", paneId, "-H", "0d");
  await Bun.sleep(1000);

  const cmd = buildAgentCmd(snap, projectName);
  tmux("send-keys", "-t", paneId, cmd);
  tmux("send-keys", "-t", paneId, "-H", "0d");

  // Wait for TUI, then execute spawn hooks
  const ctx: SpawnHookContext = {
    workerName: snap.name,
    paneId,
    projectRoot,
    projectName,
    reason: "relaunch",
    runtime: snap.runtime,
    worktree,
  };
  const ready = await waitForTui(paneId, snap.name, snap.runtime);
  if (ready) {
    await executeSpawnHooks(snap.onSpawn, ctx);
  }
}

/**
 * Wait for TUI to be ready, handle startup dialogs (bypass, trust).
 * Returns true if TUI is ready, false if timed out.
 */
export async function waitForTui(paneId: string, workerName: string, runtime: string): Promise<boolean> {
  await Bun.sleep(8000);

  const pattern = tuiPattern(runtime);
  let waited = 0;
  const maxWait = 60;

  // Wait for TUI
  while (waited < maxWait) {
    const { stdout } = tmux("capture-pane", "-t", paneId, "-p");
    const tail = stdout.split("\n").slice(-10).join("\n");
    if (tail.toLowerCase().includes(pattern)) return true;
    await Bun.sleep(3000);
    waited += 3;
  }

  // Check TUI ready
  const { stdout: paneOutput } = tmux("capture-pane", "-t", paneId, "-p");
  const bottom = paneOutput.split("\n").slice(-10).join("\n");

  if (!bottom.toLowerCase().includes(pattern)) {
    // Handle bypass dialog
    if (bottom.includes("Yes, I accept") && !bottom.includes("bypass permissions on")) {
      logInfo("ACCEPT-DIALOG", "auto-accepting bypass dialog", workerName);
      tmux("send-keys", "-t", paneId, "Down");
      await Bun.sleep(500);
      tmux("send-keys", "-t", paneId, "Enter");
      await Bun.sleep(5000);
    }

    // Handle trust dialog
    const { stdout: afterDialog } = tmux("capture-pane", "-t", paneId, "-p");
    if (afterDialog.includes("I trust this folder")) {
      logInfo("TRUST-DIALOG", "auto-accepting project trust dialog", workerName);
      tmux("send-keys", "-t", paneId, "Enter");
      await Bun.sleep(5000);
    }

    // Final check
    const { stdout: finalCheck } = tmux("capture-pane", "-t", paneId, "-p");
    if (!finalCheck.split("\n").slice(-5).join("\n").toLowerCase().includes(pattern)) {
      logWarn("TUI-TIMEOUT", `TUI not ready after ${waited + 8}s, skipping spawn hooks`, workerName);
      return false;
    }
  }

  return true;
}
