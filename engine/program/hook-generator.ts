/**
 * Hook generator — creates parameterized Stop hook scripts from a generic template.
 *
 * Each agent that gates a subsequent phase gets a Stop hook that either:
 *   1. Writes to a FIFO (unblocking the pre-created bridge window), or
 *   2. Falls back to running the bridge directly in a new tmux window.
 *
 * For gate:"all" phases, each agent writes a .done marker file. The last
 * agent's hook checks the marker count before unblocking the FIFO.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { FLEET_DATA } from "../../cli/lib/paths";

const HOME = process.env.HOME || "/tmp";

/**
 * Generate a Stop hook script for a single agent → next phase transition.
 * Returns the path to the generated script.
 */
export function generateStopHook(
  agentName: string,
  phaseIndex: number,
  sessionDir: string,
  opts?: { gateCount?: number; gateAgent?: string },
): string {
  const hooksDir = join(sessionDir, "hooks", agentName);
  mkdirSync(hooksDir, { recursive: true });

  const scriptName = `phase-${phaseIndex}-stop.sh`;
  const scriptPath = join(hooksDir, scriptName);

  // Write sidecar files
  writeFileSync(join(hooksDir, "session-dir.txt"), sessionDir);
  writeFileSync(join(hooksDir, "phase-index.txt"), String(phaseIndex));

  let script: string;

  if (opts?.gateCount && opts.gateCount > 1) {
    // gate:"all" — done-marker counting
    script = generateGateAllStopHook(agentName, phaseIndex, sessionDir, opts.gateCount);
  } else {
    // Standard: single agent gates next phase
    script = generateStandardStopHook(agentName, phaseIndex, sessionDir);
  }

  writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

/**
 * Standard Stop hook: unblock bridge FIFO or run bridge directly.
 */
function generateStandardStopHook(
  agentName: string,
  phaseIndex: number,
  sessionDir: string,
): string {
  return `#!/usr/bin/env bash
# Auto-generated: ${agentName} Stop -> Bridge Phase ${phaseIndex}
# Program API hook — do not edit manually.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_DIR="$(cat "$SCRIPT_DIR/session-dir.txt")"
PHASE="$(cat "$SCRIPT_DIR/phase-index.txt")"
FIFO="$SESSION_DIR/fifo-bridge-$PHASE"

if [ -p "$FIFO" ]; then
  echo "go" > "$FIFO"
  echo "[hook] Bridge-$PHASE FIFO triggered (${agentName} completed)"
else
  # Fallback: run bridge directly in tmux
  FLEET_DIR="\${CLAUDE_FLEET_DIR:-$HOME/.claude-fleet}"
  echo "[hook] No FIFO at $FIFO, running bridge directly" >&2
  TMUX_SESSION=""
  if [ -f "$SESSION_DIR/pipeline-state.json" ]; then
    TMUX_SESSION="$(python3 -c "import json; print(json.load(open('$SESSION_DIR/pipeline-state.json'))['tmuxSession'])" 2>/dev/null || true)"
  fi
  BRIDGE_CMD="bun '$FLEET_DIR/engine/program/bridge.ts' '$SESSION_DIR' '$PHASE' 2>&1 | tee -a '$SESSION_DIR/bridge-$PHASE.log'"
  if [ -n "$TMUX_SESSION" ] && tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    tmux new-window -d -t "$TMUX_SESSION" -n "bridge-$PHASE" bash -c "$BRIDGE_CMD; echo ''; echo '[bridge] Done. Press Enter to close.'; read" &
  else
    nohup bash -c "$BRIDGE_CMD" &
  fi
fi

exit 0  # allow stop
`;
}

/**
 * Gate-all Stop hook: each agent writes a done marker.
 * The last one checks the count and unblocks the FIFO.
 */
function generateGateAllStopHook(
  agentName: string,
  phaseIndex: number,
  sessionDir: string,
  expectedCount: number,
): string {
  return `#!/usr/bin/env bash
# Auto-generated: ${agentName} Stop -> gate-all check for Phase ${phaseIndex}
# Writes done marker. When all ${expectedCount} agents finish, unblocks bridge.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION_DIR="$(cat "$SCRIPT_DIR/session-dir.txt")"
PHASE="$(cat "$SCRIPT_DIR/phase-index.txt")"
EXPECTED=${expectedCount}

# Write done marker for this agent
echo "done" > "$SESSION_DIR/${agentName}.done"
echo "[hook] ${agentName} done marker written"

# Count done markers for this phase
ACTUAL=$(ls "$SESSION_DIR"/phase-${phaseIndex}-*.done "$SESSION_DIR"/*.done 2>/dev/null | wc -l | tr -d ' ')

echo "[hook] Done markers: $ACTUAL / $EXPECTED"

if [ "$ACTUAL" -ge "$EXPECTED" ]; then
  echo "[hook] All agents complete. Triggering bridge-$PHASE..."
  FIFO="$SESSION_DIR/fifo-bridge-$PHASE"
  if [ -p "$FIFO" ]; then
    echo "go" > "$FIFO"
    echo "[hook] Bridge-$PHASE FIFO triggered"
  else
    FLEET_DIR="\${CLAUDE_FLEET_DIR:-$HOME/.claude-fleet}"
    BRIDGE_CMD="bun '$FLEET_DIR/engine/program/bridge.ts' '$SESSION_DIR' '$PHASE' 2>&1 | tee -a '$SESSION_DIR/bridge-$PHASE.log'"
    TMUX_SESSION=""
    if [ -f "$SESSION_DIR/pipeline-state.json" ]; then
      TMUX_SESSION="$(python3 -c "import json; print(json.load(open('$SESSION_DIR/pipeline-state.json'))['tmuxSession'])" 2>/dev/null || true)"
    fi
    if [ -n "$TMUX_SESSION" ] && tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
      tmux new-window -d -t "$TMUX_SESSION" -n "bridge-$PHASE" bash -c "$BRIDGE_CMD; echo ''; echo '[bridge] Done.'; read" &
    else
      nohup bash -c "$BRIDGE_CMD" &
    fi
  fi
fi

exit 0  # allow stop
`;
}

/**
 * Install a generated Stop hook into a fleet worker's hooks directory.
 * This writes hooks.json + the script file into the worker's fleet dir.
 */
export function installStopHook(
  workerName: string,
  project: string,
  _hookScriptPath: string,
  sessionDir: string,
  phaseIndex: number,
  opts?: { gateCount?: number },
): void {
  const workerHooksDir = join(FLEET_DATA, project, workerName, "hooks");
  mkdirSync(workerHooksDir, { recursive: true });

  // Generate or copy the stop hook script
  const scriptName = `phase-${phaseIndex}-stop.sh`;
  const destScript = join(workerHooksDir, scriptName);

  // Generate the script content directly (rather than copying)
  let scriptContent: string;
  if (opts?.gateCount && opts.gateCount > 1) {
    scriptContent = generateGateAllStopHook(workerName, phaseIndex, sessionDir, opts.gateCount);
  } else {
    scriptContent = generateStandardStopHook(workerName, phaseIndex, sessionDir);
  }
  writeFileSync(destScript, scriptContent, { mode: 0o755 });

  // Write sidecar files
  writeFileSync(join(workerHooksDir, "session-dir.txt"), sessionDir);
  writeFileSync(join(workerHooksDir, "phase-index.txt"), String(phaseIndex));

  // Write hooks.json
  const hooks = {
    hooks: [{
      id: "dh-1",
      event: "Stop",
      description: `Bridge: phase-${phaseIndex} transition (${workerName})`,
      blocking: false,
      completed: false,
      status: "active" as const,
      lifetime: "persistent" as const,
      script_path: scriptName,
      registered_by: "program-api",
      ownership: "creator" as const,
      added_at: new Date().toISOString(),
    }],
  };

  writeFileSync(join(workerHooksDir, "hooks.json"), JSON.stringify(hooks, null, 2));
}
