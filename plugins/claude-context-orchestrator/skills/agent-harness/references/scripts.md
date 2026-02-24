# Script Templates

## Seed Script (context restoration after /clear)

Reads progress file, outputs compact re-orientation prompt with mission and learnings.

```bash
#!/bin/bash
PROGRESS="{project}/claude_files/{name}-progress.json"
source ~/.claude-ops/lib/harness-jq.sh

MISSION=$(jq -r '.mission // "Read CLAUDE.md"' "$PROGRESS")
CURRENT=$(harness_current_task "$PROGRESS")
STEP=$(jq -r ".tasks[\"$CURRENT\"].completed_steps | length // 0" "$PROGRESS" 2>/dev/null || echo 0)
COMPLETED=$(jq -r '[.tasks | to_entries[] | select(.value.status == "completed") | .key] | join(", ")' "$PROGRESS")
NEXT=$(jq -r '[.tasks | to_entries[] | select(.value.status == "pending") | .key] | first // "ALL DONE"' "$PROGRESS")
# Carry forward last 5 learnings
LEARNINGS=$(jq -r '.learnings // [] | .[-5:] | .[] | "- " + .' "$PROGRESS" 2>/dev/null)

cat <<SEED
CONTINUE SESSION. Read CLAUDE.md first, then ${PROGRESS}.
Mission: ${MISSION}
Current: ${CURRENT} (step ${STEP})
Completed: [${COMPLETED:-none}]
Next: ${NEXT}
$([ -n "$LEARNINGS" ] && echo -e "\nLearnings from previous sessions:\n${LEARNINGS}")
Continue working. Commit after each task. Don't stop.
If all tasks done, explore for more work toward the mission.
SEED
```

---

## Continue Script (tmux /clear + reseed)

When context gets heavy, agent runs this. Discovers its own tmux pane via process tree, backgrounds /clear + reseed.

```bash
#!/bin/bash
set -euo pipefail
PROGRESS="{project}/claude_files/{name}-progress.json"
source ~/.claude-ops/lib/harness-jq.sh

# Bump session count
jq '.session_count += 1' "$PROGRESS" > /tmp/prog_tmp.json && mv /tmp/prog_tmp.json "$PROGRESS"

# Discover Claude's tmux pane
CLAUDE_PID=$PPID
PANE=""
for p in $(tmux list-panes -a -F '#{pane_id}:#{pane_pid}'); do
  PANE_ID="${p%%:*}"; PANE_PID="${p##*:}"
  if pgrep -P "$PANE_PID" | grep -q "$CLAUDE_PID" 2>/dev/null; then
    PANE="$PANE_ID"; break
  fi
done
[ -z "$PANE" ] && { echo "ERROR: Could not find tmux pane"; exit 1; }

# Generate seed prompt
SEED=$(bash {project}/.claude/scripts/{name}-seed.sh)

# Background: wait for response to finish, then /clear + reseed
# IMPORTANT: 90s sleep lets Claude finish current response.
# /clear won't work while Claude is still generating.
(
  sleep 90
  tmux send-keys -t "$PANE" "/clear" Enter
  sleep 5
  tmux set-buffer -b reseed "$SEED"
  tmux paste-buffer -b reseed -t "$PANE"
  sleep 1
  tmux send-keys -t "$PANE" Enter
) &
disown
echo "Context reset queued. /clear in ~90s, reseed in ~96s."
```

---

## Start Script (kickoff)

Sets progress to active, outputs harness instructions.

```bash
#!/bin/bash
PROGRESS="{project}/claude_files/{name}-progress.json"
HARNESS="{project}/claude_files/{name}-harness.md"

jq '.status = "active" | .started_at = (now | strftime("%Y-%m-%dT%H:%M:%SZ"))' "$PROGRESS" > /tmp/sp.json && mv /tmp/sp.json "$PROGRESS"
cat "$HARNESS"
```

---

## Task Management Script (dynamic queue)

Manages tasks in the progress file at runtime -- add new targets discovered during autonomous work, remove stale ones, list status.

```bash
#!/bin/bash
# {name}-task.sh — Dynamic task management
set -euo pipefail
PROGRESS="{project}/claude_files/{name}-progress.json"
source ~/.claude-ops/lib/harness-jq.sh

cmd="${1:-list}"
shift || true

case "$cmd" in
  add)
    NAME="${1:?Usage: task.sh add <name> <description> [priority]}"
    DESC="${2:?Usage: task.sh add <name> <description> [priority]}"
    PRIORITY="${3:-99}"
    TMP=$(mktemp)
    jq --arg n "$NAME" --arg d "$DESC" --argjson p "$PRIORITY" \
      '.tasks[$n] = {"status":"pending","priority":$p,"description":$d,"steps":[],"completed_steps":[],"blockedBy":[],"owner":null,"metadata":{}}' \
      "$PROGRESS" > "$TMP" && mv "$TMP" "$PROGRESS"
    echo "Added: $NAME (priority $PRIORITY)"
    ;;

  remove)
    NAME="${1:?Usage: task.sh remove <name>}"
    TMP=$(mktemp)
    jq --arg n "$NAME" 'del(.tasks[$n])' "$PROGRESS" > "$TMP" && mv "$TMP" "$PROGRESS"
    echo "Removed: $NAME"
    ;;

  list)
    echo "=== Tasks ==="
    jq -r '.tasks | to_entries | sort_by(.value.priority) | .[] |
      "\(.value.status | if . == "completed" then "✓" elif . == "in_progress" then "→" else " " end) [\(.value.priority)] \(.key): \(.value.description // "")"' \
      "$PROGRESS"
    echo ""
    DONE=$(jq '[.tasks | to_entries[] | select(.value.status == "completed")] | length' "$PROGRESS")
    TOTAL=$(jq '[.tasks | to_entries[]] | length' "$PROGRESS")
    echo "$DONE/$TOTAL completed"
    ;;

  *)
    echo "Usage: task.sh [add|remove|list]"
    echo "  add <name> <description> [priority]"
    echo "  remove <name>"
    echo "  list"
    ;;
esac
```

