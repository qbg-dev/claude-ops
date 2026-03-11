/**
 * State tools — get_worker_state, update_state
 *
 * Removed tools (use fleet CLI instead):
 *   update_config → fleet defaults <key> <value>
 *   update_worker_config → fleet config <name> <key> <value>
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, basename } from "path";
import { execSync } from "child_process";
import { PROJECT_ROOT, CLAUDE_OPS, WORKERS_DIR, FLEET_DIR, WORKER_NAME } from "../config";
import { getWorkerEntry, withRegistryLocked, ensureWorkerInRegistry, canUpdateWorker, type RegistryWorkerEntry } from "../registry";
import { isPaneAlive } from "../tmux";
import { withLint } from "../diagnostics";

export function registerStateTools(server: McpServer): void {

server.registerTool(
  "get_worker_state",
  { description: "Read a worker's state from the central registry. Returns status, sleep_duration config, last commit info, issue counts, and any custom state keys. For a single worker, returns raw JSON. For name='all', returns a formatted fleet dashboard with a table of all workers showing runtime, status, pane health (alive/dead), and current in-progress task — plus a custom state section. The fleet view also auto-discovers workers from the filesystem and prunes dead panes.", inputSchema: {
    name: z.string().optional().describe("Worker name to query. Omit for your own state. Use 'all' for a fleet-wide dashboard showing every registered worker, pane health, and active tasks"),
  } },
  async ({ name }) => {
    try {
      // Fleet-wide overview
      if (name === "all") {
        // Cache pane liveness to avoid duplicate subprocess calls per worker
        const paneAliveCache = new Map<string, boolean>();
        const checkPaneAlive = (paneId: string): boolean => {
          const cached = paneAliveCache.get(paneId);
          if (cached !== undefined) return cached;
          const alive = isPaneAlive(paneId);
          paneAliveCache.set(paneId, alive);
          return alive;
        };

        const registry = withRegistryLocked((reg) => {
          // Auto-discover workers from per-worker fleet dirs (config.json) and legacy workers dir (mission.md)
          try {
            const fleetDirs = readdirSync(FLEET_DIR, { withFileTypes: true })
              .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_") && d.name !== "missions")
              .filter(d => existsSync(join(FLEET_DIR, d.name, "config.json")))
              .map(d => d.name);
            for (const n of fleetDirs) ensureWorkerInRegistry(reg, n);
          } catch {}
          try {
            const legacyDirs = readdirSync(WORKERS_DIR, { withFileTypes: true })
              .filter(d => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_"))
              .filter(d => existsSync(join(WORKERS_DIR, d.name, "mission.md")))
              .map(d => d.name);
            for (const n of legacyDirs) ensureWorkerInRegistry(reg, n);
          } catch {}
          // Auto-prune dead panes
          for (const [key, entry] of Object.entries(reg)) {
            if (key === "_config" || typeof entry !== "object" || !entry) continue;
            const w = entry as RegistryWorkerEntry;
            if (w.pane_id && !checkPaneAlive(w.pane_id)) {
              w.pane_id = null; w.pane_target = null; w.session_id = null;
            }
          }
          return { ...reg };
        });

        const projectName = basename(PROJECT_ROOT);
        let output = `=== Fleet Status (${projectName}) ===\n${new Date().toISOString()}\n\n`;
        const header = `${"Worker".padEnd(22)} ${"Runtime".padEnd(9)} ${"Status".padEnd(10)} ${"Pane".padEnd(12)} ${"Active Task"}`;
        output += header + "\n" + `${"------".padEnd(22)} ${"-------".padEnd(9)} ${"------".padEnd(10)} ${"----".padEnd(12)} ${"-----------"}\n`;

        const entries = Object.entries(registry).filter(([k]) => k !== "_config").sort(([a], [b]) => a.localeCompare(b));
        for (const [n, entry] of entries) {
          const w = entry as RegistryWorkerEntry;
          const task = ""; // Tasks are now LKML mail threads — no local lookup
          const paneStatus = w.pane_id ? (checkPaneAlive(w.pane_id) ? `${w.pane_id}` : `${w.pane_id} DEAD`) : "—";
          const runtime = String(w.custom?.runtime || "claude");
          output += `${n.padEnd(22)} ${runtime.padEnd(9)} ${String(w.status || "?").padEnd(10)} ${paneStatus.padEnd(12)} ${task}\n`;
        }

        // Custom state
        const stateLines: string[] = [];
        for (const [n, entry] of entries) {
          const w = entry as RegistryWorkerEntry;
          if (w.custom && Object.keys(w.custom).length > 0) {
            stateLines.push(`  ${n}: ${Object.entries(w.custom).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`).join(", ")}`);
          }
        }
        if (stateLines.length > 0) output += "\n=== State ===\n" + stateLines.join("\n") + "\n";

        return withLint({ content: [{ type: "text" as const, text: output }] });
      }

      // Single worker state
      const targetName = name || WORKER_NAME;
      const entry = getWorkerEntry(targetName);
      if (!entry) {
        return { content: [{ type: "text" as const, text: `No state for worker '${targetName}'` }], isError: true };
      }
      const state: Record<string, any> = {
        status: entry.status,
        perpetual: entry.sleep_duration !== null && entry.sleep_duration !== undefined && (entry.sleep_duration as number) > 0,  // derived from sleep_duration
        sleep_duration: entry.sleep_duration,
        ...entry.custom,
      };
      if (entry.last_commit_sha) state.last_commit_sha = entry.last_commit_sha;
      if (entry.last_commit_msg) state.last_commit_msg = entry.last_commit_msg;
      if (entry.last_commit_at) state.last_commit_at = entry.last_commit_at;
      if (entry.issues_found) state.issues_found = entry.issues_found;
      if (entry.issues_fixed) state.issues_fixed = entry.issues_fixed;
      return withLint({ content: [{ type: "text" as const, text: JSON.stringify(state, null, 2) }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

server.registerTool(
  "update_state",
  { description: "Write a key-value pair to the worker registry that persists across recycles. Use for sleep_duration, custom metrics, feature flags, or any state that must survive restarts. Known keys (status, sleep_duration, last_commit_sha/msg/at, issues_found/fixed, report_to) are stored at the top level; all other keys go into the custom state bag. Cross-worker updates require authority — you must be the target's report_to or the mission_authority. Note: 'perpetual' is read-only (derived from sleep_duration) — set sleep_duration instead.", inputSchema: {
    key: z.string().describe("State key name. Known keys (status, sleep_duration, report_to, model, permission_mode, disallowed_tools, branch, worktree, mission_file, pane_id, pane_target, tmux_session, window, session_id, session_file, bms_token, forked_from, last_commit_sha, last_commit_msg, last_commit_at, issues_found, issues_fixed) go top-level. 'perpetual' is read-only — use sleep_duration instead. Any other key goes into the custom state bag"),
    value: z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.string())]).describe("Value to store. Primitives, null, or string arrays (for disallowed_tools)"),
    worker: z.string().optional().describe("Target worker. Omit to update your own state. Cross-worker updates are authorized only if you are the target's report_to or the mission_authority"),
  } },
  async ({ key, value, worker }) => {
    try {
      const targetName = worker || WORKER_NAME;

      // Block direct writes to 'perpetual' — it's derived from sleep_duration
      if (key === "perpetual") {
        return { content: [{ type: "text" as const, text: `Error: 'perpetual' is read-only (derived from sleep_duration). Set sleep_duration instead: null = one-shot, N > 0 = perpetual.` }], isError: true };
      }

      // Write to project registry
      let stateJson: string = "";
      withRegistryLocked((registry) => {
        // Authorization check for cross-worker updates
        if (targetName !== WORKER_NAME && !canUpdateWorker(WORKER_NAME, targetName, registry)) {
          throw new Error(`Not authorized to update '${targetName}' — you are not their report_to or the mission_authority`);
        }

        const entry = ensureWorkerInRegistry(registry, targetName);
        // Allowlist of top-level fields (all worker entry fields are now editable)
        const STATE_KEYS = new Set(["status","sleep_duration",
          "last_commit_sha","last_commit_msg","last_commit_at","issues_found","issues_fixed","report_to",
          "model","permission_mode","disallowed_tools","branch","worktree","mission_file",
          "pane_id","pane_target","tmux_session","window","session_id","session_file","bms_token","forked_from"]);
        if (STATE_KEYS.has(key)) {
          (entry as any)[key] = value;
        } else {
          entry.custom[key] = value;
        }
        stateJson = JSON.stringify(entry, null, 2) + "\n";
      });

      // Sync to watchdog config-cache (best-effort, bypasses macOS TCC restrictions)
      try {
        const cacheDir = join(
          process.env.HOME || "/tmp",
          ".claude-ops/state/harness-runtime/worker",
          targetName
        );
        if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
        writeFileSync(join(cacheDir, "config-cache.json"), stateJson);
      } catch {}

      // Emit bus event (best-effort) — pass payload via env to avoid shell injection
      try {
        const payload = JSON.stringify({
          worker: targetName, key, value, channel: "worker-fleet-mcp", updated_by: WORKER_NAME,
        });
        execSync(
          `source "${CLAUDE_OPS}/lib/event-bus.sh" && bus_publish "agent.state-changed" "$BUS_PAYLOAD"`,
          { cwd: PROJECT_ROOT, timeout: 5000, encoding: "utf-8", shell: "/bin/bash", env: { ...process.env, BUS_PAYLOAD: payload } }
        );
      } catch {}

      const prefix = targetName !== WORKER_NAME ? `${targetName}.` : "state.";
      return withLint({ content: [{ type: "text" as const, text: `Updated ${prefix}${key} = ${JSON.stringify(value)}` }] });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], isError: true };
    }
  }
);

// Removed tools: update_config, update_worker_config
// Use fleet CLI: `fleet defaults <key> <value>` and `fleet config <name> <key> <value>`

} // end registerStateTools
