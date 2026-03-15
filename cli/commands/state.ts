/**
 * fleet state — Persistent key-value state for the current session.
 *
 *   fleet state get [key]          — Read state (or specific key)
 *   fleet state set <key> <value>  — Write a key-value pair
 */

import type { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync, rmdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { addGlobalOpts } from "../index";
import { fail, ok } from "../lib/fmt";
import { resolveSessionId, sessionDir, resolveIdentity, resolveDirSlug } from "../../shared/identity";
import { FLEET_DATA } from "../lib/paths";

export function register(parent: Command): void {
  const state = parent
    .command("state")
    .description("Persistent key-value state");

  // ── fleet state get ─────────────────────────────────────────────
  const get = state
    .command("get [key]")
    .description("Read state (all or a specific key)");
  addGlobalOpts(get)
    .action(async (key: string | undefined) => {
      const statePath = getStatePath();

      let data: Record<string, unknown> = {};
      try { data = JSON.parse(readFileSync(statePath, "utf-8")); } catch {}

      if (key) {
        const val = data[key];
        if (val === undefined) {
          console.log("(not set)");
        } else {
          console.log(typeof val === "string" ? val : JSON.stringify(val));
        }
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    });

  // ── fleet state set ─────────────────────────────────────────────
  const set = state
    .command("set <key> <value>")
    .description("Set a key-value pair");
  addGlobalOpts(set)
    .action(async (key: string, value: string) => {
      const statePath = getStatePath();
      const dir = dirname(statePath);
      mkdirSync(dir, { recursive: true });

      // mkdir-based atomic lock (see REVIEW.md rule 8, Never Flag #3)
      const lockDir = join(dir, ".state.lock");
      const maxRetries = 10;
      const retryDelay = 100; // ms
      let acquired = false;

      for (let i = 0; i < maxRetries; i++) {
        try {
          mkdirSync(lockDir);
          acquired = true;
          break;
        } catch (err: any) {
          if (err.code === "EEXIST") {
            await new Promise(r => setTimeout(r, retryDelay));
          } else {
            throw err;
          }
        }
      }

      if (!acquired) {
        fail("Cannot acquire state lock — another process is writing. Retry shortly.");
      }

      try {
        let data: Record<string, unknown> = {};
        try { data = JSON.parse(readFileSync(statePath, "utf-8")); } catch {}

        // Try to parse value as JSON, fall back to string
        try { data[key] = JSON.parse(value); } catch { data[key] = value; }

        writeFileSync(statePath, JSON.stringify(data, null, 2) + "\n");
        ok(`${key} = ${typeof data[key] === "string" ? data[key] : JSON.stringify(data[key])}`);
      } finally {
        try { rmdirSync(lockDir); } catch {}
      }
    });
}

/** Resolve the state.json path, or fail. Returns a guaranteed string. */
function getStatePath(): string {
  const identity = resolveIdentity();

  if (identity?.type === "session") {
    return join(sessionDir(identity.identity.sessionId), "state.json");
  }

  if (identity?.type === "legacy") {
    const project = resolveDirSlug();
    return join(FLEET_DATA, project, identity.workerName, "state.json");
  }

  const sid = resolveSessionId();
  if (sid) return join(sessionDir(sid), "state.json");

  return fail("Cannot detect session/worker identity");
}
