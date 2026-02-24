# Concurrent Migrations

The single-migration design breaks when you need multiple harnesses in the same project. Here's the multi-migration architecture.

## Directory Layout

```
{project}/claude_files/harnesses/
  registry.json
  overnight-miniapp/
    harness.md
    progress.json
  billing-migration/
    harness.md
    progress.json
```

## Registry File

```json
{
  "migrations": {
    "overnight-miniapp": {
      "status": "active",
      "priority": 1,
      "harness": "claude_files/harnesses/overnight-miniapp/harness.md",
      "progress": "claude_files/harnesses/overnight-miniapp/progress.json",
      "started_at": "2026-02-20T22:00:00Z",
      "scope": ["src/miniapp/", "src/admin/routes/miniapp-routes.ts"],
      "branch": "feat/miniapp-chat"
    }
  }
}
```

Key fields:
- **`scope`**: File paths this migration owns. For conflict detection and stop hook routing.
- **`branch`**: Git branch. Enables worktree isolation.
- **`priority`**: When multiple migrations pending, which gets worked first.

## Design Decisions

| Problem | Solution |
|---------|----------|
| **tmux buffer collision** | `-b harness_{slug}` per migration |
| **Progress isolation** | Each migration has its own `progress.json` |
| **Stop hook routing** | Reads `registry.json`, diffs changed files against each migration's `scope` |
| **Seed script routing** | `continue.sh --migration <slug>` reads that migration's progress |
| **Session affinity** | One session = one migration, tracked via `/tmp/claude_active_migration_{session_id}` |
| **File conflicts** | Overlapping `scope` = don't run concurrently. Use worktrees or serialize by priority. |
| **Priority/scheduling** | Registry `priority` field. Stop hook advances to next highest-priority. |
| **Cleanup** | Completed migrations stay in registry (status="completed") for reference |

## Multi-Migration Stop Hook

```bash
#!/bin/bash
set -euo pipefail
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
[ -z "$SESSION_ID" ] && exit 0
[ -f "/tmp/claude_allow_stop_${SESSION_ID}" ] && exit 0

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="$PROJECT_ROOT/claude_files/harnesses/registry.json"
[ ! -f "$REGISTRY" ] && exit 0

# Find which migration this session is working on
ACTIVE_FILE="/tmp/claude_active_migration_${SESSION_ID}"
if [ -f "$ACTIVE_FILE" ]; then
  SLUG=$(cat "$ACTIVE_FILE")
else
  SLUG=$(jq -r '
    [.migrations | to_entries[]
     | select(.value.status == "active")
     | {key, priority: .value.priority}]
    | sort_by(.priority) | first | .key // "none"
  ' "$REGISTRY")
  [ "$SLUG" = "none" ] && exit 0
  echo "$SLUG" > "$ACTIVE_FILE"
fi

PROGRESS="$PROJECT_ROOT/$(jq -r --arg s "$SLUG" '.migrations[$s].progress' "$REGISTRY")"
HARNESS="$PROJECT_ROOT/$(jq -r --arg s "$SLUG" '.migrations[$s].harness' "$REGISTRY")"

if [ ! -f "$PROGRESS" ]; then
  MSG="## Keep working on migration: $SLUG\nRead $HARNESS for instructions."
  jq -n --arg r "$(echo -e "$MSG")" '{"decision":"block","reason":$r}'
  exit 0
fi

source ~/.claude-ops/lib/harness-jq.sh
CURRENT=$(harness_current_task "$PROGRESS")
NEXT=$(harness_next_task "$PROGRESS")
COMPLETED=$(harness_completed_names "$PROGRESS")

# Check if this migration is done — advance to next
if [ "$CURRENT" = "ALL_DONE" ]; then
  NEXT_SLUG=$(jq -r --arg s "$SLUG" '
    [.migrations | to_entries[]
     | select(.value.status == "active" and .key != $s)
     | {key, priority: .value.priority}]
    | sort_by(.priority) | first | .key // "ALL_DONE"
  ' "$REGISTRY")

  if [ "$NEXT_SLUG" = "ALL_DONE" ]; then
    exit 0  # All migrations complete
  fi

  TMP=$(mktemp)
  jq --arg s "$SLUG" '.migrations[$s].status = "completed"' "$REGISTRY" > "$TMP" && mv "$TMP" "$REGISTRY"
  echo "$NEXT_SLUG" > "$ACTIVE_FILE"

  NEXT_HARNESS="$PROJECT_ROOT/$(jq -r --arg s "$NEXT_SLUG" '.migrations[$s].harness' "$REGISTRY")"
  MSG="## Migration '$SLUG' complete! Starting '$NEXT_SLUG'.\nRead $NEXT_HARNESS for instructions."
  jq -n --arg r "$(echo -e "$MSG")" '{"decision":"block","reason":$r}'
  exit 0
fi

# Show status
OTHER_COUNT=$(jq -r --arg s "$SLUG" '[.migrations | to_entries[] | select(.value.status == "active" and .key != $s)] | length' "$REGISTRY")
OTHER_NAMES=$(jq -r --arg s "$SLUG" '[.migrations | to_entries[] | select(.value.status == "active" and .key != $s) | .key] | join(", ")' "$REGISTRY")

MSG="## Keep working on: $SLUG\n\n"
MSG="${MSG}**Current:** ${CURRENT}\n**Next:** ${NEXT}\n**Done:** [${COMPLETED:-none yet}]\n"
[ "$OTHER_COUNT" -gt 0 ] && MSG="${MSG}\n**Other active** ($OTHER_COUNT): $OTHER_NAMES\n"
MSG="${MSG}\nRead $HARNESS if you lost context.\nEscape: touch /tmp/claude_allow_stop_${SESSION_ID}"

jq -n --arg r "$(echo -e "$MSG")" '{"decision":"block","reason":$r}'
```

