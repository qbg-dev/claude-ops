/**
 * Lifecycle tools — round_stop, save_checkpoint
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, existsSync, readdirSync } from "fs";
import { join } from "path";
import { HOME, WORKERS_DIR, WORKER_NAME, getWorktreeDir } from "../config";
import { readRegistry, withRegistryLocked, type RegistryConfig, type RegistryWorkerEntry } from "../registry";
import { _captureHooksSnapshot } from "../hooks";
import { _captureGitState, _writeCheckpoint } from "../helpers";
import { fleetMailRequest, resolveFleetMailRecipients, getFleetMailToken } from "../mail-client";
import { execSync } from "child_process";

export function registerLifecycleTools(server: McpServer): void {

server.registerTool(
  "round_stop",
  { description: `Mark the end of a work round: save checkpoint, write handoff document, send cycle report — but stay alive.

Use this when:
  - You finished a task and want to log progress before starting the next one
  - You're done with all work and want to save state before going idle
  - Context is getting long and you want a clean checkpoint

This does NOT exit your session, restart anything, or touch your hooks.
To actually restart a worker (fresh context, config reload), the operator runs \`fleet recycle <name>\` from the CLI.`, inputSchema: {
    message: z.string().describe("Handoff document: what was accomplished, what remains, any blockers. Written to handoff.md and checkpoint"),
  } },
  async ({ message }) => {
    // Save checkpoint
    try {
      const checkpointDir = join(WORKERS_DIR, WORKER_NAME, "checkpoints");
      const gitState = _captureGitState();
      const hooks = _captureHooksSnapshot();
      _writeCheckpoint(checkpointDir, {
        timestamp: new Date().toISOString(),
        type: "round-stop" as const,
        summary: message,
        git_state: gitState,
        dynamic_hooks: hooks,
        key_facts: [] as string[],
        transcript_ref: "",
      });
    } catch {}

    // Update registry cycle marker + set sleeping status for watchdog
    withRegistryLocked((registry) => {
      const w = registry[WORKER_NAME] as RegistryWorkerEntry;
      if (w) {
        w.custom = w.custom || {};
        w.custom.last_cycle_at = new Date().toISOString();

        // If perpetual (sleep_duration > 0), enter sleeping state.
        // The watchdog will wake us after sleep_duration expires.
        const sleepDuration = w.sleep_duration;
        if (sleepDuration && sleepDuration > 0) {
          w.status = "sleeping";
          const wakeAt = new Date(Date.now() + sleepDuration * 1000).toISOString();
          w.custom.sleep_until = wakeAt;
        }
      }
    });

    // Write handoff.md (for seed injection on next restart)
    try {
      const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
      writeFileSync(handoffPath, message.trim() + "\n");
    } catch {}

    // Notify mission_authority (best-effort)
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      const cycleReport = `[${WORKER_NAME}] Round complete: ${message}`;
      const maList = config?.mission_authority;
      const operatorNames: string[] = !maList ? [] : Array.isArray(maList) ? maList : [maList];
      const filteredOps = operatorNames.filter(n => n !== WORKER_NAME);
      if (filteredOps.length > 0) {
        getFleetMailToken().then(async () => {
          const toIds = await resolveFleetMailRecipients(filteredOps);
          await fleetMailRequest("POST", "/api/messages/send", {
            to: toIds, subject: `${WORKER_NAME} round done`,
            body: cycleReport, cc: [], thread_id: null, in_reply_to: null,
            reply_by: null, labels: ["CYCLE-REPORT"], attachments: [],
          });
        }).catch(() => {});
      }
    } catch {}

    // Hooks are NOT touched — stop hooks, dynamic hooks all remain as-is.

    // Git commit + push (preserve work across crashes)
    let pushResult = "";
    try {
      const cwd = getWorktreeDir();
      const opts = { encoding: "utf-8" as const, timeout: 15000, cwd };
      // Stage all changes
      execSync("git add -A", opts);
      // Commit if there are staged changes
      const status = execSync("git status --porcelain", opts).trim();
      if (status) {
        const commitMsg = `checkpoint: ${WORKER_NAME} round_stop\n\n${message.slice(0, 200)}`;
        execSync(`git commit -m ${JSON.stringify(commitMsg)}`, opts);
      }
      // Push to remote (create tracking branch if needed)
      const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
      execSync(`git push origin ${branch} 2>&1 || git push -u origin ${branch} 2>&1`, { ...opts, timeout: 30000 });
      pushResult = `Pushed ${branch} to origin.`;
    } catch (e: any) {
      pushResult = `Push failed: ${e.message?.slice(0, 100) || "unknown error"}`;
    }

    // Check if we entered sleeping state
    let sleepNote = "Keep working — check mail_inbox() for new tasks, or go idle if nothing pending.";
    try {
      const reg = readRegistry();
      const w = reg[WORKER_NAME] as RegistryWorkerEntry;
      if (w?.status === "sleeping" && w?.custom?.sleep_until) {
        sleepNote = `Entering sleep — watchdog will respawn you after ${w.sleep_duration}s (wake at ${w.custom.sleep_until}). Session will exit shortly.`;
      }
    } catch {}

    return {
      content: [{
        type: "text" as const,
        text: `Round logged, checkpoint saved, handoff written. ${pushResult}\n` +
          `Handoff: "${message.slice(0, 120)}${message.length > 120 ? "..." : ""}"\n` +
          sleepNote,
      }],
    };
  }
);

// ═══════════════════════════════════════════════════════════════════
// CHECKPOINT TOOLS (1) — save_checkpoint
// ═══════════════════════════════════════════════════════════════════

server.registerTool(
  "save_checkpoint",
  {
    description: "Save a checkpoint of your current working state. Automatically captures git state and dynamic hooks. Use before complex operations, when context is getting long, or to preserve state across restarts. Checkpoints are auto-saved on round_stop and before context compaction.",
    inputSchema: {
      summary: z.string().describe("Brief description of what you're working on and current progress"),
      key_facts: z.array(z.string()).optional().describe("Important facts to preserve across context boundaries (max 10)"),
    },
  },
  async ({ summary, key_facts }) => {
    const checkpointDir = join(WORKERS_DIR, WORKER_NAME, "checkpoints");
    const gitState = _captureGitState();
    const hooks = _captureHooksSnapshot();

    // Get transcript reference
    let transcriptRef = "";
    try {
      const worktreeDir = getWorktreeDir();
      const pathSlug = worktreeDir.replace(/\//g, "-").replace(/^-/, "-");
      const projectDir = join(HOME, ".claude/projects", pathSlug);
      if (existsSync(projectDir)) {
        const files = readdirSync(projectDir).filter(f => f.endsWith(".jsonl")).sort().reverse();
        if (files.length > 0) {
          transcriptRef = join(projectDir, files[0]);
        }
      }
    } catch {}

    const checkpoint = {
      timestamp: new Date().toISOString(),
      type: "manual" as const,
      summary,
      git_state: gitState,
      dynamic_hooks: hooks,
      key_facts: (key_facts || []).slice(0, 10),
      transcript_ref: transcriptRef,
    };

    const filepath = _writeCheckpoint(checkpointDir, checkpoint);

    return {
      content: [{
        type: "text" as const,
        text: `Checkpoint saved: ${filepath}\nGit: ${gitState.branch || "?"} @ ${gitState.sha || "?"} (${gitState.dirty_count || 0} dirty, ${gitState.staged_count || 0} staged)\nHooks: ${hooks.length} active\nFacts: ${(key_facts || []).length} saved`,
      }],
    };
  }
);

} // end registerLifecycleTools
