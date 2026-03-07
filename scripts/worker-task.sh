#!/usr/bin/env bash
# worker-task.sh — Per-worker task list management.
# Shared by parent + child panes via the same tasks.json file.
#
# Usage:
#   worker-task.sh add "Subject" [--priority critical|high|medium|low] [--desc "Details"]
#                                [--active "Doing X…"] [--recurring] [--after T001,T002]
#                                [--blocks T003,T004] [--meta key=value] [--meta k2=v2]
#   worker-task.sh claim <task-id>
#   worker-task.sh complete <task-id>
#   worker-task.sh delete <task-id>
#   worker-task.sh list [--pending] [--mine] [--blocked] [--all]
#   worker-task.sh next
#   worker-task.sh dashboard
#
# Auto-detects worker name from pane registry or git branch.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/fleet-jq.sh"

# ── Detect own pane ID ──
_own_pane_id() {
  tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | while read pid id; do
    p=$PPID
    while [ "$p" -gt 1 ]; do
      [ "$p" = "$pid" ] && echo "$id" && return 0
      p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    done
  done
}

OWN_PANE=$(_own_pane_id)

# ── Detect worker name ──
_detect_worker() {
  # 1. Pane registry → harness field → strip worker/ prefix
  if [ -n "$OWN_PANE" ] && [ -f "$PANE_REGISTRY" ]; then
    local harness
    harness=$(jq -r --arg p "$OWN_PANE" '.[$p].harness // empty' "$PANE_REGISTRY" 2>/dev/null)
    if [ -n "$harness" ]; then
      echo "${harness#worker/}"
      return 0
    fi
    # Check if we're a child — look up parent's harness
    local parent
    parent=$(jq -r --arg p "$OWN_PANE" '.[$p].parent_pane // empty' "$PANE_REGISTRY" 2>/dev/null)
    if [ -n "$parent" ]; then
      harness=$(jq -r --arg p "$parent" '.[$p].harness // empty' "$PANE_REGISTRY" 2>/dev/null)
      [ -n "$harness" ] && echo "${harness#worker/}" && return 0
    fi
  fi
  # 2. Git branch worker/{name}
  local branch
  branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [[ "$branch" == worker/* ]]; then
    echo "${branch#worker/}"
    return 0
  fi
  return 1
}

# ── Resolve tasks.json path ──
_resolve_tasks_file() {
  local worker="$1"
  # Worktree → main repo resolution (same as tool-policy-gate.sh)
  local git_common
  git_common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)
  local main_repo
  if [ -n "$git_common" ]; then
    main_repo=$(dirname "$git_common")
    # If git_common ends in .git, main_repo is its parent
    [[ "$git_common" == */.git ]] && main_repo=$(dirname "$git_common")
  else
    main_repo=$(git rev-parse --show-toplevel 2>/dev/null || echo ".")
  fi
  echo "$main_repo/.claude/workers/$worker/tasks.json"
}

CMD="${1:-help}"
shift 2>/dev/null || true

# Dashboard doesn't need worker context — handle early
if [ "$CMD" = "dashboard" ]; then
  WORKER=""; TASKS_FILE=""
else
  WORKER=$(_detect_worker) || { echo "ERROR: Cannot detect worker name. Run from a worker pane or worker/* branch." >&2; exit 1; }
  TASKS_FILE=$(_resolve_tasks_file "$WORKER")
  [ ! -f "$TASKS_FILE" ] && echo '{}' > "$TASKS_FILE"
fi