## Multi-Migration Continue Script

```bash
#!/bin/bash
# continue.sh --migration <slug>
set -euo pipefail

SLUG="${2:-}"
[ -z "$SLUG" ] && { echo "Usage: continue.sh --migration <slug>"; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="$PROJECT_ROOT/claude_files/harnesses/registry.json"
PROGRESS="$PROJECT_ROOT/$(jq -r --arg s "$SLUG" '.migrations[$s].progress' "$REGISTRY")"
HARNESS="$PROJECT_ROOT/$(jq -r --arg s "$SLUG" '.migrations[$s].harness' "$REGISTRY")"

jq '.session_count += 1' "$PROGRESS" > /tmp/prog_tmp.json && mv /tmp/prog_tmp.json "$PROGRESS"

CLAUDE_PID=$PPID
PANE=""
for p in $(tmux list-panes -a -F '#{pane_id}:#{pane_pid}'); do
  PANE_ID="${p%%:*}"; PANE_PID="${p##*:}"
  if pgrep -P "$PANE_PID" | grep -q "$CLAUDE_PID" 2>/dev/null; then
    PANE="$PANE_ID"; break
  fi
done
[ -z "$PANE" ] && { echo "ERROR: Could not find tmux pane"; exit 1; }

source ~/.claude-ops/lib/harness-jq.sh
CURRENT=$(harness_current_task "$PROGRESS")
STEP=$(jq -r --arg t "$CURRENT" '.tasks[$t].completed_steps | length // 0' "$PROGRESS")
COMPLETED=$(harness_completed_names "$PROGRESS")
NEXT=$(harness_next_task "$PROGRESS")

SEED="CONTINUE MIGRATION: $SLUG. Read $HARNESS first.
Progress: $PROGRESS
Current: $CURRENT (step $STEP)
Completed: [$COMPLETED]
Next: $NEXT
Continue working. Commit after each task. Don't stop."

BUFFER="harness_${SLUG}"

(
  sleep 90
  tmux send-keys -t "$PANE" "/clear" Enter
  sleep 5
  tmux set-buffer -b "$BUFFER" "$SEED"
  tmux paste-buffer -b "$BUFFER" -t "$PANE"
  sleep 1
  tmux send-keys -t "$PANE" Enter
) &
disown
echo "Context reset for '$SLUG'. /clear in ~90s, reseed in ~96s."
```

## Multi-Migration Start Script

```bash
#!/bin/bash
# start.sh --migration <slug> [--feature <name>]
set -euo pipefail

SLUG="" FEATURE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --migration) SLUG="$2"; shift 2 ;;
    --feature) FEATURE="$2"; shift 2 ;;
    *) SLUG="$1"; shift ;;
  esac
done
[ -z "$SLUG" ] && { echo "Usage: start.sh --migration <slug>"; exit 1; }

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REGISTRY="$PROJECT_ROOT/claude_files/harnesses/registry.json"
PROGRESS="$PROJECT_ROOT/$(jq -r --arg s "$SLUG" '.migrations[$s].progress' "$REGISTRY")"
HARNESS="$PROJECT_ROOT/$(jq -r --arg s "$SLUG" '.migrations[$s].harness' "$REGISTRY")"

TMP=$(mktemp)
jq --arg s "$SLUG" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '.migrations[$s].status = "active" | .migrations[$s].started_at = $t' \
  "$REGISTRY" > "$TMP" && mv "$TMP" "$REGISTRY"

source ~/.claude-ops/lib/harness-jq.sh
TMP=$(mktemp)
if [ -n "$FEATURE" ]; then
  jq --arg f "$FEATURE" \
    '.status = "active" | .tasks[$f].status = "in_progress"' \
    "$PROGRESS" > "$TMP" && mv "$TMP" "$PROGRESS"
else
  FIRST=$(harness_next_task "$PROGRESS")
  if [ "$FIRST" != "ALL_DONE" ]; then
    jq --arg f "$FIRST" \
      '.status = "active" | .tasks[$f].status = "in_progress"' \
      "$PROGRESS" > "$TMP" && mv "$TMP" "$PROGRESS"
  fi
fi

echo "=== Migration '$SLUG' activated ==="
echo ""
cat "$HARNESS"
```

## Worktree Isolation

When two migrations touch overlapping files:

```bash
git worktree add .claude/worktrees/billing-migration feat/billing-v2
git worktree add .claude/worktrees/ux-polish feat/ux-polish
```

The Task tool supports `isolation: "worktree"` which handles this automatically.

## Migration Lifecycle

```
create → active → completed
                ↘ paused (blocked on external dep)
                    ↘ active (resumed)
```
