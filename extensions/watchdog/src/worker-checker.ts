/**
 * Core state machine: checkWorker() → WorkerAction.
 * Pure function — all side effects go through WatchdogEffects.
 * Every code path returns an explicit WorkerAction (no implicit returns).
 */

import type { WorkerAction, WorkerSnapshot, WatchdogConfig, WatchdogEffects } from "./types";
import { checkScrollbackStuck } from "./stuck-detector";
import { isCrashLooped, incrementCrashCount } from "./crash-tracker";

/** Claude TUI indicators — used for bare-shell detection */
const TUI_INDICATORS = /bypass permissions|thinking|Osmosing|Booping|Garnishing|Reading|Searching|Editing|Writing|Running|Worked for|esc to interrupt|❯\s*$/m;

/**
 * Parse an ISO 8601 timestamp to epoch seconds.
 * Handles TypeScript-style "2026-03-11T01:48:02.242Z" (with millis).
 * Returns 0 on parse failure.
 */
export function parseIsoEpoch(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

/**
 * Check a single worker and return what action to take.
 * Pure logic — caller handles side effects based on the returned action.
 */
export function checkWorker(
  snap: WorkerSnapshot,
  config: WatchdogConfig,
  effects: WatchdogEffects,
): WorkerAction {
  const now = effects.nowEpoch();

  // ── Skip conditions ──

  // Ephemeral — deep-review workers, no watchdog management
  if (snap.ephemeral) {
    return { type: "skip", reason: "ephemeral" };
  }

  // Standby — intentionally dormant
  if (snap.status === "standby") {
    return { type: "skip", reason: "standby" };
  }

  // Invalid pane_id — sanitize (valid IDs start with %)
  if (snap.paneId && !snap.paneId.startsWith("%")) {
    return { type: "skip", reason: `invalid pane_id '${snap.paneId}' — needs sanitizing` };
  }

  // Crash-looped — don't retry
  if (isCrashLooped(snap.name)) {
    return { type: "crash-loop", count: -1 };
  }

  // ── Sleeping workers ──
  if (snap.status === "sleeping") {
    return handleSleeping(snap, config, effects, now);
  }

  // Race condition: active status but sleep_until is in the future
  if (snap.perpetual && snap.sleepUntil) {
    const wakeEpoch = parseIsoEpoch(snap.sleepUntil);
    if (wakeEpoch > 0 && now < wakeEpoch) {
      // Check early wake (unread mail) — must be async, so return skip and let caller handle
      return { type: "skip", reason: "active-with-future-sleep_until — needs async mail check" };
    }
  }

  // ── No pane registered ──
  if (!snap.paneId) {
    return handleNoPane(snap, config, effects, now);
  }

  // ── Pane alive? ──
  const paneAlive = effects.isPaneAlive(snap.paneId);

  if (paneAlive) {
    return handlePaneAlive(snap, config, effects, now);
  }

  // ── Pane dead ──
  return handlePaneDead(snap, config, effects, now);
}

// ── Sleeping handler ──

function handleSleeping(
  snap: WorkerSnapshot,
  _config: WatchdogConfig,
  effects: WatchdogEffects,
  now: number,
): WorkerAction {
  // If pane is still alive, gracefully kill it first.
  // round_stop() set status="sleeping" but the session is still running.
  // We need to kill it so the worker gets a fresh context on respawn.
  if (snap.paneId) {
    const paneAlive = effects.isPaneAlive(snap.paneId);
    if (paneAlive) {
      // Gracefully kill the session — don't relaunch yet.
      // The next watchdog pass will see a dead pane + sleeping status,
      // wait for sleep_until to expire, then fleet-start with a fresh context.
      return { type: "graceful-kill", reason: "round_stop() → sleeping, killing session for clean restart" };
    }
  }

  if (snap.sleepUntil) {
    const wakeEpoch = parseIsoEpoch(snap.sleepUntil);
    if (wakeEpoch > 0 && now < wakeEpoch) {
      // Still within sleep window — caller should check for early wake (mail)
      return { type: "skip", reason: "sleeping — timer not expired" };
    }
    // Timer expired — wake up
    return { type: "fleet-start", reason: `sleep_until (${snap.sleepUntil}) expired`, stagger: true };
  }

  // No sleep_until: calculate from sleep_duration
  if (snap.sleepDuration && snap.sleepDuration > 0) {
    // No timer set — needs to be calculated, skip for now
    return { type: "skip", reason: "sleeping — no sleep_until, needs calculation" };
  }

  // No sleep_duration either — just wake up
  return { type: "fleet-start", reason: "sleeping with no timer or duration", stagger: true };
}

// ── No-pane handler ──

function handleNoPane(
  snap: WorkerSnapshot,
  _config: WatchdogConfig,
  _effects: WatchdogEffects,
  now: number,
): WorkerAction {
  // Non-perpetual with no pane — skip (finished naturally)
  if (!snap.perpetual) {
    return { type: "skip", reason: "non-perpetual with no pane" };
  }

  // Grace: recently created (< 180s)
  const createdEpoch = parseIsoEpoch(snap.createdAt);
  if (createdEpoch > 0 && (now - createdEpoch) < 180) {
    return { type: "skip", reason: "recently created — grace period" };
  }

  // Grace: recently relaunched (< 120s)
  const relaunchEpoch = parseIsoEpoch(snap.lastRelaunchAt);
  if (relaunchEpoch > 0 && (now - relaunchEpoch) < 120) {
    return { type: "skip", reason: "recently relaunched — cooldown" };
  }

  // Grace: fleet launch actively running
  const fleetRunning = Bun.spawnSync(["pgrep", "-f", "fleet.*start"], { stderr: "pipe" });
  if (fleetRunning.exitCode === 0) {
    return { type: "skip", reason: "fleet start in progress" };
  }

  return { type: "fleet-start", reason: "perpetual worker has no pane_id", stagger: true };
}

// ── Pane alive handler ──

function handlePaneAlive(
  snap: WorkerSnapshot,
  config: WatchdogConfig,
  effects: WatchdogEffects,
  now: number,
): WorkerAction {
  // Relaunch cooldown: if last relaunch < 120s, skip entirely
  const relaunchEpoch = parseIsoEpoch(snap.lastRelaunchAt);
  if (relaunchEpoch > 0 && (now - relaunchEpoch) < 120) {
    return { type: "ok" };
  }

  // Memory-leak recycle: session alive > maxCycleSec
  if (snap.perpetual && relaunchEpoch > 0 && (now - relaunchEpoch) > config.maxCycleSec) {
    return { type: "resume", reason: `memory-leak-recycle (${now - relaunchEpoch}s)`, stagger: true };
  }

  // Check liveness heartbeat
  const liveness = effects.readLiveness(snap.name);

  if (liveness !== null) {
    // Guard: non-numeric
    if (isNaN(liveness) || liveness <= 0) {
      effects.writeLiveness(snap.name, now);
      return { type: "ok" };
    }

    const sinceActive = now - liveness;

    // Non-perpetual idle 3+ hours: kill to reclaim memory
    if (!snap.perpetual && sinceActive >= 10800) {
      return { type: "move-inactive", reason: `non-perpetual idle ${sinceActive}s` };
    }

    // sleep_duration is a POST-CYCLE sleep interval, not a max runtime.
    // The watchdog only uses it in handleSleeping() after round_stop() sets
    // status="sleeping" + sleep_until. Do NOT restart active workers based
    // on sleep_duration — let them work until they call round_stop().

    // Liveness threshold — if recently active, skip further checks
    const livenessThreshold = snap.perpetual ? 1200 : 300;

    if (sinceActive < livenessThreshold) {
      effects.clearStuckCandidate(snap.name);
      return { type: "ok" };
    }
  } else {
    // No liveness file — seed it
    effects.writeLiveness(snap.name, now);
    return { type: "ok" };
  }

  // ── Bare-shell detection ──
  const paneContent = effects.capturePane(snap.paneId!, 30);
  if (!TUI_INDICATORS.test(paneContent)) {
    if (snap.perpetual) {
      return { type: "bare-shell-restart", reason: "Claude not running in pane", stagger: true };
    }
    return { type: "move-inactive", reason: "bare-shell — no Claude TUI" };
  }

  // ── Stuck detection (scrollback diff) ──
  const idleSec = checkScrollbackStuck(snap.paneId!, snap.name, now, effects);

  // Effective threshold: for perpetual, use max(1200, configured)
  // sleep_duration is NOT used here — it's a post-cycle sleep interval, not a stuck threshold
  let effectiveThreshold = config.stuckThresholdSec;
  if (snap.perpetual) {
    effectiveThreshold = Math.max(effectiveThreshold, 1200);
  }

  if (idleSec > effectiveThreshold) {
    if (snap.perpetual) {
      return { type: "resume", reason: `stuck ${idleSec}s`, stagger: true };
    }
    return { type: "skip", reason: `stuck ${idleSec}s but non-perpetual` };
  }

  return { type: "ok" };
}

// ── Pane dead handler ──

function handlePaneDead(
  snap: WorkerSnapshot,
  config: WatchdogConfig,
  _effects: WatchdogEffects,
  now: number,
): WorkerAction {
  // Non-perpetual: mark inactive
  if (!snap.perpetual) {
    return { type: "move-inactive", reason: `dead pane (${snap.paneId})` };
  }

  // Crash-loop guard
  const crashCount = incrementCrashCount(snap.name, now);
  if (crashCount >= config.maxCrashesPerHr) {
    return { type: "crash-loop", count: crashCount };
  }

  // Relaunch strategy depends on whether window/session still exist
  return { type: "relaunch", reason: `dead pane (${snap.paneId})`, stagger: true };
}

/**
 * Async version of checkWorker that handles mail-based early wake.
 * Wraps checkWorker and resolves "needs async mail check" paths.
 */
export async function checkWorkerAsync(
  snap: WorkerSnapshot,
  config: WatchdogConfig,
  effects: WatchdogEffects,
): Promise<WorkerAction> {
  const action = checkWorker(snap, config, effects);

  // Handle sleeping workers that need mail check for early wake
  if (action.type === "skip" && action.reason === "sleeping — timer not expired") {
    const hasUnread = await effects.workerHasUnreadMail(snap.name);
    if (hasUnread) {
      return { type: "fleet-start", reason: "early-wake — unread Fleet Mail", stagger: true };
    }
    return action;
  }

  // Handle active-with-future-sleep_until race
  if (action.type === "skip" && action.reason.startsWith("active-with-future-sleep_until")) {
    const hasUnread = await effects.workerHasUnreadMail(snap.name);
    if (hasUnread) {
      return { type: "fleet-start", reason: "early-wake — unread Fleet Mail (active race)", stagger: true };
    }
    return { type: "skip", reason: "sleeping (active status but sleep_until in future)" };
  }

  return action;
}