case "$CMD" in
  add)
    SUBJECT="${1:?Usage: worker-task.sh add \"Subject\" [--priority P] [--desc \"...\"] [--active \"...\"] [--recurring] [--after T001,T002] [--blocks T003,T004] [--meta key=val]}"
    shift
    PRIORITY="medium"
    DESC=""
    ACTIVE_FORM=""
    RECURRING="false"
    BLOCKED_BY=""
    BLOCKS=""
    META_PAIRS=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --priority|-p) PRIORITY="$2"; shift 2 ;;
        --desc|-d)     DESC="$2"; shift 2 ;;
        --active|-A)   ACTIVE_FORM="$2"; shift 2 ;;
        --recurring|-r) RECURRING="true"; shift ;;
        --after|-a)    BLOCKED_BY="$2"; shift 2 ;;
        --blocks|-b)   BLOCKS="$2"; shift 2 ;;
        --meta|-m)     META_PAIRS+=("$2"); shift 2 ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
      esac
    done

    # Default activeForm derived from subject
    [ -z "$ACTIVE_FORM" ] && ACTIVE_FORM="Working on: $SUBJECT"

    # Build metadata JSON object
    META_JSON="{}"
    for kv in "${META_PAIRS[@]+"${META_PAIRS[@]}"}"; do
      k="${kv%%=*}"
      v="${kv#*=}"
      META_JSON=$(echo "$META_JSON" | jq --arg k "$k" --arg v "$v" '.[$k] = $v')
    done

    # Find next task ID
    MAX_NUM=$(jq -r 'keys[]' "$TASKS_FILE" 2>/dev/null | sed 's/^T//' | sort -n | tail -1)
    NEXT_NUM=$(( 10#${MAX_NUM:-0} + 1 ))
    TASK_ID=$(printf "T%03d" "$NEXT_NUM")
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

    # Convert comma-separated blocked_by to JSON array
    if [ -n "$BLOCKED_BY" ]; then
      BLOCKED_JSON=$(echo "$BLOCKED_BY" | tr ',' '\n' | grep -v '^$' | jq -R . | jq -s .)
    else
      BLOCKED_JSON="[]"
    fi

    locked_jq_write "$TASKS_FILE" "worker-tasks-$WORKER" \
      '.[$id] = {subject: $subj, description: $desc, activeForm: $active, status: "pending", priority: $pri, recurring: ($rec == "true"), blocked_by: ($blocked | fromjson), metadata: ($meta | fromjson), cycles_completed: 0, owner: null, created_at: $now, completed_at: null}' \
      --arg id "$TASK_ID" --arg subj "$SUBJECT" --arg desc "$DESC" --arg active "$ACTIVE_FORM" \
      --arg pri "$PRIORITY" --arg rec "$RECURRING" --arg blocked "$BLOCKED_JSON" \
      --arg meta "$META_JSON" --arg now "$NOW"

    # Forward-blocking: add TASK_ID to blocked_by of specified tasks
    if [ -n "$BLOCKS" ]; then
      locked_jq_write "$TASKS_FILE" "worker-tasks-$WORKER" \
        '($blocks | split(",") | map(select(. != ""))) as $blist |
         reduce $blist[] as $b (.;
           if .[$b] then
             .[$b].blocked_by = (([(.[$b].blocked_by // []), [$self]] | add) | unique)
           else . end)' \
        --arg self "$TASK_ID" --arg blocks "$BLOCKS"
    fi

    SUFFIX=""
    [ "$RECURRING" = "true" ] && SUFFIX=" (recurring)"
    [ -n "$BLOCKED_BY" ] && SUFFIX="$SUFFIX (after: $BLOCKED_BY)"
    [ -n "$BLOCKS" ]    && SUFFIX="$SUFFIX (blocks: $BLOCKS)"
    [ "${#META_PAIRS[@]}" -gt 0 ] && SUFFIX="$SUFFIX (meta: ${#META_PAIRS[@]} keys)"
    echo "Added $TASK_ID: $SUBJECT [$PRIORITY]$SUFFIX"
    ;;

  claim)
    TASK_ID="${1:?Usage: worker-task.sh claim <task-id>}"
    # Check task exists and is claimable
    CURRENT_OWNER=$(jq -r --arg id "$TASK_ID" '.[$id].owner // empty' "$TASKS_FILE" 2>/dev/null)
    CURRENT_STATUS=$(jq -r --arg id "$TASK_ID" '.[$id].status // empty' "$TASKS_FILE" 2>/dev/null)
    [ -z "$CURRENT_STATUS" ] && { echo "ERROR: Task $TASK_ID not found" >&2; exit 1; }
    [ "$CURRENT_STATUS" = "completed" ] && { echo "ERROR: Task $TASK_ID already completed" >&2; exit 1; }
    [ "$CURRENT_STATUS" = "deleted" ]   && { echo "ERROR: Task $TASK_ID has been deleted" >&2; exit 1; }
    if [ -n "$CURRENT_OWNER" ] && [ "$CURRENT_OWNER" != "null" ] && [ "$CURRENT_OWNER" != "$OWN_PANE" ]; then
      echo "ERROR: Task $TASK_ID already claimed by $CURRENT_OWNER" >&2; exit 1
    fi

    # Check blocked_by — all dependencies must be completed
    BLOCKERS=$(jq -r --arg id "$TASK_ID" '
      . as $all | ($all[$id].blocked_by // []) |
      map(select(. as $d | $all[$d].status != "completed")) |
      if length > 0 then .[] else empty end' "$TASKS_FILE" 2>/dev/null)
    if [ -n "$BLOCKERS" ]; then
      echo "ERROR: Task $TASK_ID blocked by incomplete tasks: $BLOCKERS" >&2; exit 1
    fi

    locked_jq_write "$TASKS_FILE" "worker-tasks-$WORKER" \
      '.[$id].owner = $pane | .[$id].status = "in_progress"' \
      --arg id "$TASK_ID" --arg pane "${OWN_PANE:-unknown}"
    echo "Claimed $TASK_ID → ${OWN_PANE:-unknown}"
    ;;

  complete)
    TASK_ID="${1:?Usage: worker-task.sh complete <task-id>}"
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    IS_RECURRING=$(jq -r --arg id "$TASK_ID" '.[$id].recurring // false' "$TASKS_FILE" 2>/dev/null)
    if [ "$IS_RECURRING" = "true" ]; then
      # Recurring: reset to pending, clear owner, bump cycle count
      locked_jq_write "$TASKS_FILE" "worker-tasks-$WORKER" \
        '.[$id].status = "pending" | .[$id].owner = null | .[$id].completed_at = null | .[$id].cycles_completed = ((.[$id].cycles_completed // 0) + 1) | .[$id].last_completed_at = $now' \
        --arg id "$TASK_ID" --arg now "$NOW"
      CYCLES=$(jq -r --arg id "$TASK_ID" '.[$id].cycles_completed' "$TASKS_FILE" 2>/dev/null)
      echo "Completed $TASK_ID (recurring — reset to pending, cycle #$CYCLES)"
    else
      locked_jq_write "$TASKS_FILE" "worker-tasks-$WORKER" \
        '.[$id].status = "completed" | .[$id].completed_at = $now' \
        --arg id "$TASK_ID" --arg now "$NOW"
      echo "Completed $TASK_ID"
    fi
    ;;

  delete)
    TASK_ID="${1:?Usage: worker-task.sh delete <task-id>}"
    NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    CURRENT_STATUS=$(jq -r --arg id "$TASK_ID" '.[$id].status // empty' "$TASKS_FILE" 2>/dev/null)
    [ -z "$CURRENT_STATUS" ] && { echo "ERROR: Task $TASK_ID not found" >&2; exit 1; }
    locked_jq_write "$TASKS_FILE" "worker-tasks-$WORKER" \
      '.[$id].status = "deleted" | .[$id].deleted_at = $now' \
      --arg id "$TASK_ID" --arg now "$NOW"
    echo "Deleted $TASK_ID"
    ;;

  list)
    FILTER="all"
    SHOW_ALL="false"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --pending) FILTER="pending"; shift ;;
        --mine)    FILTER="mine"; shift ;;
        --blocked) FILTER="blocked"; shift ;;
        --all)     SHOW_ALL="true"; shift ;;
        *) shift ;;
      esac
    done

    # Common jq: exclude deleted (unless --all), compute effective blocked status.
    # Capture blocked_by into $deps first — avoids .value becoming inaccessible after a pipe.
    LIST_JQ='. as $all | to_entries
      | map(select(.value.status != "deleted" or ($show_all == "true")))
      | map(
          (.value.blocked_by // []) as $deps |
          .value.blocked = (
            ($deps | length) > 0
            and ($deps | any(. as $d | $all[$d].status != "completed"))
          )
        )'

    case "$FILTER" in
      pending)
        { printf "ID\tPRIORITY\tSTATUS\tOWNER\tSUBJECT\n"
          jq -r --arg show_all "$SHOW_ALL" "$LIST_JQ"'
            | map(select(.value.status == "pending" and (.value.owner == null or .value.owner == "null") and .value.blocked == false))
            | sort_by({"critical":0,"high":1,"medium":2,"low":3}[.value.priority] // 2)
            | .[] | [.key, .value.priority, "ready", "-", .value.subject] | @tsv' "$TASKS_FILE" 2>/dev/null
        } | column -t -s $'\t'
        ;;
      blocked)
        { printf "ID\tPRIORITY\tSTATUS\tBLOCKED_BY\tSUBJECT\n"
          jq -r --arg show_all "$SHOW_ALL" "$LIST_JQ"'
            | map(select(.value.blocked == true and .value.status != "completed"))
            | .[] | [.key, .value.priority, "blocked", (.value.blocked_by // [] | join(",")), .value.subject] | @tsv' "$TASKS_FILE" 2>/dev/null
        } | column -t -s $'\t'
        ;;
      mine)
        { printf "ID\tPRIORITY\tSTATUS\tOWNER\tSUBJECT\n"
          jq -r --arg pane "${OWN_PANE:-}" --arg show_all "$SHOW_ALL" "$LIST_JQ"'
            | map(select(.value.owner == $pane))
            | .[] | [.key, .value.priority, .value.status, .value.owner, .value.subject] | @tsv' "$TASKS_FILE" 2>/dev/null
        } | column -t -s $'\t'
        ;;
      *)
        { printf "ID\tPRIORITY\tSTATUS\tOWNER\tSUBJECT\n"
          jq -r --arg show_all "$SHOW_ALL" "$LIST_JQ"'
            | sort_by({"pending":0,"in_progress":1,"completed":2,"deleted":3}[.value.status] // 0, {"critical":0,"high":1,"medium":2,"low":3}[.value.priority] // 2)
            | .[] | [.key, .value.priority,
                (if .value.status == "deleted" then "deleted"
                 elif .value.blocked then "blocked"
                 elif .value.status == "pending" then "ready"
                 else .value.status end),
                (.value.owner // "-"),
                .value.subject
                  + (if (.value.blocked_by // [] | length) > 0 then " [after:" + (.value.blocked_by | join(",")) + "]" else "" end)
                  + (if .value.status == "deleted" then " [DELETED]" else "" end)
              ] | @tsv' "$TASKS_FILE" 2>/dev/null
        } | column -t -s $'\t'
        ;;
    esac
    ;;

  next)
    NEXT=$(jq -r '. as $all | to_entries
      | map(select(
          .value.status == "pending"
          and (.value.owner == null or .value.owner == "null")
          and ((.value.blocked_by // []) | all(. as $d | $all[$d].status == "completed"))
        ))
      | sort_by({"critical":0,"high":1,"medium":2,"low":3}[.value.priority] // 2)
      | first // empty | [.key, .value.priority, .value.subject] | @tsv' "$TASKS_FILE" 2>/dev/null)
    if [ -z "$NEXT" ]; then
      echo "No unclaimed tasks"
    else
      echo "$NEXT" | awk -F'\t' '{printf "%s [%s]: %s\n", $1, $2, $3}'
    fi
    ;;

  dashboard)
    # Generate HTML dashboard for all workers and open it
    MAIN_REPO=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||' || git rev-parse --show-toplevel 2>/dev/null || echo ".")
    WORKERS_DIR="$MAIN_REPO/.claude/workers"
    OUT="$MAIN_REPO/claude_files/worker-tasks.html"
    mkdir -p "$(dirname "$OUT")"
    NOW_DISPLAY=$(date "+%Y-%m-%d %H:%M")

    # Aggregate all tasks.json into one blob: { "worker-name": { tasks... }, ... }
    COMBINED="{}"
    for tf in "$WORKERS_DIR"/*/tasks.json; do
      [ -f "$tf" ] || continue
      wname=$(basename "$(dirname "$tf")")
      COMBINED=$(echo "$COMBINED" | jq --arg w "$wname" --slurpfile t "$tf" '.[$w] = $t[0]')
    done

    # Grab worker state summaries from registry.json
    STATES="{}"
    if [ -f "$WORKERS_DIR/registry.json" ]; then
      STATES=$(jq '
        to_entries | map(select(.key != "_config")) |
        map({key: .key, value: {status: (.value.status // "unknown"), cycles_completed: (.value.cycles_completed // 0)}}) |
        from_entries
      ' "$WORKERS_DIR/registry.json" 2>/dev/null || echo "{}")
    fi

    cat > "$OUT" << 'DASHEOF'
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Worker Task Board</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0a0a; color: #d4d4d4; padding: 24px; }
  h1 { color: #c8a24e; font-size: 18px; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 12px; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; }
  .worker-card { background: #141414; border: 1px solid #222; padding: 16px; }
  .worker-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; border-bottom: 1px solid #222; padding-bottom: 8px; }
  .worker-name { color: #c8a24e; font-size: 14px; font-weight: 600; }
  .worker-stats { font-size: 11px; color: #666; }
  .stat-done { color: #4ade80; }
  .stat-wip { color: #facc15; }
  .stat-pending { color: #666; }
  .task-row { display: grid; grid-template-columns: 48px 64px 1fr 52px; gap: 8px; align-items: center; padding: 4px 0; font-size: 12px; border-bottom: 1px solid #1a1a1a; }
  .task-row:last-child { border-bottom: none; }
  .task-id { color: #555; }
  .priority-critical { color: #f87171; font-weight: 600; }
  .priority-high { color: #fb923c; }
  .priority-medium { color: #facc15; }
  .priority-low { color: #555; }
  .status-completed { color: #4ade80; }
  .status-in_progress { color: #facc15; }
  .status-pending { color: #555; }
  .status-blocked { color: #f87171; }
  .status-deleted { color: #333; text-decoration: line-through; }
  .deps { color: #444; font-size: 10px; margin-left: 4px; }
  .task-subject { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task-subject.completed { text-decoration: line-through; color: #444; }
  .task-subject.deleted { color: #333; text-decoration: line-through; }
  .active-form { display: block; color: #888; font-style: italic; font-size: 10px; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .recurring-badge { background: #2d2d00; color: #c8a24e; padding: 1px 5px; font-size: 10px; display: inline-block; }
  .meta-badge { background: #1a2a1a; color: #4ade80; padding: 1px 5px; font-size: 10px; display: inline-block; margin-left: 2px; cursor: default; }
  .owner { color: #555; font-size: 10px; }
  .summary-bar { display: flex; gap: 24px; margin-bottom: 20px; padding: 12px 16px; background: #141414; border: 1px solid #222; font-size: 12px; flex-wrap: wrap; align-items: center; }
  .summary-item { display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; display: inline-block; }
  .dot-done { background: #4ade80; }
  .dot-wip { background: #facc15; }
  .dot-pending { background: #555; }
  .dot-recurring { background: #c8a24e; }
  .empty-card { color: #444; font-size: 12px; font-style: italic; padding: 8px 0; }
  .show-deleted-btn { margin-left: auto; background: #1a1a1a; border: 1px solid #333; color: #666; padding: 3px 10px; font-size: 11px; cursor: pointer; font-family: inherit; }
  .show-deleted-btn:hover { border-color: #555; color: #999; }
</style>
</head>
<body>
<h1>Worker Task Board</h1>
<div class="subtitle" id="timestamp"></div>
<div class="summary-bar" id="summary"></div>
<div class="grid" id="board"></div>
<script>
DASHEOF

    # Inject data
    echo "const DATA = $COMBINED;" >> "$OUT"
    echo "const STATES = $STATES;" >> "$OUT"
    echo "const GENERATED = '$NOW_DISPLAY';" >> "$OUT"

    cat >> "$OUT" << 'DASHEOF2'
document.getElementById('timestamp').textContent = 'Generated: ' + GENERATED;

let showDeleted = false;
let totalPending = 0, totalWip = 0, totalDone = 0, totalRecurring = 0, totalBlocked = 0, totalDeleted = 0;
const board = document.getElementById('board');
const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
const statusOrder = { pending: 0, in_progress: 1, completed: 2, deleted: 3 };

function renderBoard() {
  board.innerHTML = '';
  const workers = Object.keys(DATA).sort();
  workers.forEach(worker => {
    const tasks = DATA[worker];
    const entries = Object.entries(tasks).sort((a, b) => {
      const sa = statusOrder[a[1].status] ?? 0, sb = statusOrder[b[1].status] ?? 0;
      if (sa !== sb) return sa - sb;
      return (priorityOrder[a[1].priority] ?? 2) - (priorityOrder[b[1].priority] ?? 2);
    });

    let pending = 0, wip = 0, done = 0, recurring = 0, blocked = 0, deleted = 0;
    entries.forEach(([, t]) => {
      const deps = t.blocked_by || [];
      t._blocked = deps.length > 0 && deps.some(d => tasks[d] && tasks[d].status !== 'completed');
      if (t.status === 'deleted') deleted++;
      else if (t.status === 'completed') done++;
      else if (t.status === 'in_progress') wip++;
      else if (t._blocked) blocked++;
      else pending++;
      if (t.recurring) recurring++;
    });

    const state = STATES[worker] || {};
    const card = document.createElement('div');
    card.className = 'worker-card';
    card.innerHTML = `
      <div class="worker-header">
        <span class="worker-name">${worker}</span>
        <span class="worker-stats">
          <span class="stat-done">${done}✓</span>
          <span class="stat-wip">${wip}⏳</span>
          <span class="stat-pending">${pending}○</span>
          ${blocked ? `<span style="color:#f87171">${blocked}⊘</span>` : ''}
          ${recurring ? `<span style="color:#c8a24e">${recurring}↻</span>` : ''}
          ${deleted ? `<span style="color:#333">${deleted}🗑</span>` : ''}
          ${state.status ? ` · ${state.status}` : ''}
        </span>
      </div>`;

    const visible = entries.filter(([, t]) => showDeleted || t.status !== 'deleted');
    if (visible.length === 0) {
      card.innerHTML += '<div class="empty-card">No tasks yet</div>';
    } else {
      visible.forEach(([id, t]) => {
        const row = document.createElement('div');
        row.className = 'task-row';
        const isDeleted = t.status === 'deleted';
        const effStatus = isDeleted ? 'deleted' : t._blocked ? 'blocked' : t.status;
        const statusLabel = isDeleted ? '🗑' : t._blocked ? '⊘' : t.status === 'in_progress' ? 'wip' : t.status === 'completed' ? 'done' : 'todo';
        const depsStr = (t.blocked_by || []).length > 0 ? `<span class="deps">← ${t.blocked_by.join(',')}</span>` : '';

        // Metadata tooltip
        const meta = t.metadata || {};
        const metaKeys = Object.keys(meta);
        const metaTitle = metaKeys.length > 0 ? metaKeys.map(k => `${k}=${meta[k]}`).join(' · ') : '';
        const metaBadge = metaKeys.length > 0 ? `<span class="meta-badge" title="${metaTitle.replace(/"/g,'&quot;')}">+${metaKeys.length}</span>` : '';

        // activeForm shown under subject when in_progress
        const activeFormHtml = (t.status === 'in_progress' && t.activeForm && t.activeForm !== `Working on: ${t.subject}`)
          ? `<span class="active-form" title="${(t.activeForm || '').replace(/"/g,'&quot;')}">${t.activeForm}</span>`
          : '';

        row.innerHTML = `
          <span class="task-id">${id}</span>
          <span class="priority-${t.priority}">${t.priority}</span>
          <span class="task-subject ${t.status === 'completed' ? 'completed' : isDeleted ? 'deleted' : ''}" title="${(t.description || '').replace(/"/g,'&quot;')}">
            ${t.subject}${t.recurring ? ' <span class="recurring-badge">↻</span>' : ''}${metaBadge}${depsStr}
            ${activeFormHtml}
          </span>
          <span class="status-${effStatus}">${statusLabel}${t.owner && t.owner !== 'null' && t.status === 'in_progress' ? ' ' + t.owner : ''}</span>`;
        card.appendChild(row);
      });
    }
    board.appendChild(card);
  });
}

// Count totals once
Object.keys(DATA).forEach(worker => {
  const tasks = DATA[worker];
  Object.values(tasks).forEach(t => {
    const deps = t.blocked_by || [];
    t._blocked = deps.length > 0 && deps.some(d => tasks[d] && tasks[d].status !== 'completed');
    if (t.status === 'deleted') totalDeleted++;
    else if (t.status === 'completed') totalDone++;
    else if (t.status === 'in_progress') totalWip++;
    else if (t._blocked) totalBlocked++;
    else totalPending++;
    if (t.recurring) totalRecurring++;
  });
});

function renderSummary() {
  document.getElementById('summary').innerHTML = `
    <span class="summary-item"><span class="dot dot-pending"></span> ${totalPending} ready</span>
    <span class="summary-item"><span class="dot dot-wip"></span> ${totalWip} in progress</span>
    <span class="summary-item"><span class="dot" style="background:#f87171"></span> ${totalBlocked} blocked</span>
    <span class="summary-item"><span class="dot dot-done"></span> ${totalDone} completed</span>
    <span class="summary-item"><span class="dot dot-recurring"></span> ${totalRecurring} recurring</span>
    ${totalDeleted ? `<span class="summary-item"><span class="dot" style="background:#333"></span> ${totalDeleted} deleted</span>` : ''}
    <span class="summary-item" style="margin-left:auto;color:#666">${Object.keys(DATA).length} workers</span>
    ${totalDeleted ? `<button class="show-deleted-btn" onclick="showDeleted=!showDeleted;this.textContent=showDeleted?'Hide deleted':'Show deleted';renderBoard()">${showDeleted ? 'Hide deleted' : 'Show deleted'}</button>` : ''}`;
}

renderSummary();
renderBoard();
</script>
</body>
</html>
DASHEOF2

    echo "Dashboard → $OUT"
    open "$OUT" 2>/dev/null || echo "Open: file://$OUT"
    ;;

  *)
    echo "Usage: worker-task.sh <add|claim|complete|delete|list|next|dashboard> [args...]"
    echo ""
    echo "Commands:"
    echo "  add \"Subject\" [--priority P] [--desc \"...\"] [--active \"Spinner label…\"]"
    echo "               [--recurring] [--after T001,T002] [--blocks T003,T004]"
    echo "               [--meta key=val] [--meta key2=val2]"
    echo "  claim <task-id>         Claim a task (fails if blocked by incomplete deps)"
    echo "  complete <task-id>      Mark task as completed (recurring: resets to pending)"
    echo "  delete <task-id>        Soft-delete a task (hidden from list/next by default)"
    echo "  list [--pending|--mine|--blocked] [--all]  Show tasks (--all includes deleted)"
    echo "  next                    Show first unblocked, unclaimed task by priority"
    echo "  dashboard               Generate HTML task board for all workers"
    exit 1
    ;;
esac
