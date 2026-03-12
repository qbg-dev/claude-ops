/**
 * FIFO module — named pipe creation, waiting scripts, and unblocking.
 *
 * FIFOs provide zero-polling inter-phase synchronization:
 *   - Bridge windows block on `cat FIFO > /dev/null`
 *   - Stop hooks unblock by `echo "go" > FIFO`
 *   - Agent panes can also FIFO-wait (e.g. verifiers wait for coordinator)
 */
import { join } from "node:path";

const HOME = process.env.HOME || "/tmp";
const FLEET_DIR = process.env.CLAUDE_FLEET_DIR || join(HOME, ".claude-fleet");

/**
 * Create a FIFO (named pipe) at the given path.
 * Uses mkfifo via Bun.spawnSync. Idempotent — won't fail if exists.
 */
export function createFifo(path: string): boolean {
  const result = Bun.spawnSync(["mkfifo", path], { stderr: "pipe" });
  return result.exitCode === 0;
}

/**
 * Create all FIFOs for a set of bridge phases.
 * Returns the paths created.
 */
export function createBridgeFifos(
  sessionDir: string,
  phaseIndices: number[],
): string[] {
  const paths: string[] = [];
  for (const idx of phaseIndices) {
    const path = join(sessionDir, `fifo-bridge-${idx}`);
    createFifo(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Create agent-level FIFOs (e.g. verifier FIFOs gated on coordinator).
 */
export function createAgentFifos(
  sessionDir: string,
  agentNames: string[],
): string[] {
  const paths: string[] = [];
  for (const name of agentNames) {
    const path = join(sessionDir, `fifo-agent-${name}`);
    createFifo(path);
    paths.push(path);
  }
  return paths;
}

/**
 * Generate the shell commands for a bridge-wait pane.
 * This is sent to a pre-created tmux pane that blocks on a FIFO
 * until the Stop hook fires, then runs the bridge.
 */
export function bridgeWaitCommands(
  sessionDir: string,
  phaseIndex: number,
  label: string,
): string {
  const fifoPath = join(sessionDir, `fifo-bridge-${phaseIndex}`);
  const logPath = join(sessionDir, `bridge-${phaseIndex}.log`);

  return [
    `echo "═══ Bridge: ${label} ═══"`,
    `echo "Waiting for Stop hook to trigger..."`,
    `echo "Blocked on: ${fifoPath}"`,
    `echo ""`,
    `mkfifo '${fifoPath}' 2>/dev/null || true`,
    `cat '${fifoPath}' > /dev/null`,
    `echo "$(date '+%H:%M:%S') Hook received. Running bridge..."`,
    `echo ""`,
    `bun '${FLEET_DIR}/engine/program/bridge.ts' '${sessionDir}' '${phaseIndex}' 2>&1 | tee -a '${logPath}'`,
    `echo ""`,
    `echo "$(date '+%H:%M:%S') Bridge complete."`,
    `echo "Press Enter to close."`,
    `read`,
  ].join(" && ");
}

/**
 * Generate the shell commands for an agent-wait pane.
 * Blocks on a FIFO, then launches the agent's run script.
 */
export function agentWaitCommands(
  sessionDir: string,
  agentName: string,
  wrapperPath: string,
  label?: string,
): string {
  const fifoPath = join(sessionDir, `fifo-agent-${agentName}`);
  const displayLabel = label || agentName;

  return [
    `echo "═══ ${displayLabel} ═══"`,
    `echo "Waiting for phase gate..."`,
    `echo "Blocked on: ${fifoPath}"`,
    `echo ""`,
    `mkfifo '${fifoPath}' 2>/dev/null || true`,
    `cat '${fifoPath}' > /dev/null`,
    `echo "$(date '+%H:%M:%S') Gate opened. Launching ${displayLabel}..."`,
    `bash '${wrapperPath}'`,
  ].join(" && ");
}

/**
 * Unblock a single FIFO by writing to it.
 */
export function unblockFifo(path: string): void {
  Bun.spawnSync(["bash", "-c", `[ -p '${path}' ] && echo "go" > '${path}'`], { stderr: "pipe" });
}

/**
 * Unblock multiple FIFOs in parallel.
 */
export function unblockFifos(paths: string[]): void {
  for (const path of paths) {
    Bun.spawn(["bash", "-c", `[ -p '${path}' ] && echo "go" > '${path}'`], { stderr: "pipe" });
  }
}
