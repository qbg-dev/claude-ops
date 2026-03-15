/**
 * fleet checkpoint — Snapshot working state for crash recovery.
 *
 *   fleet checkpoint "<summary>"
 */

import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addGlobalOpts } from "../index";
import { fail, ok } from "../lib/fmt";
import { resolveIdentity, resolveSessionId, sessionDir, resolveDirSlug } from "../../shared/identity";
import { FLEET_DATA } from "../lib/paths";

export function register(parent: Command): void {
  const sub = parent
    .command("checkpoint <summary>")
    .description("Save a state checkpoint for crash recovery")
    .option("--key-facts <facts>", "Comma-separated key facts");
  addGlobalOpts(sub)
    .action(async (summary: string, opts: { keyFacts?: string }) => {
      const dir = getCheckpointDir();
      mkdirSync(dir, { recursive: true });

      const ts = new Date().toISOString();
      const filename = `checkpoint-${ts.replace(/[:.]/g, "-")}.json`;

      const checkpoint = {
        summary,
        key_facts: opts.keyFacts?.split(",").map(f => f.trim()) || [],
        timestamp: ts,
        cwd: process.cwd(),
      };

      writeFileSync(join(dir, filename), JSON.stringify(checkpoint, null, 2) + "\n");
      ok(`Checkpoint saved: ${filename}`);
    });
}

function getCheckpointDir(): string {
  const identity = resolveIdentity();

  if (identity?.type === "session") {
    return join(sessionDir(identity.identity.sessionId), "checkpoints");
  }

  if (identity?.type === "legacy") {
    return join(FLEET_DATA, resolveDirSlug(), identity.workerName, "checkpoints");
  }

  const sid = resolveSessionId();
  if (sid) return join(sessionDir(sid), "checkpoints");

  return fail("Cannot detect session/worker identity");
}
