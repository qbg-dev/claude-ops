#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# 08-meta-reflect.sh — Deep meta-reflection sweep
# ══════════════════════════════════════════════════════════════════
# Architecture: bash gathers orientation context, Claude agent
# deep-dives into session transcripts and evolves policy files.
#
# The agent gets:
#   - Progress, best-practices, context-injections (inline)
#   - Session transcript FILE PATHS (not pre-digested snippets)
#   - Directed analysis questions
#   - Read/Grep/Glob tools to explore transcripts self-directedly
#
# Contract:
#   --interval            Print interval and exit
#   --check               Gather context only, print what agent would see
#   --run                 Gather context + spawn agent
#   --project <path>      Target a specific project root
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

SWEEP_NAME="meta-reflect"
source "$HOME/.claude-ops/lib/sweep-config.sh"
load_sweep_config "$SWEEP_NAME"

CONF="${HOME}/.claude-ops/control-plane.conf"
CONTEXT_FILE="/tmp/harness_sweep_08_context.md"

# ── Load control-plane config (for non-sweep vars) ──────────────
if [ -f "$CONF" ]; then
  source "$CONF"
fi

# ── Shared infrastructure ────────────────────────────────────────
source "${HOME}/.claude-ops/lib/spawn-sweep-agent.sh"

# ── Helpers ──────────────────────────────────────────────────────
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ── CLI parsing ──────────────────────────────────────────────────
MODE=""
PROJECT_ROOT_ARG=""
HARNESS_NAME=""

while [ $# -gt 0 ]; do
  case "$1" in
    --interval) echo "$SWEEP_INTERVAL"; exit 0 ;;
    --scope)    echo "$SWEEP_SCOPE"; exit 0 ;;
    --check)    MODE="check"; shift ;;
    --run)      MODE="run"; shift ;;
    --project)  PROJECT_ROOT_ARG="$2"; shift 2 ;;
    --harness)  HARNESS_NAME="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ -z "$MODE" ] && { echo "Usage: $0 [--interval|--check|--run] [--harness <name>|--project <path>]" >&2; exit 1; }

source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true
if [ -n "$HARNESS_NAME" ]; then
  PROJECT_ROOT=$(harness_project_root "$HARNESS_NAME" 2>/dev/null)
elif [ -n "$PROJECT_ROOT_ARG" ]; then
  PROJECT_ROOT="$PROJECT_ROOT_ARG"
else
  PROJECT_ROOT="${PROJECT_ROOT:-}"
fi
[ -z "$PROJECT_ROOT" ] && { echo "ERROR: No project root." >&2; exit 1; }

SESSIONS_DIR="${HOME}/.claude/projects/-Users-wz-Desktop-zPersonalProjects-Wechat"
SESSIONS_INDEX="$SESSIONS_DIR/sessions-index.json"

# ══════════════════════════════════════════════════════════════════
# PHASE 1: Gather orientation context for active harnesses
# ══════════════════════════════════════════════════════════════════

active_count=0

