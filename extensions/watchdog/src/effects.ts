/**
 * Production WatchdogEffects implementation.
 * Delegates to tmux, filesystem, Fleet Mail.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import type { WatchdogEffects } from "./types";
import { RUNTIME_DIR, FLEET_DATA } from "./config";
import { listAlivePanes } from "./pane-manager";
import { logWarn } from "./logger";

/** Create production effects for a given project */
export function createProductionEffects(projectName: string): WatchdogEffects {
  // Cache alive panes for the duration of one watchdog pass
  let _alivePanes: Set<string> | null = null;
  function getAlivePanes(): Set<string> {
    if (!_alivePanes) _alivePanes = listAlivePanes();
    return _alivePanes;
  }

  function runtimeDir(worker: string): string {
    const dir = join(RUNTIME_DIR, worker);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  return {
    isPaneAlive(paneId: string): boolean {
      return getAlivePanes().has(paneId);
    },

    capturePane(paneId: string, lines = 30): string {
      const result = Bun.spawnSync(
        ["tmux", "capture-pane", "-t", paneId, "-p", "-S", `-${lines}`],
        { stderr: "pipe" },
      );
      return result.exitCode === 0 ? result.stdout.toString().trim() : "";
    },

    getPaneWindow(paneId: string): string | null {
      const result = Bun.spawnSync(
        ["tmux", "list-panes", "-a", "-F", "#{pane_id}\t#{window_name}"],
        { stderr: "pipe" },
      );
      if (result.exitCode !== 0) return null;
      for (const line of result.stdout.toString().split("\n")) {
        const [id, win] = line.split("\t");
        if (id === paneId) return win || null;
      }
      return null;
    },

    readLiveness(worker: string): number | null {
      const f = join(runtimeDir(worker), "liveness");
      if (!existsSync(f)) return null;
      try {
        const val = parseInt(readFileSync(f, "utf-8").trim(), 10);
        return isNaN(val) ? null : val;
      } catch {
        return null;
      }
    },

    writeLiveness(worker: string, ts: number): void {
      writeFileSync(join(runtimeDir(worker), "liveness"), String(ts));
    },

    readScrollbackHash(worker: string): string | null {
      const f = join(runtimeDir(worker), "scrollback-hash");
      if (!existsSync(f)) return null;
      try { return readFileSync(f, "utf-8").trim(); } catch { return null; }
    },

    writeScrollbackHash(worker: string, hash: string): void {
      writeFileSync(join(runtimeDir(worker), "scrollback-hash"), hash);
    },

    readStuckCandidate(worker: string): number | null {
      const f = join(runtimeDir(worker), "stuck-candidate");
      if (!existsSync(f)) return null;
      try {
        const val = parseInt(readFileSync(f, "utf-8").trim(), 10);
        return isNaN(val) ? null : val;
      } catch {
        return null;
      }
    },

    writeStuckCandidate(worker: string, ts: number): void {
      writeFileSync(join(runtimeDir(worker), "stuck-candidate"), String(ts));
    },

    clearStuckCandidate(worker: string): void {
      const f = join(runtimeDir(worker), "stuck-candidate");
      try { unlinkSync(f); } catch {}
    },

    async workerHasUnreadMail(worker: string): Promise<boolean> {
      const fleetMailUrl = process.env.FLEET_MAIL_URL || "http://127.0.0.1:8025";
      const tokenPath = join(FLEET_DATA, projectName, worker, "token");
      let token: string;
      try {
        token = readFileSync(tokenPath, "utf-8").trim();
      } catch {
        return false;
      }
      if (!token) return false;

      try {
        const resp = await fetch(
          `${fleetMailUrl}/api/messages?label=UNREAD&maxResults=1`,
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
          },
        );
        if (!resp.ok) return false;
        const data = await resp.json() as any;
        const count = data?._diagnostics?.unread_count ?? data?.messages?.length ?? 0;
        return count > 0;
      } catch (e) {
        logWarn("MAIL-CHECK", `Fleet Mail check failed for ${worker}: ${e instanceof Error ? e.message : e}`, worker);
        return false;
      }
    },

    nowEpoch(): number {
      return Math.floor(Date.now() / 1000);
    },
  };
}

/** Reset the alive panes cache (call at start of each watchdog pass) */
export function resetPaneCache(): void {
  // The cache is local to the effects instance created by createProductionEffects,
  // so create a new instance for each pass.
}
