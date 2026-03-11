/**
 * Process lifecycle: kill agent, relaunch, resume in pane.
 * Handles Claude/Codex TUI detection, seed injection, dialog auto-accept.
 */

import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { logInfo, logWarn } from "./logger";
import { FLEET_DATA } from "./config";
import type { WorkerSnapshot } from "./types";

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
  const claudeOps = process.env.CLAUDE_OPS_DIR || process.env.TMUX_AGENTS_DIR || join(process.env.HOME!, ".tmux-agents");
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

/**
 * Resume a worker in its existing pane (unstick or sleep-respawn).
 * Runs seed injection asynchronously.
 */
export async function resumeInPane(
  snap: WorkerSnapshot,
  projectName: string,
  projectRoot: string,
  reason: string,
): Promise<void> {
  const paneId = snap.paneId!;

  // 1. Kill existing agent
  killAgentInPane(paneId);

  // 2. Generate seed
  const seed = generateSeed(snap.name, projectRoot);

  // 3. Build and send agent command
  const cmd = buildAgentCmd(snap, projectName);
  tmux("send-keys", "-t", paneId, cmd);
  tmux("send-keys", "-t", paneId, "-H", "0d");

  logInfo("RESUME", `${snap.runtime} — fresh start in pane ${paneId} (reason: ${reason})`, snap.name);

  // 4. Wait for TUI + inject seed (async)
  await waitAndInjectSeed(paneId, snap.name, seed, snap.runtime);
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

  // cd + launch agent
  tmux("send-keys", "-t", paneId, `cd "${worktree}"`);
  tmux("send-keys", "-t", paneId, "-H", "0d");
  await Bun.sleep(1000);

  const cmd = buildAgentCmd(snap, projectName);
  tmux("send-keys", "-t", paneId, cmd);
  tmux("send-keys", "-t", paneId, "-H", "0d");

  // Generate seed and inject after TUI starts
  const seed = generateSeed(snap.name, projectRoot);
  await waitAndInjectSeed(paneId, snap.name, seed, snap.runtime);
}

/** Wait for TUI prompt, handle dialogs, inject seed */
async function waitAndInjectSeed(paneId: string, workerName: string, seed: string, runtime: string): Promise<void> {
  await Bun.sleep(8000);

  const pattern = tuiPattern(runtime);
  let waited = 0;
  const maxWait = 60;

  // Wait for TUI
  while (waited < maxWait) {
    const { stdout } = tmux("capture-pane", "-t", paneId, "-p");
    const tail = stdout.split("\n").slice(-10).join("\n");
    if (tail.toLowerCase().includes(pattern)) break;
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
      logWarn("TUI-TIMEOUT", `TUI not ready after ${waited + 8}s, skipping seed`, workerName);
      return;
    }
  }

  await Bun.sleep(2000);

  // Inject seed via tmux buffer
  const seedFile = `/tmp/worker-${workerName}-watchdog-seed.txt`;
  writeFileSync(seedFile, seed);
  try {
    const bufName = `watchdog-${workerName}-${process.pid}`;
    tmux("delete-buffer", "-b", bufName);
    const load = tmux("load-buffer", "-b", bufName, seedFile);
    if (!load.ok) {
      logWarn("SEED-ERR", "failed to load seed into tmux buffer", workerName);
      return;
    }
    tmux("paste-buffer", "-b", bufName, "-t", paneId, "-d");
    await Bun.sleep(4000);
    tmux("send-keys", "-t", paneId, "-H", "0d");

    // Retry Enter after 3s if prompt visible
    await Bun.sleep(3000);
    const { stdout: promptCheck } = tmux("capture-pane", "-t", paneId, "-p");
    if (promptCheck.split("\n").slice(-3).join("\n").includes("❯")) {
      tmux("send-keys", "-t", paneId, "-H", "0d");
    }
  } finally {
    try { unlinkSync(seedFile); } catch {}
  }
}
