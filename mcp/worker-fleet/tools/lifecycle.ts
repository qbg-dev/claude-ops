/**
 * Lifecycle tools — recycle, save_checkpoint
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { writeFileSync, existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { HOME, PROJECT_ROOT, WORKERS_DIR, WORKER_NAME, getWorktreeDir } from "../config";
import { getWorkerEntry, readRegistry, withRegistryLocked, type RegistryConfig, type RegistryWorkerEntry, getWorkerModel } from "../registry";
import { findOwnPane, getSessionId } from "../tmux";
import { getWorkerRuntime, type ReasoningEffort } from "../runtime";
import { dynamicHooks, _captureHooksSnapshot, _archiveHook, _persistHooks } from "../hooks";
import { _captureGitState, _writeCheckpoint } from "../helpers";
import { generateSeedContent } from "../seed";
import { fleetMailRequest, resolveFleetMailRecipients, getFleetMailToken, FLEET_MAIL_URL } from "../mail-client";

export function registerLifecycleTools(server: McpServer): void {

server.registerTool(
  "recycle",
  { description: `Restart yourself in the same tmux pane to get a fresh context window.

Four modes:
  (1) Default (soft recycle): saves checkpoint + cycle report but does NOT exit. You stay alive and keep working. Use this to mark cycle boundaries without restarting. Context refreshes naturally via pre-compact hook.
  (2) soft=false (cold restart): exits current session, generates a new seed file with the handoff message, and launches a brand-new Claude session.
  (3) resume=true (hot restart): resume same session ID — preserves full conversation history but reloads MCP config.
  (4) Perpetual workers with sleep_seconds: exits session and lets the watchdog respawn after sleep_duration seconds. Use sleep_seconds to override.

When to use which:
  - Finished a task, have more work or mail to handle → recycle() (default soft). Stay alive, log the cycle.
  - Context window getting very long (compacted 2+ times) → recycle(soft=false). Cold restart, handoff carries state.
  - MCP config or .mcp.json changed → recycle(resume=true). Keeps conversation, reloads MCP.
  - No more work AND no pending mail → recycle(soft=false). Let watchdog handle respawn timer.
  - Stuck or corrupted state → recycle(soft=false) with minimal handoff.

Blocked by pending dynamic hooks unless force=true.`, inputSchema: {
    message: z.string().optional().describe("Handoff context for the next instance. Include: what was accomplished, what remains, any blockers or decisions needed. Written to handoff.md and injected into the next session's seed"),
    resume: z.boolean().optional().describe("If true, hot-restart: resume the same session (keeps conversation history, reloads MCP/model config). If false (default), cold-restart with a fresh seed"),
    force: z.boolean().optional().describe("If true, bypass the stop-check gate. Use only when pending checks are genuinely not applicable to the current cycle"),
    sleep_seconds: z.number().optional().describe("Override sleep_duration for this recycle only. The watchdog will respawn after this many seconds. 0 = immediate restart (no sleep). Only applies to perpetual workers"),
    cancel: z.boolean().optional().describe("If true, cancel a pending sleep timer (clears status=sleeping). Use when you realize you have more work and don't need to restart yet"),
    soft: z.boolean().optional().describe("Soft recycle (DEFAULT): save checkpoint, send cycle report, log the cycle — but do NOT exit Claude or kill the pane. You stay alive and keep working. Set soft=false to force a cold restart instead"),
  } },
  async ({ message, resume, force, sleep_seconds, cancel, soft: softParam }) => {
    // Default soft=true unless explicitly set to false, or resume/sleep_seconds are specified
    const soft = softParam ?? (resume || sleep_seconds !== undefined ? false : true);

    // 0a. Cancel mode — abort a pending sleep timer
    if (cancel) {
      withRegistryLocked((registry) => {
        const w = registry[WORKER_NAME] as RegistryWorkerEntry;
        if (w && w.status === "sleeping") {
          w.status = "active";
          if (w.custom) w.custom.sleep_until = null;
        }
      });
      return { content: [{ type: "text" as const, text: "Sleep timer cancelled. Status restored to active." }] };
    }

    // 0-soft. Soft recycle — save state + report cycle, but stay alive
    if (soft) {
      // Save checkpoint
      try {
        const checkpointDir = join(WORKERS_DIR, WORKER_NAME, "checkpoints");
        const gitState = _captureGitState();
        const hooks = _captureHooksSnapshot();
        _writeCheckpoint(checkpointDir, {
          timestamp: new Date().toISOString(),
          type: "soft-recycle" as const,
          summary: message || "Soft recycle — cycle boundary",
          git_state: gitState,
          dynamic_hooks: hooks,
          key_facts: [] as string[],
          transcript_ref: "",
        });
      } catch {}

      // Update registry cycle marker
      withRegistryLocked((registry) => {
        const w = registry[WORKER_NAME] as RegistryWorkerEntry;
        if (w) {
          w.custom = w.custom || {};
          w.custom.last_recycle_at = new Date().toISOString();
          w.custom.last_recycle_reason = "soft";
        }
      });

      // Write handoff.md (for seed re-injection on next hard recycle or pre-compact)
      if (message) {
        try {
          const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
          writeFileSync(handoffPath, message.trim() + "\n");
        } catch {}
      }

      // Notify mission_authority (best-effort, same as full recycle)
      try {
        const registry = readRegistry();
        const config = registry._config as RegistryConfig;
        const cycleReport = message
          ? `[${WORKER_NAME}] Soft cycle complete: ${message}`
          : `[${WORKER_NAME}] Soft cycle complete (no summary)`;
        const maList = config?.mission_authority;
        const operatorNames: string[] = !maList ? [] : Array.isArray(maList) ? maList : [maList];
        const filteredOps = operatorNames.filter(n => n !== WORKER_NAME);
        if (filteredOps.length > 0) {
          getFleetMailToken().then(async () => {
            const toIds = await resolveFleetMailRecipients(filteredOps);
            await fleetMailRequest("POST", "/api/messages/send", {
              to: toIds, subject: `${WORKER_NAME} soft cycle done`,
              body: cycleReport, cc: [], thread_id: null, in_reply_to: null,
              reply_by: null, labels: ["CYCLE-REPORT"], attachments: [],
            });
          }).catch(() => {});
        }
      } catch {}

      // Archive cycle-scoped hooks, keep persistent ones
      const archiveIds: string[] = [];
      for (const [id, hook] of dynamicHooks.entries()) {
        if (hook.lifetime !== "persistent") {
          archiveIds.push(id);
        }
      }
      for (const id of archiveIds) {
        _archiveHook(id, "cycle-end");
      }
      // Also archive completed persistent hooks (they did their job)
      for (const [id, hook] of dynamicHooks.entries()) {
        if (hook.completed) {
          _archiveHook(id, "completed");
        }
      }

      // Clean up recycle sentinel for next cycle
      try { rmSync(`/tmp/claude-fleet-recycle-${WORKER_NAME}`); } catch {}

      return {
        content: [{
          type: "text" as const,
          text: `Soft recycle complete — cycle logged, checkpoint saved. You are still alive.\n` +
            `${message ? `Handoff: "${message.slice(0, 100)}${message.length > 100 ? "..." : ""}"` : "No handoff message."}\n` +
            `Archived ${archiveIds.length} cycle-scoped hook(s). Persistent hooks survive. Keep working — check mail_inbox() for new tasks.`,
        }],
      };
    }

    // 0-pre. Create recycle sentinel (so sys-recycle-gate check passes)
    try { writeFileSync(`/tmp/claude-fleet-recycle-${WORKER_NAME}`, new Date().toISOString()); } catch {}

    // 0. Gate on blocking hooks (unified: stop checks + any blocking gates)
    const pendingChecks = [...dynamicHooks.values()].filter(h => h.blocking && !h.completed);
    if (pendingChecks.length > 0 && !force) {
      const checkList = pendingChecks.map(h => `  [${h.id}] ${h.event}/${h.blocking ? "gate" : "inject"} — ${h.description}`).join("\n");
      return {
        content: [{
          type: "text" as const,
          text: `BLOCKED: ${pendingChecks.length} pending hook(s) — complete these before recycling:\n\n${checkList}\n\nUse complete_hook(id) to mark each done, or recycle(force=true) to skip.`,
        }],
        isError: true,
      };
    }

    // 1. Find own pane
    const ownPane = findOwnPane();
    if (!ownPane) {
      return { content: [{ type: "text" as const, text: "Error: Could not find own pane in registry. Are you running in tmux?" }], isError: true };
    }

    // 1b. Check for unread mail (best-effort)
    let pendingWarning = "";
    let hasUnreadMail = false;
    try {
      const mailToken =(getWorkerEntry(WORKER_NAME) as any)?.bms_token;
      if (mailToken) {
        const resp = await fetch(`${FLEET_MAIL_URL}/api/messages?label=UNREAD&maxResults=1`, {
          headers: { Authorization: `Bearer ${mailToken}` },
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          const data = await resp.json() as any;
          const unread = data?._diagnostics?.unread_count || 0;
          if (unread > 0) {
            hasUnreadMail = true;
            pendingWarning = `\n\nWARNING: ${unread} unread mail — call mail_inbox() before recycling.`;
          }
        }
      }
    } catch {}

    // 1c. Idle detection for perpetual workers — sleep instead of full recycle when idle
    const entry0 = getWorkerEntry(WORKER_NAME);
    const isPerpetual0 = (entry0?.sleep_duration ?? null) !== null && (entry0?.sleep_duration ?? 0) > 0;
    if (isPerpetual0 && !hasUnreadMail && !resume) {
      const hasSubstantiveHandoff = message && message.trim().length > 20;
      if (!hasSubstantiveHandoff) {
        // No work to do — go to sleep directly, skip expensive recycle
        const registrySleepDur0 = entry0?.sleep_duration ?? 1800;
        const effectiveSleep0 = sleep_seconds !== undefined ? sleep_seconds : registrySleepDur0;
        if (effectiveSleep0 > 0) {
          const sleepUntil0 = new Date(Date.now() + effectiveSleep0 * 1000).toISOString();

          // Write checkpoint before sleeping
          try {
            const checkpointDir = join(WORKERS_DIR, WORKER_NAME, "checkpoints");
            const gitState = _captureGitState();
            const hooks = _captureHooksSnapshot();
            const checkpoint = {
              timestamp: new Date().toISOString(),
              type: "idle-sleep" as const,
              summary: message || "Idle — no pending work, sleeping",
              git_state: gitState,
              dynamic_hooks: hooks,
              key_facts: [] as string[],
              transcript_ref: "",
            };
            _writeCheckpoint(checkpointDir, checkpoint);
          } catch {}

          withRegistryLocked((registry) => {
            const w = registry[WORKER_NAME] as RegistryWorkerEntry;
            if (w) {
              w.status = "sleeping";
              w.custom = w.custom || {};
              w.custom.sleep_until = sleepUntil0;
              w.custom.last_recycle_at = new Date().toISOString();
              w.custom.last_recycle_reason = "idle";
            }
          });

          // Generate exit-only script
          const rt0 = getWorkerRuntime();
          const recycleScript0 = `/tmp/recycle-${WORKER_NAME}-${Date.now()}.sh`;
          writeFileSync(recycleScript0, `#!/bin/bash
# Auto-generated IDLE SLEEP for ${WORKER_NAME} — no pending work, watchdog will wake on mail or timer
set -uo pipefail
PANE_ID="${ownPane.paneId}"
sleep 5
tmux send-keys -t "$PANE_ID" "${rt0.exitCommand}"
tmux send-keys -t "$PANE_ID" -H 0d
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && break
  AGENT_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *${rt0.binary}* ]] && AGENT_RUNNING=true && break
  done
  [ "$AGENT_RUNNING" = "false" ] && break
done
rm -f "${recycleScript0}"
`);
          try {
            execSync(`nohup bash "${recycleScript0}" > /tmp/recycle-${WORKER_NAME}.log 2>&1 &`, {
              shell: "/bin/bash", timeout: 5000,
            });
          } catch (e: any) {
            return { content: [{ type: "text" as const, text: `Error spawning idle sleep: ${e.message}` }], isError: true };
          }

          const wakeTime0 = new Date(Date.now() + effectiveSleep0 * 1000);
          const wakeStr0 = `${wakeTime0.getHours().toString().padStart(2, "0")}:${wakeTime0.getMinutes().toString().padStart(2, "0")}`;
          return {
            content: [{
              type: "text" as const,
              text: `IDLE SLEEP — no pending work detected. Sleeping for ${effectiveSleep0}s (~${wakeStr0}).\n` +
                `Watchdog will wake early if mail arrives.\n` +
                `Status: sleeping (until ${sleepUntil0})\n` +
                `Do NOT send any more tool calls — /exit will be sent shortly.`,
            }],
          };
        }
      }
    }

    // 2. Get session ID for transcript reference
    const sessionId = getSessionId(ownPane.paneId);
    const worktreeDir = getWorktreeDir();
    const pathSlug = worktreeDir.replace(/\//g, "-").replace(/^-/, "-");
    const transcriptPath = sessionId
      ? join(HOME, ".claude/projects", pathSlug, `${sessionId}.jsonl`)
      : null;

    // 2b. Archive cycle-scoped hooks, keep persistent ones
    for (const [id, hook] of dynamicHooks.entries()) {
      if (hook.lifetime !== "persistent") {
        _archiveHook(id, "cycle-end");
      } else if (hook.completed) {
        _archiveHook(id, "completed");
      }
    }

    // 3. Write checkpoint (replaces handoff.md)
    try {
      const checkpointDir = join(WORKERS_DIR, WORKER_NAME, "checkpoints");
      const gitState = _captureGitState();
      const hooks = _captureHooksSnapshot();
      const checkpoint = {
        timestamp: new Date().toISOString(),
        type: "recycle" as const,
        summary: message || "Recycle without summary",
        git_state: gitState,
        dynamic_hooks: hooks,
        key_facts: [] as string[],
        transcript_ref: transcriptPath || "",
      };
      _writeCheckpoint(checkpointDir, checkpoint);

      // Legacy compat: also write handoff.md for any tools that still read it
      const handoffPath = join(WORKERS_DIR, WORKER_NAME, "handoff.md");
      if (message) {
        let handoffContent = message;
        if (transcriptPath) {
          handoffContent += `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`;
        }
        writeFileSync(handoffPath, handoffContent.trim() + "\n");
      }
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error writing checkpoint: ${e.message}` }], isError: true };
    }

    // 4. Notify parent/operator of cycle completion
    try {
      const registry = readRegistry();
      const config = registry._config as RegistryConfig;
      // Build cycle report
      const cycleReport = message
        ? `[${WORKER_NAME}] Cycle complete: ${message}`
        : `[${WORKER_NAME}] Cycle complete (no summary provided)`;

      // Notify mission_authority via Fleet Mail (best-effort)
      const maList = config?.mission_authority;
      const operatorNames: string[] = !maList ? [] : Array.isArray(maList) ? maList : [maList];
      const filteredOps = operatorNames.filter(n => n !== WORKER_NAME);
      if (filteredOps.length > 0) {
        getFleetMailToken().then(async () => {
          const toIds = await resolveFleetMailRecipients(filteredOps);
          await fleetMailRequest("POST", "/api/messages/send", {
            to: toIds, subject: `${WORKER_NAME} cycle done`,
            body: cycleReport, cc: [], thread_id: null, in_reply_to: null,
            reply_by: null, labels: ["CYCLE-REPORT"], attachments: [],
          });
        }).catch(() => {});
      }
    } catch {
      // Best-effort notification — don't block recycle if it fails
    }

    // 4b. Resume mode — hot-restart, same session, no seed
    if (resume) {
      const sessionId = getSessionId(ownPane.paneId);
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "Error: Could not detect session ID — cannot resume." }], isError: true };
      }
      const model = getWorkerModel();
      const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
      const worktreeDir = getWorktreeDir();
      const rt = getWorkerRuntime();
      const resumeCmd = rt.buildResumeCmd({ model, permissionMode: "bypassPermissions", workerDir, sessionId });

      // Write resume command to temp file to avoid shell quoting issues
      const resumeCmdFile = `/tmp/resume-cmd-${WORKER_NAME}-${Date.now()}.txt`;
      writeFileSync(resumeCmdFile, `echo 'Continue from where you left off.' | ${resumeCmd}`);

      const reloadScript = `/tmp/reload-${WORKER_NAME}-${Date.now()}.sh`;
      writeFileSync(reloadScript, `#!/bin/bash
set -uo pipefail
PANE_ID="${ownPane.paneId}"
RESUME_CMD_FILE="${resumeCmdFile}"
sleep 3
tmux send-keys -t "$PANE_ID" "${rt.exitCommand}"
tmux send-keys -t "$PANE_ID" -H 0d
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && { echo "FATAL: pane gone"; exit 1; }
  AGENT_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *${rt.binary}* ]] && AGENT_RUNNING=true && break
  done
  [ "$AGENT_RUNNING" = "false" ] && break
done
sleep 2
tmux send-keys -t "$PANE_ID" "cd ${worktreeDir}"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 1
# Use load-buffer to avoid shell quoting issues with resume command
tmux load-buffer -b "resume-$$" "$RESUME_CMD_FILE"
tmux paste-buffer -b "resume-$$" -t "$PANE_ID" -d
tmux send-keys -t "$PANE_ID" -H 0d
rm -f "${reloadScript}" "$RESUME_CMD_FILE"
`);

      execSync(`nohup bash "${reloadScript}" > /dev/null 2>&1 &`, { shell: "/bin/bash", timeout: 5000 });

      return {
        content: [{
          type: "text" as const,
          text: `Hot-restarting — /exit in ~3s, then session ${sessionId} resumes.\nModel: ${model}\nDo NOT send any more tool calls — /exit is imminent.` + pendingWarning,
        }],
      };
    }

    // 5. Get config
    const model = getWorkerModel();
    const workerDir = join(PROJECT_ROOT, ".claude/workers", WORKER_NAME);
    const rt = getWorkerRuntime();

    // 6. Check if this is a perpetual worker that should defer to watchdog
    const entry = getWorkerEntry(WORKER_NAME);
    const isPerpetual = entry?.sleep_duration !== null && entry?.sleep_duration !== undefined && entry.sleep_duration > 0;
    const registrySleepDur = entry?.sleep_duration ?? 1800;
    // sleep_seconds param overrides registry sleep_duration for this cycle
    // sleep_seconds=0 means "immediate restart, no sleep"
    const effectiveSleep = sleep_seconds !== undefined ? sleep_seconds : registrySleepDur;
    const shouldDeferToWatchdog = isPerpetual && effectiveSleep > 0;

    if (shouldDeferToWatchdog) {
      // ── Deferred recycle: kill session, let watchdog respawn after sleep ──
      const sleepUntil = new Date(Date.now() + effectiveSleep * 1000).toISOString();

      // Set status=sleeping and sleep_until in registry
      withRegistryLocked((registry) => {
        const w = registry[WORKER_NAME] as RegistryWorkerEntry;
        if (w) {
          w.status = "sleeping";
          w.custom = w.custom || {};
          w.custom.sleep_until = sleepUntil;
          w.custom.last_recycle_at = new Date().toISOString();
        }
      });

      // Generate exit-only script (no relaunch — watchdog handles that)
      const recycleScript = `/tmp/recycle-${WORKER_NAME}-${Date.now()}.sh`;
      writeFileSync(recycleScript, `#!/bin/bash
# Auto-generated SLEEP recycle for ${WORKER_NAME} — watchdog will respawn after ${effectiveSleep}s
set -uo pipefail
PANE_ID="${ownPane.paneId}"
sleep 5
tmux send-keys -t "$PANE_ID" "${rt.exitCommand}"
tmux send-keys -t "$PANE_ID" -H 0d
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && break
  AGENT_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *${rt.binary}* ]] && AGENT_RUNNING=true && break
  done
  [ "$AGENT_RUNNING" = "false" ] && break
done
rm -f "${recycleScript}"
`);

      try {
        execSync(`nohup bash "${recycleScript}" > /tmp/recycle-${WORKER_NAME}.log 2>&1 &`, {
          shell: "/bin/bash", timeout: 5000,
        });
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error spawning recycle: ${e.message}` }], isError: true };
      }

      const wakeTime = new Date(Date.now() + effectiveSleep * 1000);
      const wakeStr = `${wakeTime.getHours().toString().padStart(2, "0")}:${wakeTime.getMinutes().toString().padStart(2, "0")}`;
      return {
        content: [{
          type: "text" as const,
          text: `Recycling initiated. Watchdog will respawn in ${effectiveSleep}s (~${wakeStr}).\n` +
            `Checkpoint: ${message ? "saved to checkpoints/" : "none"}\n` +
            `Transcript: ${transcriptPath || "unknown"}\n` +
            `Status: sleeping (until ${sleepUntil})\n` +
            `Do NOT send any more tool calls — /exit will be sent shortly.` +
            pendingWarning,
        }],
      };
    }

    // ── Immediate recycle (non-perpetual or sleep_seconds=0) ──

    // 7. Generate seed file (includes handoff + transcript path)
    const seedHandoff = message || "";
    const seedTranscript = transcriptPath
      ? `\n\nIf you need specific details from before compaction (like exact code snippets, error messages, or content you generated), read the full transcript at: ${transcriptPath}`
      : "";
    const seedContent = generateSeedContent((seedHandoff + seedTranscript).trim() || undefined);
    const seedFile = `/tmp/worker-${WORKER_NAME}-seed.txt`;
    writeFileSync(seedFile, seedContent);

    // 8. Create recycle script
    // Key fix: use /exit via tmux instead of kill — keeps pane alive
    const recycleScript = `/tmp/recycle-${WORKER_NAME}-${Date.now()}.sh`;
    const permMode = entry?.permission_mode || "bypassPermissions";
    const disallowed = Array.isArray(entry?.disallowed_tools) ? entry!.disallowed_tools.join(",") : "";
    const effort = entry?.custom?.reasoning_effort as ReasoningEffort | undefined;
    const agentLaunchCmd = rt.buildLaunchCmd({ model, permissionMode: permMode, disallowedTools: disallowed || undefined, workerDir, reasoningEffort: effort });
    const tuiPatternStr = rt.tuiReadyPattern.source;

    // Write launch command to a separate file to avoid shell quoting issues.
    // The command contains --disallowed-tools "Bash(git merge*),..." which has
    // nested double-quotes and parentheses that break bash if interpolated inline.
    const launchCmdFile = `/tmp/launch-cmd-${WORKER_NAME}-${Date.now()}.txt`;
    writeFileSync(launchCmdFile, agentLaunchCmd);

    writeFileSync(recycleScript, `#!/bin/bash
# Auto-generated recycle script for ${WORKER_NAME} (runtime: ${rt.type})
set -uo pipefail
PANE_ID="${ownPane.paneId}"
PANE_TARGET="${ownPane.paneTarget}"
SEED_FILE="${seedFile}"
LAUNCH_CMD_FILE="${launchCmdFile}"

# Wait for MCP tool response to propagate to TUI
sleep 5

# Send exit command (graceful — keeps pane alive with shell prompt)
tmux send-keys -t "$PANE_ID" "${rt.exitCommand}"
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for agent to exit and shell prompt to return (max 30s)
WAIT=0
while [ "$WAIT" -lt 30 ]; do
  sleep 2; WAIT=$((WAIT+2))
  PANE_PID=$(tmux list-panes -a -F '#{pane_id} #{pane_pid}' 2>/dev/null | awk -v id="$PANE_ID" '$1 == id {print $2}')
  [ -z "$PANE_PID" ] && { echo "FATAL: pane $PANE_ID gone"; exit 1; }
  AGENT_RUNNING=false
  for pid in $(pgrep -P "$PANE_PID" 2>/dev/null); do
    cmd=$(ps -o command= -p "$pid" 2>/dev/null || true)
    [[ "$cmd" == *${rt.binary}* ]] && AGENT_RUNNING=true && break
  done
  [ "$AGENT_RUNNING" = "false" ] && break
done

# Small delay for shell prompt to stabilize
sleep 2

# Change to worktree directory
tmux send-keys -t "$PANE_ID" "cd ${worktreeDir}"
tmux send-keys -t "$PANE_ID" -H 0d
sleep 1

# Launch agent via tmux buffer (avoids shell quoting issues with parens in --disallowed-tools)
LAUNCH_BUFFER="launch-${WORKER_NAME}-$$"
tmux load-buffer -b "$LAUNCH_BUFFER" "$LAUNCH_CMD_FILE"
tmux paste-buffer -b "$LAUNCH_BUFFER" -t "$PANE_ID" -d
sleep 1
tmux send-keys -t "$PANE_ID" -H 0d

# Wait for TUI ready (poll for statusline, max 90s)
WAIT=0
until tmux capture-pane -t "$PANE_ID" -p 2>/dev/null | grep -qE "${tuiPatternStr}"; do
  sleep 3; WAIT=$((WAIT+3))
  [ "$WAIT" -ge 90 ] && break
done
sleep 3

# Inject seed using a named buffer (prevents race conditions when multiple workers recycle concurrently)
BUFFER_NAME="recycle-${WORKER_NAME}-$$"
tmux load-buffer -b "$BUFFER_NAME" "$SEED_FILE"
tmux paste-buffer -b "$BUFFER_NAME" -t "$PANE_ID" -d
sleep 2
tmux send-keys -t "$PANE_ID" -H 0d

# Cleanup
rm -f "${recycleScript}" "$LAUNCH_CMD_FILE"
`);

    // 9. Spawn recycle script in background (detached)
    try {
      execSync(`nohup bash "${recycleScript}" > /tmp/recycle-${WORKER_NAME}.log 2>&1 &`, {
        shell: "/bin/bash", timeout: 5000,
      });
    } catch (e: any) {
      return { content: [{ type: "text" as const, text: `Error spawning recycle: ${e.message}` }], isError: true };
    }

    return {
      content: [{
        type: "text" as const,
        text: `Recycling initiated. You will be restarted in ~10 seconds.\n` +
          `Checkpoint: ${message ? "saved to checkpoints/" : "none"}\n` +
          `Transcript: ${transcriptPath || "unknown"}\n` +
          `Seed: ${seedFile}\n` +
          `Do NOT send any more tool calls — /exit will be sent shortly.` +
          pendingWarning,
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
    description: "Save a checkpoint of your current working state. Automatically captures git state and dynamic hooks. Use before complex operations, when context is getting long, or to preserve state across recycles. Checkpoints are auto-saved before context compaction and on recycle.",
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