This is particularly useful for **exploration-first harnesses** (like optimize) where the agent discovers new targets during autonomous work and needs to add them to the queue.

---

## Swarm Start Script Template

For harnesses that use swarm mode (orchestrator + background worker agents). Reads team config from the `state` field in progress.json.

```bash
#!/usr/bin/env bash
# {name}-start.sh (swarm mode) -- Activates harness + creates team
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROGRESS="$PROJECT_ROOT/claude_files/{name}-progress.json"
HARNESS="$PROJECT_ROOT/claude_files/{name}-harness.md"

# Activate harness
TMP=$(mktemp)
jq ".status = \"active\" | .started_at = \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"" "$PROGRESS" > "$TMP" && mv "$TMP" "$PROGRESS"

# Read team config from state
MODE=$(jq -r '.state.mode // "solo"' "$PROGRESS")
TEAM_NAME=$(jq -r '.state.team_name // ""' "$PROGRESS")
MAX_WORKERS=$(jq -r '.state.max_workers // 3' "$PROGRESS")

cat "$HARNESS"

if [ "$MODE" = "swarm" ]; then
  echo ""
  echo "=== SWARM MODE ==="
  echo "Team: $TEAM_NAME | Max workers: $MAX_WORKERS"
  echo ""
  echo "After reading instructions, initialize the team:"
  echo "  1. TeamCreate(team_name=\"$TEAM_NAME\")"
  echo "  2. For each pending task in progress.json → TaskCreate"
  echo "  3. Spawn workers via Task(team_name=\"$TEAM_NAME\", subagent_type=\"general-purpose\")"
  echo "  4. Monitor via TaskList, sync completions back to progress.json"
fi
```

---

## Sync Helper

Shell function for syncing progress.json with Claude Code TaskList. Call from the lead agent after a worker completes a task to keep the durable progress file in sync with the ephemeral team task state.

```bash
# sync_task_completion -- Call from lead agent after worker completes a task
# Updates progress.json to match Claude Code team task state
sync_task_completion() {
  local PROGRESS="$1" TASK_ID="$2"
  source ~/.claude-ops/lib/harness-jq.sh
  harness_set_completed "$PROGRESS" "$TASK_ID"
  # Bump rotation counter
  jq '.current_session.tasks_completed += 1' "$PROGRESS" > /tmp/sync_tmp.json && mv /tmp/sync_tmp.json "$PROGRESS"
}
```

---

## Self-Test Verification Sequence

**CRITICAL: Always test before going autonomous.** A broken harness at 3am = 6 hours of wasted compute.

```bash
# 1. Syntax-check all hook scripts
bash -n .claude/hooks/stop-check.sh
bash -n .claude/hooks/safety-guard.sh
bash -n ~/.claude-ops/hooks/baseline-init.sh

# 2. Dry-run stop hook — should output valid JSON with "block" decision
echo '{"session_id":"test-123","cwd":"'$(pwd)'"}' | bash .claude/hooks/stop-check.sh
# Expected: {"decision":"block","reason":"..."}

# 3. Dry-run safety hook — test that it blocks dangerous commands
echo '{"session_id":"test-123","tool_name":"Bash","tool_input":{"command":"git push --force"}}' | bash .claude/hooks/safety-guard.sh
# Expected: {"decision":"block","reason":"SAFETY: ..."}

# 4. Verify progress file is valid JSON
jq . claude_files/{name}-progress.json

# 5. Test start script
bash .claude/scripts/{name}-start.sh 2>&1 | head -5

# 6. Test seed script
bash .claude/scripts/{name}-seed.sh 2>&1

# 7. Test tmux pane discovery
for p in $(tmux list-panes -a -F '#{pane_id}:#{pane_pid}'); do echo "Pane: $p"; done

# 8. Test escape hatch
touch /tmp/claude_allow_stop_test-123
echo '{"session_id":"test-123","cwd":"'$(pwd)'"}' | bash .claude/hooks/stop-check.sh
# Expected: empty output (exit 0, no block)
rm -f /tmp/claude_allow_stop_test-123
```

**Common issues:**
- `jq` not installed or wrong version
- Hardcoded paths that don't match actual project location
- JSON syntax errors in progress files (trailing commas)
- tmux pane discovery fails outside tmux
- Escape hatch file not detected due to quoting