{
cat <<'HEADER'
# Meta-Reflection Sweep

You are a META-REFLECTION agent. Your job is to deeply analyze what happened in recent agent sessions and produce actionable improvements to harness policy.

**You have full Read/Grep/Glob tools.** Use them to explore session transcripts, code, and any files you need. Don't rely only on the summaries below — dig into the raw data.

## YOUR WORKFLOW

### Step 1 — Apply Monitor Findings (mechanical, do first)

For each harness with a "Monitor Findings" section containing a JSON file:
1. `proposed_best_practices` → merge into `{harness}-best-practices.json`
2. `proposed_context_injections` → merge into `{harness}-context-injections.json`
3. `proposed_learnings` → append to progress.json `learnings[]`
4. `proposed_tasks` → add non-duplicate tasks to progress.json `tasks{}`
5. Append entry to `{harness}-reflections.jsonl`
6. Delete `/tmp/monitor_findings_{harness}.json` via Bash

### Step 2 — Deep Session Analysis (this is the important part)

You have access to session transcript files (listed below). These are JSONL files where each line is a message. Use Grep and Read to explore them.

**Directed questions to investigate:**

1. **Failure patterns**: Grep for `"error"`, `"failed"`, `"retry"`, `"WARN"` across recent sessions. What keeps going wrong? Are there recurring errors that a context-injection could prevent?

2. **Stuck episodes**: Look for long sequences of tool calls on the same file or repeated similar tool calls — signs the agent was stuck. What caused it? Could a best-practice rule prevent it?

3. **Task velocity**: Compare task timestamps in progress.json. Which tasks took multiple sessions? Read those sessions to understand why — was the task underscoped, or did the agent go off-track?

4. **Wasted work**: Look for code that was written then reverted, or approaches that were tried then abandoned. What was the root cause? A missing context-injection about how the codebase works?

5. **Successful patterns**: What approaches worked well? These should become best-practices or context-injections so future agents benefit.

6. **Git churn**: Use `git log --stat` to find files changed 3+ times recently. High churn suggests the agent didn't understand something — what context-injection would help?

**How to analyze a transcript:**
- Transcripts are JSONL. Each line is a JSON object.
- User messages: `grep '"role":"human"' <file>` (these are prompts/instructions)
- Assistant messages: `grep '"role":"assistant"' <file>` (these are agent responses)
- Tool calls: `grep '"tool_use"' <file>` (what tools the agent used)
- Errors: `grep -i '"error\|"failed\|"warn"' <file>`
- Read specific lines with `Read` tool using offset/limit for large files
- **Tip**: Start with the last 200 lines of a session to see how it ended (success or stuck?)

### Step 3 — Write Improvements

Based on your analysis, update these files:

1. **`{harness}-best-practices.json`** — Add rules that would prevent failures you found
2. **`{harness}-context-injections.json`** — Add knowledge that would prevent wasted work
3. **`{harness}-reflections.jsonl`** — Append a structured entry documenting what you found:
   ```json
   {"ts":"ISO","harness":"name","sessions_analyzed":N,"findings":[{"type":"failure|stuck|waste|success","summary":"...","action":"added bp|added ci|added learning"}],"policy_changes":{"bp_added":N,"ci_added":N,"learnings_added":N}}
   ```

### Rules

- **Be specific.** "Agent should be more careful" is useless. "When editing TSX files, always check for existing CSS classes in the page stylesheet before adding inline styles" is actionable.
- **Every finding needs an action.** If you found a problem, add a best-practice or context-injection to prevent it. If you can't, explain why.
- **Never modify progress.json task statuses.** You can append to `learnings[]` and `tasks{}` only.
- **Never modify code files.** Only policy files.
- If you genuinely find nothing actionable after reading transcripts, write a reflection entry explaining what you checked and why nothing stood out.

### IMPORTANT: Exit When Done
When finished, type `/quit` to exit. Do not wait for further input.

## Orientation Data

HEADER

# ── Discover active harnesses ────────────────────────────────────
for progress_file in "$PROJECT_ROOT"/claude_files/*-progress.json; do
  [ -f "$progress_file" ] || continue

  harness_name=$(jq -r '.harness // empty' "$progress_file" 2>/dev/null)
  [ -z "$harness_name" ] && continue

  harness_status=$(jq -r '.status // "unknown"' "$progress_file" 2>/dev/null)
  [ "$harness_status" != "active" ] && continue

  active_count=$((active_count + 1))

  echo "---"
  echo ""
  echo "### Harness: $harness_name"
  echo ""

  # ── Progress state ───────────────────────────────────────────
  echo "#### Progress"
  echo ""
  echo '```json'
  jq '{harness, mission, status, started_at, session_count, tasks: (.tasks | to_entries | map({key: .key, status: .value.status, description: .value.description, blockedBy: .value.blockedBy}) | from_entries), learnings}' "$progress_file" 2>/dev/null || echo "{}"
  echo '```'
  echo ""

  # ── Best practices (current) ──────────────────────────────────
  bp_file="$PROJECT_ROOT/claude_files/${harness_name}-best-practices.json"
  echo "#### Best Practices"
  echo ""
  if [ -f "$bp_file" ]; then
    echo '```json'
    cat "$bp_file"
    echo '```'
  else
    echo "(none yet — create from scratch based on your findings)"
  fi
  echo ""

  # ── Context injections (current) ───────────────────────────────
  ci_file="$PROJECT_ROOT/claude_files/${harness_name}-context-injections.json"
  echo "#### Context Injections"
  echo ""
  if [ -f "$ci_file" ]; then
    echo '```json'
    cat "$ci_file"
    echo '```'
  else
    echo "(none yet — create from scratch based on your findings)"
  fi
  echo ""

  # ── Git log since harness started ──────────────────────────────
  started_at=$(jq -r '.started_at // empty' "$progress_file" 2>/dev/null)
  echo "#### Git Log (since harness started)"
  echo ""
  if [ -n "$started_at" ]; then
    echo '```'
    git -C "$PROJECT_ROOT" log --since="$started_at" --oneline --stat 2>/dev/null | head -100 || echo "(no commits)"
    echo '```'
  else
    echo "(no started_at in progress.json)"
  fi
  echo ""

  # ── Previous reflections (last 3) ──────────────────────────────
  reflections_file="$PROJECT_ROOT/claude_files/${harness_name}-reflections.jsonl"
  echo "#### Previous Reflections"
  echo ""
  if [ -f "$reflections_file" ]; then
    echo '```jsonl'
    tail -3 "$reflections_file"
    echo '```'
  else
    echo "(first run — no previous reflections)"
  fi
  echo ""

  # ── Session transcript index ───────────────────────────────────
  # Instead of pre-digesting transcripts, give the agent file paths + metadata
  # so it can Read/Grep them self-directedly
  echo "#### Session Transcripts (explore with Read/Grep)"
  echo ""
  echo "Sessions directory: \`$SESSIONS_DIR\`"
  echo ""

  # Method 1: From activity log (harness-linked sessions)
  activity_log="/tmp/claude_activity_${harness_name}.jsonl"
  if [ -f "$activity_log" ]; then
    echo "**From activity log** (sessions linked to this harness):"
    echo ""
    session_ids=$(grep -o '"session": "[^"]*"' "$activity_log" 2>/dev/null \
      | sed 's/"session": "//;s/"//' | awk '!seen[$0]++' | tail -10)
    echo "| Session ID | File | Size | Messages |"
    echo "|------------|------|------|----------|"
    for sid in $session_ids; do
      transcript=$(find "$SESSIONS_DIR" -maxdepth 1 -name "${sid}*.jsonl" -type f 2>/dev/null | head -1)
      if [ -n "$transcript" ]; then
        fsize=$(ls -lh "$transcript" 2>/dev/null | awk '{print $5}')
        msgcount=$(wc -l < "$transcript" 2>/dev/null | tr -d ' ')
        echo "| \`${sid}\` | \`$transcript\` | $fsize | $msgcount lines |"
      fi
    done
    echo ""
  fi

  # Method 2: From sessions-index.json (enriched metadata)
  if [ -f "$SESSIONS_INDEX" ]; then
    echo "**From sessions index** (recent sessions with summaries, last 10 by modification time):"
    echo ""
    # Get recent sessions for this project, sorted by modified desc
    python3 -c "
import json, sys, os
with open('$SESSIONS_INDEX') as f:
    data = json.load(f)
entries = data.get('entries', [])
# Sort by modified desc, take last 10
entries.sort(key=lambda e: e.get('modified', ''), reverse=True)
print('| Modified | Summary | Messages | Session File |')
print('|----------|---------|----------|-------------|')
for e in entries[:10]:
    sid = e.get('sessionId', '?')
    summary = e.get('summary', '(unnamed)')[:60]
    msgs = e.get('messageCount', '?')
    modified = e.get('modified', '?')[:16]
    path = e.get('fullPath', '')
    size = 'N/A'
    if path and os.path.exists(path):
        size = f'{os.path.getsize(path) / 1024:.0f}KB'
    print(f'| {modified} | {summary} | {msgs} msgs | \`{path}\` ({size}) |')
" 2>/dev/null || echo "(failed to parse sessions index)"
    echo ""
  fi

  echo "**How to explore**: Use \`Grep\` with patterns like \`error\`, \`failed\`, \`WARN\`, \`tool_use\` on specific transcript files. Use \`Read\` with offset/limit for large files (start from the end to see how sessions concluded)."
  echo ""

  # ── Monitor findings ───────────────────────────────────────────
  findings_file="/tmp/monitor_findings_${harness_name}.json"
  echo "#### Monitor Findings"
  echo ""
  if [ -f "$findings_file" ]; then
    findings_age=$(( $(date +%s) - $(stat -f %m "$findings_file" 2>/dev/null || echo 0) ))
    echo "(last updated: ${findings_age}s ago)"
    echo ""
    echo '```json'
    cat "$findings_file"
    echo '```'
    echo ""
    echo "**Apply these mechanically in Step 1, then delete the file.**"
  else
    echo "(no monitor findings — skip Step 1 for this harness, go straight to Step 2)"
  fi
  echo ""

done

# ── Shared state ────────────────────────────────────────────────
echo "---"
echo ""
echo "### Shared: checks.d/ Scripts"
echo ""
checks_dir="${HOME}/.claude-ops/hooks/operators/checks.d"
if [ -d "$checks_dir" ]; then
  for check in "$checks_dir"/*.sh; do
    [ -f "$check" ] || continue
    echo "- \`$(basename "$check")\`"
  done
else
  echo "(checks.d/ does not exist)"
fi
echo ""

beads_file="$PROJECT_ROOT/claude_files/harness-beads.json"
echo "### Shared: harness-beads.json"
echo ""
if [ -f "$beads_file" ]; then
  echo '```json'
  cat "$beads_file"
  echo '```'
else
  echo '(create with `{"wisps":[],"claims":{},"gates":{}}`)'
fi
echo ""

} > "$CONTEXT_FILE"

context_lines=$(wc -l < "$CONTEXT_FILE" | tr -d ' ')

# ── Check mode: just show the context ────────────────────────────
if [ "$MODE" = "check" ]; then
  echo "Context file: $CONTEXT_FILE ($context_lines lines, $active_count active harnesses)"
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "check" --argjson context_lines "$context_lines" \
    --argjson active_harnesses "$active_count" \
    '{ts:$ts, type:$type, name:$name, action:$action, context_lines:$context_lines, active_harnesses:$active_harnesses}'
  exit 0
fi

# ── Skip if no active harnesses ──────────────────────────────────
if [ "$active_count" -eq 0 ]; then
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "skip" --arg reason "no active harnesses" \
    '{ts:$ts, type:$type, name:$name, action:$action, reason:$reason}'
  exit 0
fi

# ══════════════════════════════════════════════════════════════════
# PHASE 2: Spawn Claude agent
# ══════════════════════════════════════════════════════════════════

notify "Meta-reflect sweep: spawning agent to analyze $active_count harness(es)" 2>/dev/null || true

PANE=$(spawn_sweep_agent "$SWEEP_NAME" "$PROJECT_ROOT" "$CONTEXT_FILE")

if [ -z "$PANE" ]; then
  jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
    --arg action "agent_fail" --arg reason "spawn_sweep_agent returned empty" \
    '{ts:$ts, type:$type, name:$name, action:$action, reason:$reason}'
  exit 0
fi

jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
  --arg action "agent_spawned" --arg pane "$PANE" \
  --argjson context_lines "$context_lines" \
  --argjson active_harnesses "$active_count" \
  '{ts:$ts, type:$type, name:$name, action:$action, pane:$pane, context_lines:$context_lines, active_harnesses:$active_harnesses}'

# ══════════════════════════════════════════════════════════════════
# PHASE 3: Wait for agent completion + validate
# ══════════════════════════════════════════════════════════════════

SWEEP_PANE="$PANE"
MAX_WAIT=1200  # 20 minutes (agent may read multiple transcripts)
ELAPSED=0
while [ $ELAPSED -lt $MAX_WAIT ]; do
  sleep 15
  ELAPSED=$((ELAPSED + 15))
  PANE_PID=$(tmux display-message -t "$SWEEP_PANE" -p '#{pane_pid}' 2>/dev/null) || break
  if ! pgrep -P "$PANE_PID" claude >/dev/null 2>&1; then
    break
  fi
done

# Validate: check if policy files were modified
APPLIED=0
for progress_file in "$PROJECT_ROOT"/claude_files/*-progress.json; do
  [ -f "$progress_file" ] || continue
  harness_name=$(jq -r '.harness // empty' "$progress_file" 2>/dev/null)
  [ -z "$harness_name" ] && continue
  harness_status=$(jq -r '.status // "unknown"' "$progress_file" 2>/dev/null)
  [ "$harness_status" != "active" ] && continue

  BP="$PROJECT_ROOT/claude_files/${harness_name}-best-practices.json"
  CI="$PROJECT_ROOT/claude_files/${harness_name}-context-injections.json"
  if [ -f "$BP" ] && find "$BP" -mmin -10 2>/dev/null | grep -q .; then APPLIED=$((APPLIED+1)); fi
  if [ -f "$CI" ] && find "$CI" -mmin -10 2>/dev/null | grep -q .; then APPLIED=$((APPLIED+1)); fi
done

REMAINING_FINDINGS=$(ls /tmp/monitor_findings_*.json 2>/dev/null | wc -l | tr -d ' ')

jq -n -c --arg ts "$(now_iso)" --arg type "sweep" --arg name "$SWEEP_NAME" \
  --arg action "agent_completed" --argjson applied "$APPLIED" \
  --argjson remaining_findings "$REMAINING_FINDINGS" \
  --argjson wait_seconds "$ELAPSED" \
  '{ts:$ts, type:$type, name:$name, action:$action, policy_files_modified:$applied, remaining_findings:$remaining_findings, wait_seconds:$wait_seconds}'
