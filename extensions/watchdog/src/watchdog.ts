#!/usr/bin/env bun
/**
 * Watchdog — TypeScript replacement for watchdog.sh.
 * Monitors fleet workers, detects crashes/stuck, respawns perpetual workers.
 *
 * Usage:
 *   bun run extensions/watchdog/src/watchdog.ts              # daemon mode
 *   bun run extensions/watchdog/src/watchdog.ts --once       # single pass
 *   bun run extensions/watchdog/src/watchdog.ts --status     # status table
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync, rmSync } from "fs";
import { join } from "path";
import { resolveConfig, resolveProjectRoot, resolveProjectName, CRASH_DIR, RUNTIME_DIR, FLEET_DATA, FLEET_CLI } from "./config";
import { logInfo, logWarn, logError, setQuiet } from "./logger";
import { checkWorkerAsync } from "./worker-checker";
import { markCrashLoop } from "./crash-tracker";
import { listPaneInfo, isValidPaneId, sessionExists, windowExists, splitIntoWindow, setPaneTitle, moveToInactive, enforceWindow } from "./pane-manager";
import { resumeInPane, relaunchInPane, killAgentInPane, gracefulShutdown } from "./process-manager";
import { desktopNotify, notifyDeadWorker, clearCosNotified, checkStaleInput, notifyUnreadMail } from "./notifications";
import { buildAllSnapshots } from "./snapshot";
import { printStatus } from "./status-display";
import { createProductionEffects } from "./effects";
import type { WorkerSnapshot } from "./types";

// ── Parse CLI args ──
const args = process.argv.slice(2);
const mode = args.includes("--status") ? "status"
  : args.includes("--once") ? "once"
  : "daemon";

if (args.includes("--quiet")) setQuiet(true);

// ── Resolve config ──
const config = resolveConfig();
const projectRoot = resolveProjectRoot();
const projectName = resolveProjectName(projectRoot);

// ── Ensure directories ──
mkdirSync(CRASH_DIR, { recursive: true });
mkdirSync(RUNTIME_DIR, { recursive: true });

logInfo("START", `Watchdog starting (mode=${mode}, interval=${config.checkInterval}s, stuck=${config.stuckThresholdSec}s)`);

// ── Status mode ──
if (mode === "status") {
  const snapshots = buildAllSnapshots(projectName, config);
  printStatus(snapshots);
  process.exit(0);
}

// ── Execute one watchdog pass ──
async function runOnce(): Promise<void> {
  const projectDir = join(FLEET_DATA, projectName);
  if (!existsSync(projectDir)) return;

  const snapshots = buildAllSnapshots(projectName, config);
  if (snapshots.length === 0) return;

  // Create fresh effects (with fresh pane cache) for this pass
  const effects = createProductionEffects(projectName);
  const paneInfo = listPaneInfo();

  for (const snap of snapshots) {
    try {
      const action = await checkWorkerAsync(snap, config, effects);

      switch (action.type) {
        case "skip":
          // No-op (most workers skip)
          break;

        case "ok":
          clearCosNotified(snap.name);
          break;

        case "resume": {
          logInfo("RESUME", action.reason, snap.name);
          await resumeInPane(snap, projectName, projectRoot, action.reason);
          // Record relaunch
          updateStateRelaunch(snap.name, action.reason);
          // Clear stuck marker
          effects.clearStuckCandidate(snap.name);
          if (action.stagger) await stagger(snap.name);
          break;
        }

        case "relaunch": {
          logInfo("RELAUNCH", action.reason, snap.name);
          // Determine relaunch strategy
          const session = snap.tmuxSession || "w";
          if (!sessionExists(session)) {
            logInfo("FLEET-START", `session '${session}' gone, using fleet start`, snap.name);
            launchViaFleet(snap.name);
          } else if (snap.window && windowExists(session, snap.window)) {
            // Split into existing window
            const wt = snap.worktree || projectRoot;
            const newPane = splitIntoWindow(session, snap.window, wt);
            if (newPane) {
              setPaneTitle(newPane, snap.name);
              updateStatePaneId(snap.name, newPane);
              await relaunchInPane(newPane, snap, projectName, projectRoot);
              logInfo("RESPAWN-SPLIT", `into window '${snap.window}' (pane ${newPane})`, snap.name);
            } else {
              launchViaFleet(snap.name);
            }
          } else {
            logInfo("FLEET-START", `window '${snap.window || "?"}' gone, using fleet start`, snap.name);
            launchViaFleet(snap.name);
          }
          updateStateRelaunch(snap.name, action.reason);
          if (action.stagger) await stagger(snap.name);
          break;
        }

        case "fleet-start": {
          logInfo("FLEET-START", action.reason, snap.name);
          launchViaFleet(snap.name);
          updateStateRelaunch(snap.name, action.reason);
          if (action.stagger) await stagger(snap.name);
          break;
        }

        case "bare-shell-restart": {
          logInfo("BARE-SHELL", action.reason, snap.name);
          if (snap.paneId) {
            killAgentInPane(snap.paneId);
            await Bun.sleep(5000);
            await relaunchInPane(snap.paneId, snap, projectName, projectRoot);
          }
          updateStateRelaunch(snap.name, "bare-shell");
          if (action.stagger) await stagger(snap.name);
          break;
        }

        case "graceful-kill": {
          // round_stop() set status=sleeping. Gracefully kill the session
          // so the worker gets a fresh context on next respawn.
          // Don't relaunch — the next pass will see sleeping+dead pane
          // and wait for sleep_until to expire before respawning.
          logInfo("GRACEFUL-KILL", action.reason, snap.name);
          if (snap.paneId) {
            await gracefulShutdown(snap.paneId, snap.name, action.reason);
            killAgentInPane(snap.paneId);
          }
          break;
        }

        case "move-inactive": {
          logInfo("INACTIVE", action.reason, snap.name);
          if (snap.paneId && isValidPaneId(snap.paneId)) {
            moveToInactive(snap.paneId, snap.tmuxSession || "w");
          }
          updateStateInactive(snap.name);
          await notifyDeadWorker(snap.name, "inactive", action.reason, projectName);
          break;
        }

        case "crash-loop": {
          if (action.count >= 0) {
            markCrashLoop(snap.name);
            logError("CRASH-LOOP", `${action.count} crashes in last hour, stopping retries`, snap.name);
            desktopNotify(`Crash loop: ${snap.name} (${action.count} crashes/hr) — manual intervention needed`, "Watchdog Alert");
          }
          break;
        }
      }

      // Enforce window placement for alive panes (regardless of action)
      if (snap.paneId && snap.window && isValidPaneId(snap.paneId)) {
        const alive = effects.isPaneAlive(snap.paneId);
        if (alive) {
          const moved = enforceWindow(snap.paneId, snap.window, snap.tmuxSession || "w", paneInfo);
          if (moved) logInfo("ENFORCE-WIN", `moved to ${snap.window}`, snap.name);

          // Check stale input
          checkStaleInput(snap.paneId, snap.name);

          // Notify about unread Fleet Mail for active workers running Claude
          if (action.type === "ok") {
            const unreadCount = await effects.getWorkerUnreadCount(snap.name);
            if (unreadCount > 0) {
              notifyUnreadMail(snap.name, unreadCount);
              // Log high-watermark warning for mailbox depth (Erlang-style backpressure signal)
              if (unreadCount > 10) {
                logWarn("MAILBOX-DEPTH", `${unreadCount} unread messages — may be falling behind`, snap.name);
              }
            }
          }
        }
      }
    } catch (err: any) {
      logError("CHECK-ERR", err.message || String(err), snap.name);
    }
  }

  // Prune stale crash/runtime dirs for deregistered workers
  pruneStaleData(snapshots);
}

// ── Helpers ──

function launchViaFleet(workerName: string): void {
  const fleet = Bun.which("fleet") || FLEET_CLI;
  const result = Bun.spawnSync([fleet, "start", workerName, "-p", projectName], {
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
  });
  if (result.exitCode !== 0) {
    const stderr = result.stderr?.toString().trim().slice(0, 200) || "unknown error";
    logWarn("LAUNCH-FAIL", `fleet start ${workerName} exited ${result.exitCode}: ${stderr}`, workerName);
  }
}

function updateStateRelaunch(workerName: string, reason: string): void {
  const statePath = join(FLEET_DATA, projectName, workerName, "state.json");
  try {
    const state = JSON.parse(require("fs").readFileSync(statePath, "utf-8"));
    state.last_relaunch = {
      at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      reason,
    };
    state.relaunch_count = (state.relaunch_count || 0) + 1;
    if (state.status === "sleeping") {
      state.status = "active";
      if (state.custom) state.custom.sleep_until = null;
    }
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {}

  // Touch liveness so next pass doesn't re-detect as stuck
  const runtimeDir = join(RUNTIME_DIR, workerName);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(join(runtimeDir, "liveness"), String(Math.floor(Date.now() / 1000)));
}

function updateStateInactive(workerName: string): void {
  const statePath = join(FLEET_DATA, projectName, workerName, "state.json");
  try {
    const state = JSON.parse(require("fs").readFileSync(statePath, "utf-8"));
    state.status = "inactive";
    state.pane_id = "";
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {}
}

function updateStatePaneId(workerName: string, paneId: string): void {
  const statePath = join(FLEET_DATA, projectName, workerName, "state.json");
  try {
    const state = JSON.parse(require("fs").readFileSync(statePath, "utf-8"));
    state.pane_id = paneId;
    state.status = "active";
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {}
}

async function stagger(workerName: string): Promise<void> {
  const delay = Math.floor(Math.random() * 10 + 8) * 1000;
  logInfo("STAGGER", `sleeping ${delay / 1000}s after respawning`, workerName);
  await Bun.sleep(delay);
}

function pruneStaleData(snapshots: WorkerSnapshot[]): void {
  const knownNames = new Set(snapshots.map(s => s.name));

  // Crash files
  try {
    for (const f of readdirSync(CRASH_DIR)) {
      if (!f.endsWith(".json")) continue;
      const name = f.replace(".json", "");
      if (!knownNames.has(name)) {
        try { unlinkSync(join(CRASH_DIR, f)); } catch {}
      }
    }
  } catch {}

  // Runtime dirs
  try {
    for (const d of readdirSync(RUNTIME_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      if (!knownNames.has(d.name)) {
        try { rmSync(join(RUNTIME_DIR, d.name), { recursive: true, force: true }); } catch {}
      }
    }
  } catch {}
}

// ── Main ──

if (mode === "once") {
  await runOnce();
  logInfo("DONE", "Single-pass complete");
  process.exit(0);
}

// Daemon mode
while (true) {
  await runOnce();
  await Bun.sleep(config.checkInterval * 1000);
}
