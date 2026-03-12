/**
 * Notifications: COS dead-worker alerts, desktop notifications.
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { RUNTIME_DIR } from "./config";
import { logInfo, logError } from "./logger";

/** Send desktop notification via `notify` */
export function desktopNotify(message: string, title = "Watchdog"): void {
  try {
    Bun.spawnSync(["notify", message, title], { stderr: "pipe" });
  } catch {}
}

/** Debounced chief-of-staff dead worker notification via Fleet Mail */
export async function notifyDeadWorker(
  worker: string,
  state: string,
  detail: string,
  projectName: string,
): Promise<void> {
  const runtimeDir = join(RUNTIME_DIR, worker);
  mkdirSync(runtimeDir, { recursive: true });
  const flag = join(runtimeDir, "cos-notified");

  // Debounce — only notify once per incident
  if (existsSync(flag)) return;

  // Try Fleet Mail first
  const fleetMailUrl = process.env.FLEET_MAIL_URL || "http://127.0.0.1:8025";
  const adminToken = process.env.FLEET_MAIL_TOKEN;

  if (adminToken) {
    try {
      const body = `Worker '${worker}' — ${state}. ${detail}Consider calling \`deregister\` to remove it from the registry, or restart it manually.`;
      await fetch(`${fleetMailUrl}/api/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: [`chief-of-staff@${projectName}`],
          subject: `Worker ${worker} offline: ${state}`,
          body,
        }),
        signal: AbortSignal.timeout(3000),
      });
      logInfo("NOTIFY-COS", `dead-worker alert sent for ${worker} (${state})`, worker);
    } catch {
      logError("NOTIFY-COS-ERR", `failed to send Fleet Mail notification`, worker);
    }
  }

  writeFileSync(flag, new Date().toISOString());
}

/** Notify all monitors of a worker's death/restart via Fleet Mail (Erlang-style DOWN signal).
 *  Debounced per incident — each monitor gets at most one notification per death event. */
export async function notifyMonitorsOfDeath(
  worker: string,
  monitors: string[],
  reason: "inactive" | "crash-loop" | "relaunch",
  projectName: string,
): Promise<void> {
  if (monitors.length === 0) return;

  const runtimeDir = join(RUNTIME_DIR, worker);
  mkdirSync(runtimeDir, { recursive: true });
  const flag = join(runtimeDir, "monitors-notified");

  // Debounce — only notify once per incident (cleared when worker comes back alive)
  if (existsSync(flag)) return;

  const fleetMailUrl = process.env.FLEET_MAIL_URL || "http://127.0.0.1:8025";
  const adminToken = process.env.FLEET_MAIL_TOKEN;
  if (!adminToken) return;

  const subject = `DOWN: ${worker} (${reason})`;
  const body = [
    `Worker '${worker}' is down.`,
    `Reason: ${reason}`,
    `Timestamp: ${new Date().toISOString()}`,
    reason === "relaunch" ? "Note: worker is being relaunched — this is a transient DOWN signal." : "",
  ].filter(Boolean).join("\n");

  const results = await Promise.allSettled(
    monitors.map(async (monitor) => {
      await fetch(`${fleetMailUrl}/api/messages`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${adminToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: [`${monitor}@${projectName}`],
          subject,
          body,
          labels: ["DOWN-SIGNAL"],
        }),
        signal: AbortSignal.timeout(3000),
      });
      return monitor;
    })
  );

  const sent = results.filter(r => r.status === "fulfilled").length;
  const failed = results.filter(r => r.status === "rejected").length;
  if (sent > 0) logInfo("MONITOR-DOWN", `sent DOWN to ${sent} monitor(s)${failed > 0 ? `, ${failed} failed` : ""}`, worker);
  if (failed > 0 && sent === 0) logError("MONITOR-DOWN-ERR", `failed to send DOWN to all ${failed} monitor(s)`, worker);

  writeFileSync(flag, new Date().toISOString());
}

/** Clear monitor notification flag when worker is alive again */
export function clearMonitorsNotified(worker: string): void {
  const flag = join(RUNTIME_DIR, worker, "monitors-notified");
  try { unlinkSync(flag); } catch {}
}

/** Clear COS notification flag when worker is alive again */
export function clearCosNotified(worker: string): void {
  const flag = join(RUNTIME_DIR, worker, "cos-notified");
  try { unlinkSync(flag); } catch {}
}

/** Debounced desktop notification for unread Fleet Mail (5-min cooldown per worker) */
export function notifyUnreadMail(worker: string, count: number): void {
  const rDir = join(RUNTIME_DIR, worker);
  mkdirSync(rDir, { recursive: true });
  const flag = join(rDir, "unread-notified");
  const now = Math.floor(Date.now() / 1000);

  // Debounce: only notify once per 5 minutes per worker
  if (existsSync(flag)) {
    try {
      const lastTs = parseInt(readFileSync(flag, "utf-8").trim(), 10);
      if (now - lastTs < 300) return;
    } catch {}
  }

  const msg = count === 1
    ? `${worker} has 1 unread message`
    : `${worker} has ${count} unread messages`;
  desktopNotify(msg, "Fleet Mail");
  logInfo("UNREAD-MAIL", `${count} unread message(s)`, worker);
  writeFileSync(flag, String(now));
}

/** Check stale input (unsubmitted Fleet Mail in tmux input buffer) */
export function checkStaleInput(paneId: string, worker: string): boolean {
  const runtimeDir = join(RUNTIME_DIR, worker);
  mkdirSync(runtimeDir, { recursive: true });
  const staleMarker = join(runtimeDir, "stale-input-checked");

  // Debounce: only check once per 60s
  if (existsSync(staleMarker)) {
    try {
      const markerTs = parseInt(readFileSync(staleMarker, "utf-8").trim(), 10);
      const now = Math.floor(Date.now() / 1000);
      if (now - markerTs < 60) return false;
    } catch {}
  }

  // Capture pane tail
  const result = Bun.spawnSync(["tmux", "capture-pane", "-t", paneId, "-p"], { stderr: "pipe" });
  if (result.exitCode !== 0) return false;
  const paneTail = result.stdout.toString().split("\n").slice(-5).join("\n");

  let sent = false;
  if (paneTail.includes("❯") && /mail from/i.test(paneTail)) {
    logInfo("STALE-INPUT", `detected unsubmitted Fleet Mail, pressing Enter`, worker);
    Bun.spawnSync(["tmux", "send-keys", "-t", paneId, "-H", "0d"], { stderr: "pipe" });
    sent = true;
  }

  // Update debounce marker
  writeFileSync(staleMarker, String(Math.floor(Date.now() / 1000)));
  return sent;
}
