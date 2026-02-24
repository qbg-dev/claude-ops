# Hook Templates

## Hook Protocol

Hooks receive JSON on stdin, control behavior via exit code + stdout.

**Input** (all types): `{"session_id": "uuid", "cwd": "/path/to/project"}`
PostToolUse adds: `tool_name`, `tool_input`, `tool_use_id`, `transcript_path`.

**Output:**
- Exit 0, no stdout = **allow**
- Exit 0, `{"decision": "block", "reason": "..."}` = **block** (reason injected as user message)
- Exit non-zero = error (logged, doesn't block)

**JSON output alternatives:**
- `jq -n --arg r "$MSG" '{"decision":"block","reason":$r}'` — standard, but breaks on multiline strings with unescaped characters
- `python3 -c "import json,sys; print(json.dumps({'decision':'block','reason':sys.argv[1]}))" "$MSG"` — handles any string safely, used in harness-dispatch.sh for complex block messages with newlines

## Hook Types

| Type | Fires when | Supports block? |
|---|---|---|
| `UserPromptSubmit` | User sends a prompt | Yes |
| `PostToolUse` | After a tool call completes | Yes |
| `Stop` | Claude is about to stop responding | Yes |
| `PreCompact` | Before context compaction | Yes (output injected as context) |
| `SubagentStart` | Task tool spawns a subagent | No (logging only) |
| `SubagentStop` | Subagent completes | No (logging only) |

## Best Practices

1. **Fast and side-effect-safe.** No network calls. Read/write local files only. Fail open. Target <2s.
2. **State in /tmp/ with session isolation.** Always suffix with `$SESSION_ID`. Clean stale flags: `find /tmp -name "claude_myhook_*" -mmin +120 -delete`.
3. **Stop hooks: choose your mode.** Two-phase (standard advisory) or Infinite (HDD overnight).
4. **Gate on significance.** Don't fire on trivial sessions. Exception: infinite stop hooks fire every time by design.
5. **Multiple stop hooks fire simultaneously.** Design for independence.
6. **Defer to echo chains.** Check for `/tmp/claude_echo_state_${SESSION_ID}` and skip if active.
7. **PostToolUse matcher** filters which tools trigger: `"matcher": "Bash|Write|Edit"`.

## Registration

```json
{
  "hooks": {
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "bash ~/.claude-ops/hooks/admission/baseline-init.sh"}]}],
    "PostToolUse": [{"matcher": "Write|Edit|NotebookEdit", "hooks": [{"type": "command", "command": "bash ~/.claude-ops/hooks/operators/write-flag.sh"}]}],
    "Stop": [{"hooks": [{"type": "command", "command": "bash ~/.claude-ops/hooks/harness-dispatch.sh"}]}]
  }
}
```

Global: `~/.claude/settings.json`. Project: `{project}/.claude/settings.local.json`.

---

## Infinite Stop Hook (with idle exploration branch)

Always blocks. When tasks remain: shows progress. When tasks run out: pushes Claude to explore toward the mission. Only exits via escape hatch.

```bash
#!/bin/bash
set -euo pipefail
source ~/.claude-ops/lib/harness-jq.sh
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
[ -z "$SESSION_ID" ] && exit 0

# Escape hatch — persists until user removes it
[ -f "/tmp/claude_allow_stop_${SESSION_ID}" ] && exit 0

# Skip if echo chain active
[ -f "/tmp/claude_echo_state_${SESSION_ID}" ] && exit 0

# Read progress file for context
PROGRESS="{project}/claude_files/{name}-progress.json"
MSG="## Keep working toward the mission.\n\n"

if [ -f "$PROGRESS" ]; then
  CURRENT=$(harness_current_task "$PROGRESS")
  NEXT=$(harness_next_task "$PROGRESS")
  COMPLETED=$(harness_completed_names "$PROGRESS")
  MISSION=$(jq -r '.mission // "Read CLAUDE.md"' "$PROGRESS")

  if [ "$NEXT" = "IDLE" ] && [ "$CURRENT" = "none" -o "$CURRENT" = "null" ]; then
    # === IDLE MODE: all tasks done — push toward exploration ===
    MSG="${MSG}All listed tasks complete: [${COMPLETED}]\n\n"
    MSG="${MSG}**Mission:** ${MISSION}\n\n"
    MSG="${MSG}**The task list was a starting point, not the finish line.**\n"
    MSG="${MSG}Spawn Explore agents to find more work:\n"
    MSG="${MSG}- Read legacy code for features not yet migrated\n"
    MSG="${MSG}- Look for integration gaps between completed tasks\n"
    MSG="${MSG}- Polish UX (loading states, error handling, transitions)\n"
    MSG="${MSG}- Add discovered tasks to progress.json and build them\n"
    MSG="${MSG}\nOnly stop when you've genuinely exhausted all avenues.\n"
  else
    # === ACTIVE MODE: tasks remain ===
    MSG="${MSG}**Current:** ${CURRENT}\n"
    MSG="${MSG}**Next:** ${NEXT}\n"
    MSG="${MSG}**Done:** [${COMPLETED:-none yet}]\n\n"
    MSG="${MSG}Finish current task. Commit. Update progress. Start next.\n"
  fi
else
  MSG="${MSG}Read CLAUDE.md for the mission and progress file location.\n"
fi

MSG="${MSG}\nEscape: touch /tmp/claude_allow_stop_${SESSION_ID}"
jq -n --arg r "$(echo -e "$MSG")" '{"decision":"block","reason":$r}'
```

---

## Two-Phase Stop Hook (Standard)

Phase 1 blocks + sets flag, Phase 2 sees flag + allows. Safe for advisory use.

```bash
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
[ -z "$SESSION_ID" ] && exit 0

find /tmp -name "claude_myhook_asked_*" -mmin +120 -delete 2>/dev/null
ASKED_FLAG="/tmp/claude_myhook_asked_${SESSION_ID}"

# --- Phase 2: Already asked -> always allow ---
if [ -f "$ASKED_FLAG" ]; then
  rm -f "$ASKED_FLAG"
  exit 0
fi

# --- Phase 1: Evaluate ---
[ -f "/tmp/claude_echo_state_${SESSION_ID}" ] && exit 0

# Your significance check here
# If nothing worth blocking -> exit 0

touch "$ASKED_FLAG"
jq -n --arg reason "Your block message" '{"decision": "block", "reason": $reason}'
exit 0
```

---

## Safety Guard (PostToolUse)

Blocks dangerous Bash commands at enforcement level.

```bash
#!/bin/bash
# safety-guard.sh — PostToolUse hook
INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // ""')
[ "$TOOL" != "Bash" ] && exit 0

CMD=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Block outbound communications
if echo "$CMD" | grep -qiE 'nexus.*send|whatsapp|gmail.*send|discord.*message|resend.*api|bun run scripts/whatsapp'; then
  jq -n --arg r "SAFETY: Outbound communication blocked." '{"decision":"block","reason":$r}'
  exit 0
fi

# Block destructive git
if echo "$CMD" | grep -qiE 'git (push --force|reset --hard|branch -D|clean -f)'; then
  jq -n --arg r "SAFETY: Destructive git command blocked." '{"decision":"block","reason":$r}'
  exit 0
fi

# Block production access
if echo "$CMD" | grep -qiE 'deploy-prod|ssh.*120\.77|ssh.*prod'; then
  jq -n --arg r "SAFETY: Production access blocked." '{"decision":"block","reason":$r}'
  exit 0
fi

# Block data destruction
if echo "$CMD" | grep -qiE 'rm -rf|DROP TABLE|TRUNCATE|DELETE FROM.*WHERE 1'; then
  jq -n --arg r "SAFETY: Destructive data command blocked." '{"decision":"block","reason":$r}'
  exit 0
fi

exit 0
```

Register: `"PostToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "bash .claude/hooks/safety-guard.sh"}]}]`

---

## Baseline Init (UserPromptSubmit)

Snapshots git dirty state once per session.

```bash
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
[ -z "$SESSION_ID" ] && exit 0

BASELINE="/tmp/claude_baseline_${SESSION_ID}"
[ -f "$BASELINE" ] && exit 0  # Already captured

cd "$CWD" 2>/dev/null || exit 0
{
  git diff --name-only HEAD 2>/dev/null
  git diff --cached --name-only 2>/dev/null
  git ls-files --others --exclude-standard 2>/dev/null
} | sort -u > "$BASELINE"

find /tmp -name "claude_baseline_*" -mmin +120 -delete 2>/dev/null
exit 0
```

---

## Write Flag (PostToolUse)

Sets flag when Claude writes/edits files.

```bash
#!/bin/bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
[ -z "$SESSION_ID" ] && exit 0
touch "/tmp/claude_wrote_${SESSION_ID}"
exit 0
```

---

## Context Inject (UserPromptSubmit)

Injects compact harness progress context on the first prompt of a session. Uses a flag file guard (not `once: true`) so it works across continued sessions.

```bash
#!/bin/bash
# harness-inject.sh — Injects compact harness context on first prompt.
# Uses flag file guard (not once: true) so it works across continued sessions.
source ~/.claude-ops/lib/harness-jq.sh
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
[ -z "$SESSION_ID" ] && exit 0

FLAG="/tmp/claude_injected_${SESSION_ID}"
[ -f "$FLAG" ] && exit 0
touch "$FLAG"
find /tmp -name "claude_injected_*" -mmin +120 -delete 2>/dev/null || true

PROGRESS="{project}/claude_files/{name}-progress.json"
[ ! -f "$PROGRESS" ] && exit 0

STATUS=$(jq -r '.status // "inactive"' "$PROGRESS")
[ "$STATUS" != "active" ] && exit 0

CURRENT=$(harness_current_task "$PROGRESS")
STEP=$(jq -r ".tasks[\"$CURRENT\"].completed_steps | length // 0" "$PROGRESS" 2>/dev/null || echo 0)
COMPLETED=$(harness_done_count "$PROGRESS")
TOTAL=$(harness_total_count "$PROGRESS")

# Output as plain text — Claude sees this as context
cat <<CTX
[Harness: {name}] ${COMPLETED}/${TOTAL} tasks done. Current: ${CURRENT} (step ${STEP}).
Read claude_files/{name}-progress.json for full state.
CTX
```

Register: `"UserPromptSubmit": [{"hooks": [{"type": "command", "command": "bash .claude/hooks/harness-inject.sh"}]}]`

---

## Debugging

### Debug Logging

Add temporary logging to any hook:
```bash
DEBUG="/tmp/harness_hook_debug.log"
echo "$(date) — hook invoked" >> "$DEBUG"
INPUT=$(cat)
echo "$(date) — stdin: $INPUT" >> "$DEBUG"
```
Then check: `cat /tmp/harness_hook_debug.log`

### Quick Commands

```bash
bash -n ~/.claude/hooks/my-hook.sh                              # Syntax check
echo '{"session_id":"test","cwd":"/path"}' | bash my-hook.sh    # Dry run
ls /tmp/claude_*                                                 # Active state files
find /tmp -name "claude_*" -mmin +120 -delete                   # Clean up
```

### Common Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| Hook never fires | Not registered in `settings.local.json` | Check `.claude/settings.local.json` hook arrays |
| Hook fires but no context injected | Wrong output format | UserPromptSubmit: plain text to stdout. Stop: JSON `{"decision":"block","reason":"..."}` |
| Hook fires once then stops | `once: true` consumed the firing | Use flag file pattern instead (see below) |
| Hook works in bash but not in Claude Code | `set -euo pipefail` + missing var or failed command | Add debug logging to find the failing line |
| Hook causes lag | Too much stdout (catting large files) | Keep output compact, point to files instead |
| Hook doesn't fire in continued sessions | `once: true` persists across session continuations | Replace with per-session flag file |

### The Flag File Pattern (replaces `once: true`)

`once: true` in settings is unreliable across continued sessions. Use a `/tmp` flag file instead:

```bash
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
[ -z "$SESSION_ID" ] && exit 0

FLAG="/tmp/claude_myhook_${SESSION_ID}"
[ -f "$FLAG" ] && exit 0  # Already fired this session
touch "$FLAG"
# Clean stale flags
find /tmp -name "claude_myhook_*" -mmin +120 -delete 2>/dev/null || true
```

This is the same pattern `baseline-init.sh` uses. Session IDs are UUIDs, so flags are per-session and don't collide.

### Testing Hooks

```bash
# Simulate what Claude Code sends to a hook:
echo '{"session_id":"test-123","prompt":"hello","cwd":"/path/to/project"}' | bash .claude/hooks/my-hook.sh

# Test from a real Claude CLI instance (can't nest, must unset env):
CLAUDECODE= claude -p "test prompt"
# Then check: cat /tmp/harness_hook_debug.log
```

### Performance

Keep UserPromptSubmit hook output **small** (5-10 lines). Large output (catting a 200-line file) causes visible lag on every session start. Output a compact summary and point Claude to `Read` the full file instead.

### Hook Stdin Format (UserPromptSubmit)

Claude Code passes JSON on stdin:
```json
{
  "session_id": "uuid",
  "transcript_path": "/Users/.../.claude/projects/.../uuid.jsonl",
  "cwd": "/path/to/project",
  "permission_mode": "default",
  "hook_event_name": "UserPromptSubmit",
  "prompt": "the user's message"
}
```

### Hook Output Formats

| Hook Type | Output Format | Where it goes |
|-----------|--------------|---------------|
| UserPromptSubmit | **Plain text to stdout** | Added as context Claude can see and act on |
| Stop | `{"decision":"block","reason":"..."}` or `{}` | Block/allow stop, reason shown to Claude |
| PostToolUse | `{}` (passthrough) or block JSON | Block/allow tool execution |

## Swarm-Aware Hooks

Swarm mode (TeamCreate + worker agents) changes how hooks interact with the harness. Key principle: **hooks fire on the lead agent only** — workers spawned via Task tool are subagents with their own lifecycle, not separate Claude Code sessions.

### Stop Hook in Swarm Mode

The infinite stop hook blocks the *lead agent* from stopping. Workers don't need stop hooks — they run until their Task completes. The lead's stop hook should include team state:

```bash
# Add to the infinite stop hook's ACTIVE MODE block, after showing current/next/done:
MODE=$(jq -r '.state.mode // "solo"' "$PROGRESS")
if [ "$MODE" = "swarm" ]; then
  WORKERS=$(jq -r '.state.active_workers // [] | length' "$PROGRESS")
  PENDING_MERGES=$(jq -r '.state.pending_merges // [] | length' "$PROGRESS")
  MSG="${MSG}\n**Swarm:** ${WORKERS} active workers"
  [ "$PENDING_MERGES" -gt 0 ] && MSG="${MSG}, ${PENDING_MERGES} pending merges"
  MSG="${MSG}\nMonitor workers via TaskList. Sync completions to progress.json.\n"
fi
```

### Context Inject in Swarm Mode

The `harness-inject.sh` UserPromptSubmit hook should include team status for the lead:

```bash
# Add after the standard task progress output:
MODE=$(jq -r '.state.mode // "solo"' "$PROGRESS")
if [ "$MODE" = "swarm" ]; then
  TEAM=$(jq -r '.state.team_name // ""' "$PROGRESS")
  WORKERS=$(jq -r '.state.active_workers // [] | join(", ")' "$PROGRESS")
  echo "Team: ${TEAM} | Workers: [${WORKERS}]"
  echo "Check TaskList for worker status. Sync completions to progress.json."
fi
```

### SubagentStart/Stop Hooks (worker lifecycle)

Track worker spawn and completion for swarm coordination. These hooks cannot block — they're logging-only.

```bash
#!/bin/bash
# swarm-lifecycle.sh — SubagentStop hook
# When a worker finishes, log it for the lead to process
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
[ -z "$SESSION_ID" ] && exit 0

AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // ""')
[ -z "$AGENT_NAME" ] && exit 0

# Signal to lead that a worker completed
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $AGENT_NAME completed" >> "/tmp/claude_swarm_events_${SESSION_ID}"
exit 0
```

Register:
```json
{
  "SubagentStop": [{"hooks": [{"type": "command", "command": "bash .claude/hooks/swarm-lifecycle.sh"}]}]
}
```

### Rotation + Swarm

The rotation system **must TeamDelete before rotating**. Add this check to `harness-dispatch.sh`'s `check_rotation()`:

```bash
# Before triggering rotation, check for active swarm
MODE=$(jq -r '.state.mode // "solo"' "$PROGRESS")
if [ "$MODE" = "swarm" ]; then
  # Signal lead to shut down team before rotation
  # The lead agent handles TeamDelete + shutdown_request in response
  MSG="${MSG}\n\n⚠️ **ROTATION IMMINENT.** Shut down your team first:\n"
  MSG="${MSG}1. Send shutdown_request to all workers\n"
  MSG="${MSG}2. Wait for responses\n"
  MSG="${MSG}3. Sync all progress to progress.json\n"
  MSG="${MSG}4. Call TeamDelete\n"
  MSG="${MSG}5. Then allow the rotation to proceed\n"
fi
```

### Archetype × Swarm Matrix

Each harness archetype maps to swarm differently:

| Archetype | Swarm pattern | Worker count | Isolation |
|-----------|--------------|--------------|-----------|
| **List-driven** | Workers claim tasks from queue, lead assigns | 2-4 (scales with task count) | `worktree` if tasks touch different files |
| **Exploration-first** | Workers explore different areas, report findings to lead who creates tasks | 2-3 explorers → lead queues tasks → workers build | Shared repo (explorers read-only), `worktree` for builders |
| **Deadline-driven** | Lead triages priorities, workers take top-N in parallel | 2-3 (less overhead for tight deadlines) | `worktree` (speed over coordination) |

**List-driven + swarm** is the sweet spot — tasks are well-defined, workers are independent, lead just monitors and syncs.

**Exploration-first + swarm** has two phases: (1) explore phase with Explore-type subagents gathering info, (2) build phase with general-purpose workers executing discovered tasks.

**Deadline-driven + swarm** benefits from parallelism but needs tighter lead control — the lead should reassign workers when priorities shift.

---

## PreCompact Hook Template

The PreCompact hook fires before Claude compacts context. It has **two layers**: universal checks (all sessions) and harness-specific reminders (registered sessions only).

```bash
#!/usr/bin/env bash
# pre-compact-evolve.sh — PreCompact hook
set -euo pipefail

PROJECT_ROOT="/path/to/project"
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null
REGISTRY="$HARNESS_SESSION_REGISTRY"

INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)
[ -z "$SESSION_ID" ] && exit 0

# ── Universal checks (all sessions) ────────────────────────────────

# 1. Uncommitted work guard
DIRTY=$(git -C "$PROJECT_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')
[ "$DIRTY" -gt 0 ] && echo "WARNING: $DIRTY uncommitted file(s). Commit or stash before context is lost."

# ── Harness-specific (registered sessions only) ────────────────────

HARNESS=""
[ -f "$REGISTRY" ] && HARNESS=$(jq -r --arg sid "$SESSION_ID" '.[$sid] // empty' "$REGISTRY" 2>/dev/null || true)

if [ -n "$HARNESS" ]; then
  PROGRESS_FILE="$PROJECT_ROOT/claude_files/${HARNESS}-progress.json"
  [ -f "$PROGRESS_FILE" ] && cat <<EOF
Before compaction: review your progress on the ${HARNESS} harness.
1. **Journal** — Append round entry to claude_files/${HARNESS}-journal.md
2. **Progress** — Update completed_steps, learnings, new tasks in progress.json
3. **Data gaps** — Update claude_files/${HARNESS}-data-gaps.md if applicable
EOF
fi

# ── Context preservation (all sessions) ────────────────────────────

cat <<EOF
4. **Decision log** — Write key decisions to /tmp/claude_decisions_${SESSION_ID}.md
5. **Draft preservation** — Save any in-progress drafts to /tmp/claude_drafts_${SESSION_ID}/
6. **Active file bookmark** — Record current files + next step to /tmp/claude_bookmark_${SESSION_ID}

Do ALL of this NOW before context is lost.
EOF
```

Register in `settings.local.json`:
```json
"PreCompact": [{
  "matcher": "",
  "hooks": [{"type": "command", "command": "bash .claude/hooks/pre-compact-evolve.sh"}]
}]
```

### Six preservation layers

| # | Layer | Scope | Where |
|---|-------|-------|-------|
| 1 | Uncommitted work guard | All sessions | git status warning |
| 2 | Journal entry | Harness only | `claude_files/{name}-journal.md` |
| 3 | Progress update | Harness only | `claude_files/{name}-progress.json` |
| 4 | Decision log | All sessions | `/tmp/claude_decisions_{session_id}.md` |
| 5 | Draft preservation | All sessions | `/tmp/claude_drafts_{session_id}/` |
| 6 | Active file bookmark | All sessions | `/tmp/claude_bookmark_{session_id}` |

**When to use:** Register for every project. The universal layers (1, 4-6) help even non-harness sessions. The harness layers (2-3) only fire for registered sessions.

---

## Monitor Agent — `--pane` Option

The monitor agent (`~/.claude-ops/scripts/monitor-agent.sh`) supports reusing an existing tmux pane instead of creating a new one:

```bash
# Default: creates a new split pane below the target
bash ~/.claude-ops/scripts/monitor-agent.sh h:bi-opt.0 120 "mission"

# With --pane: reuses an existing pane (monitor sits next to agent)
bash ~/.claude-ops/scripts/monitor-agent.sh --pane h:bi-opt.1 h:bi-opt.0 120 "mission"
```

**Why `--pane`?** Without it, `monitor-agent.sh` always calls `tmux split-window` which creates a pane in an unpredictable location (often in the wrong window). With `--pane`, you control the layout — typically splitting the target's window first, then pointing the monitor at the adjacent pane.

**Cleanup difference:** `--stop` with a reused pane kills the Claude process but preserves the pane. Without `--pane`, `--stop` kills the entire pane.

---

## Meta-Reflection Protocol

The monitor agent performs a **meta-reflection** every 6 captures — a higher-level synthesis of patterns across observations. After each meta-reflection, the monitor takes two concrete actions:

### Action 1: Update the harness

The monitor writes directly to the harness files (atomic jq writes to avoid conflicts with the agent):

```bash
# Append learning to progress.json
jq '.learnings += ["SSH+localhost for streaming endpoints behind SLB"]' \
  claude_files/{name}-progress.json > /tmp/monitor-progress-tmp.json \
  && mv /tmp/monitor-progress-tmp.json claude_files/{name}-progress.json

# Append Monitor Reflection section to journal
cat >> claude_files/{name}-journal.md <<EOF

## Monitor Reflection #1 — 2026-02-23 14:30

**Observations:**
- Agent hung on external API call for 13min (SLB streaming buffer timeout)
- Correctly pivoted from TypeScript to bash+SSH approach
- Overengineered first attempt — simpler is better for benchmarks

**Learnings captured:**
- "For prod API benchmarks behind SLB, always SSH to server and curl localhost"

**Issues flagged:**
- None — agent self-corrected well

EOF

# Add new task if undiscovered work spotted
jq '.tasks["fix-slb-timeout"] = {"status":"pending","description":"Add SLB timeout handling to bi-agent","blockedBy":[],"owner":null,"steps":[],"completed_steps":[],"team":null,"metadata":{}}' \
  claude_files/{name}-progress.json > /tmp/p.json && mv /tmp/p.json claude_files/{name}-progress.json
```

**What to write:**
- `learnings[]` — terse actionable bullets for seed prompts
- `journal.md` — "Monitor Reflection #N" section with observations, learnings, issues
- New tasks — if the monitor spots undiscovered work the agent missed

**Conflict safety:** The monitor writes infrequently (~every 12min). Uses atomic tmp+mv pattern. The agent reads progress.json at task boundaries, so monitor writes between tasks are safe.

### Action 2: Message the agent

After reflecting, send the agent actionable findings:

```bash
# Walk process tree to find own pane (display-message -p returns focused pane, not ours)
OWN_PANE_ID=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' | while read pid id; do
  p=$PPID; while [ "$p" -gt 1 ]; do
    [ "$p" = "$pid" ] && echo "$id" && break 2
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
  done
done)
MY_PANE=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' | awk -v id="$OWN_PANE_ID" '$1 == id {print $2; exit}')
tmux send-keys -t {target} "[from $MY_PANE] META-REFLECTION: your insight here"
tmux send-keys -t {target} -H 0d
```

**What to message:**
- Course corrections — "you're polling a dead server, pivot to prod"
- Learnings to apply — "use SSH+localhost, external HTTPS will timeout on streaming"
- Priority nudges — "you've spent 15min on auth, consider skipping to next task"
- Pattern warnings — "you've hit the same error 3 times, try a different approach"

**When NOT to message:** On every capture (too noisy). Only after meta-reflections or urgent interventions.

### Auto-detection

The monitor script auto-detects the harness by matching the target pane name against active progress files. If matched, the meta-reflection instructions (with correct file paths) are injected into the monitor's initial prompt. If no harness match, meta-reflection instructions are omitted and the monitor operates in observation-only mode.

### Timing

| Event | Frequency | Action |
|-------|-----------|--------|
| POLL/IDLE capture | Every {interval}s | Observe, log, nudge if stuck |
| Meta-reflection | Every 6 captures | Synthesize + update harness + message agent |
| Urgent intervention | Anytime | Escape + nudge (stuck, wrong track, dead server) |

---

## Existing Hooks Reference

| File | Type | What it does |
|---|---|---|
| `echo-stop.sh` | Stop | Replays deferred ECHO chain items |
| `echo-deferred.sh` | UserPromptSubmit | Captures `ECHO<content>` directives |
| `stop-check.sh` | Stop (project) | Reads XML, diffs baseline, contextual prompts |
| `session_namer.sh` | Stop | Asks Claude to name the session |
| `tool_logger.sh` | PostToolUse | Logs Bash/Write/Edit to JSONL |
| `subagent_lifecycle.sh` | SubagentStart/Stop | Tracks active subagents |
| `prompt_logger.sh` | UserPromptSubmit | Logs prompts with metadata |
| `snippet_injector.py` | UserPromptSubmit | Pattern-matches keywords, injects snippets |
| `pre-compact-evolve.sh` | PreCompact | Reminds agent to persist learnings before compaction |
