#!/usr/bin/env bash
# worker-message.sh — Inter-worker messaging via tmux pane registry.
# Mirrors Claude's built-in SendMessage API (send / broadcast / shutdown).
#
# Usage:
#   worker-message.sh send <worker-name> "<content>" [--summary "short preview"]
#   worker-message.sh broadcast "<content>" [--primary-only] [--summary "short preview"]
#   worker-message.sh shutdown <worker-name> ["<reason>"]
#   worker-message.sh list                  # show all registered workers + panes
#
# Workers are identified by name (e.g. "chatbot-tools").
# Pane resolution checks registry.json (flat workers) FIRST, then pane-registry.json (legacy).
#
# Delivery is two-layer:
#   1. Instant  — tmux send-keys (best-effort, fires even if bus unavailable)
#   2. Durable  — bus_publish "cell-message" → side-effects:
#                   notify_assignee  → recipient's inbox.jsonl (survives worker sleep)
#                   append_outbox    → sender's outbox.jsonl (audit trail)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/fleet-jq.sh"

# Source event-bus.sh for bus_publish (gracefully degrades if unavailable)
_BUS_LIB="${CLAUDE_OPS_DIR:-${CLAUDE_OPS_DIR:-$HOME/.claude-ops}}/lib/event-bus.sh"
_BUS_AVAILABLE="false"
if [ -f "$_BUS_LIB" ]; then
  source "$_BUS_LIB" 2>/dev/null && _BUS_AVAILABLE="true" || true
fi

# ── Flat registry (project-level registry.json — primary source for flat workers) ──
# PROJECT_ROOT is passed as env var by the MCP when calling this script.
FLAT_REGISTRY="${PROJECT_ROOT:+$PROJECT_ROOT/.claude/workers/registry.json}"

# ── Detect own pane ID + display target ──
_own_pane_id() {
  tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | while read pid id; do
    p=$PPID
    while [ "$p" -gt 1 ]; do
      [ "$p" = "$pid" ] && echo "$id" && return 0
      p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    done
  done
}

OWN_PANE=$(_own_pane_id 2>/dev/null || true)
OWN_TARGET=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
  | awk -v id="$OWN_PANE" '$1 == id {print $2; exit}')

# Resolve own name: registry.json first (flat workers), then pane-registry.json
OWN_NAME=""
if [ -n "${TMUX_PANE:-}" ] && [ -n "${FLAT_REGISTRY:-}" ] && [ -f "$FLAT_REGISTRY" ]; then
  OWN_NAME=$(jq -r --arg pane "$TMUX_PANE" \
    'to_entries[] | select(.value.pane_id == $pane) | .key' \
    "$FLAT_REGISTRY" 2>/dev/null | head -1 || true)
fi
if [ -z "${OWN_NAME:-}" ] && [ -n "${OWN_PANE:-}" ] && [ -f "$PANE_REGISTRY" ]; then
  OWN_NAME=$(jq -r --arg p "$OWN_PANE" \
    '(.panes[$p].worker // (.[$p].harness // "" | ltrimstr("worker/"))) | select(. != "")' \
    "$PANE_REGISTRY" 2>/dev/null || true)
fi

# Resolve parent for child panes — pane-registry.json only (flat workers have no children)
PARENT_PANE=$(jq -r --arg p "$OWN_PANE" '(.panes[$p].parent_pane // .[$p].parent_pane // "") | select(. != "")' "$PANE_REGISTRY" 2>/dev/null || echo "")
PARENT_NAME=""
[ -n "$PARENT_PANE" ] && \
  PARENT_NAME=$(jq -r --arg p "$PARENT_PANE" '(.panes[$p].worker // (.[$p].harness // "" | ltrimstr("worker/"))) | select(. != "")' "$PANE_REGISTRY" 2>/dev/null || echo "")

# Bus identity: "worker/$name" for worker panes, "operator" for human/main session
FROM="${OWN_NAME:+worker/$OWN_NAME}"
FROM="${FROM:-operator}"

# Resolve own project root: PROJECT_ROOT env var (set by MCP) takes priority
OWN_PROJECT="${PROJECT_ROOT:-}"
if [ -z "$OWN_PROJECT" ] && [ -n "${OWN_NAME:-}" ] && [ -f "$PANE_REGISTRY" ]; then
  OWN_PROJECT=$(jq -r --arg wn "$OWN_NAME" \
    '[.workers | to_entries[] | select(.key | endswith(":" + $wn))] | first | .value.project_root // ""' \
    "$PANE_REGISTRY" 2>/dev/null || echo "")
fi
[ -z "$OWN_PROJECT" ] && [ -n "${OWN_PANE:-}" ] && [ -f "$PANE_REGISTRY" ] && \
  OWN_PROJECT=$(jq -r --arg p "$OWN_PANE" '.[$p].project_root // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")

# Fallback signature — used only when bus is unavailable
if [ -n "$PARENT_NAME" ]; then
  _FALLBACK_SIG="[from ${OWN_TARGET:-?} (child of ${PARENT_NAME})]"
elif [ -n "$OWN_NAME" ]; then
  _FALLBACK_SIG="[from ${OWN_TARGET:-?} (${OWN_NAME})]"
else
  _FALLBACK_SIG="[from ${OWN_TARGET:-?}]"
fi

# ── Durable bus emit (cell-message → notify_assignee side-effect; MCP handles inbox + tmux delivery) ──
# $1=to (e.g. "worker/chatbot-tools")  $2=content  $3=summary  [$4=msg_type override]
_bus_emit() {
  [ "$_BUS_AVAILABLE" = "false" ] && return 1
  local to="$1" content="$2" summary="${3:-}" msg_type="${4:-message}"
  local payload
  local own_project
  own_project=$(jq -r --arg p "$OWN_PANE" '.[$p].project_root // ""' "$PANE_REGISTRY" 2>/dev/null || echo "")
  payload=$(jq -nc \
    --arg to "$to" \
    --arg from "$FROM" \
    --arg from_pane "$OWN_PANE" \
    --arg from_target "$OWN_TARGET" \
    --arg from_name "$OWN_NAME" \
    --arg from_parent_name "$PARENT_NAME" \
    --arg from_project "$own_project" \
    --arg content "$content" \
    --arg summary "$summary" \
    --arg msg_type "$msg_type" \
    '{to:$to, from:$from, from_pane:$from_pane, from_target:$from_target,
      from_name:$from_name, from_parent_name:$from_parent_name,
      from_project:$from_project,
      content:$content, summary:$summary, msg_type:$msg_type, channel:"worker-message"}')
  bus_publish "cell-message" "$payload" 2>/dev/null || true
}

# ── Resolve worker name → pane_id ──
# Checks registry.json (flat workers) FIRST, then pane-registry.json (legacy harness).
_worker_pane() {
  local name="$1"
  local result=""

  # PRIMARY: registry.json (flat workers — new system)
  if [ -n "${FLAT_REGISTRY:-}" ] && [ -f "$FLAT_REGISTRY" ]; then
    result=$(jq -r --arg n "$name" '.[$n].pane_id // ""' "$FLAT_REGISTRY" 2>/dev/null || echo "")
  fi

  # FALLBACK: pane-registry.json (legacy harness workers)
  if [ -z "${result:-}" ] && [ -f "$PANE_REGISTRY" ]; then
    # Try panes section first (unified format) — match worker name + project scope
    if [ -n "${OWN_PROJECT:-}" ]; then
      result=$(jq -r --arg wn "$name" \
        '.panes | to_entries[] | select(.value.worker == $wn and .value.role == "worker") | .key' \
        "$PANE_REGISTRY" 2>/dev/null | head -1)
    fi
    # Flat entries — match harness AND project_root
    if [ -z "${result:-}" ]; then
      result=$(jq -r --arg h "worker/$name" --arg proj "${OWN_PROJECT:-}" \
        'to_entries[] | select(.key | startswith("%")) | select(.value.harness == $h and ((.value.project_root // "") == $proj or $proj == "")) | .key' \
        "$PANE_REGISTRY" 2>/dev/null | head -1)
    fi
  fi

  echo "${result:-}"
}

# ── Resolve pane_id → tmux target (e.g. w:1.0) ──
_pane_target() {
  local pane_id="$1"
  tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
    | awk -v id="$pane_id" '$1 == id {print $2; exit}'
}

CMD="${1:-help}"
shift 2>/dev/null || true

case "$CMD" in
  send)
    RECIPIENT="${1:?Usage: worker-message.sh send <worker-name> \"<content>\" [--summary \"...\"]}"
    shift
    CONTENT="${1:?Missing message content}"
    shift
    SUMMARY=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --summary|-s) SUMMARY="$2"; shift 2 ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
      esac
    done

    PANE_ID=$(_worker_pane "$RECIPIENT")
    [ -z "$PANE_ID" ] && {
      echo "ERROR: Worker '$RECIPIENT' not found in pane registry." >&2
      echo "Run 'worker-message.sh list' to see registered workers." >&2
      exit 1
    }
    TARGET=$(_pane_target "$PANE_ID")
    [ -z "$TARGET" ] && {
      echo "ERROR: Worker '$RECIPIENT' pane $PANE_ID has no active tmux target (may have exited)." >&2
      exit 1
    }

    # Always do tmux instant delivery
    tmux send-keys -t "$TARGET" "$_FALLBACK_SIG $CONTENT" 2>/dev/null || true
    tmux send-keys -t "$TARGET" -H 0d 2>/dev/null || true
    # Also emit to bus for durable side-effects (best-effort)
    _bus_emit "worker/$RECIPIENT" "$CONTENT" "$SUMMARY" || true
    echo "Sent to $RECIPIENT ($TARGET)${SUMMARY:+ — $SUMMARY}"
    ;;

  broadcast)
    CONTENT="${1:?Usage: worker-message.sh broadcast \"<content>\" [--primary-only] [--summary \"...\"]}"
    shift
    SUMMARY=""
    PRIMARY_ONLY="false"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --summary|-s)      SUMMARY="$2"; shift 2 ;;
        --primary-only|-P) PRIMARY_ONLY="true"; shift ;;
        *) echo "Unknown flag: $1" >&2; exit 1 ;;
      esac
    done

    # By default: send to all worker panes AND registered children (parent_pane ∈ worker IDs).
    # With --primary-only: send only to root harness panes (harness="worker/$name").
    # Scoped by project: only broadcast to workers in the same project as the sender.
    SENT=0
    if [ "$PRIMARY_ONLY" = "true" ]; then
      JQ_FILTER='to_entries[]
        | select(.value.harness | startswith("worker/"))
        | select(($proj == "") or ((.value.project_root // "") == $proj) or ((.value.project_root // "") == ""))
        | [.key, (.value.harness | ltrimstr("worker/"))]
        | @tsv'
    else
      JQ_FILTER='
        (to_entries | map(select(.value.harness | startswith("worker/"))) | map(.key)) as $wids |
        to_entries[]
        | select(
            ((.value.harness | startswith("worker/"))
              and (($proj == "") or ((.value.project_root // "") == $proj) or ((.value.project_root // "") == "")))
            or ((.value.parent_pane // "") as $p | $p != "" and ([$p] | inside($wids)))
          )
        | [.key, (.value.harness // ("child:" + (.value.parent_pane // "?")))]
        | @tsv'
    fi

    # 1) Legacy harness workers from pane-registry.json
    while IFS=$'\t' read -r pane_id name; do
      [ "$pane_id" = "$OWN_PANE" ] && continue
      TARGET=$(_pane_target "$pane_id")
      if [ -z "$TARGET" ]; then
        echo "  ⚠ $name ($pane_id): no active pane (skipped)"
        continue
      fi
      # Strip harness prefix to get plain worker name; child panes keep pane_id as to
      local_name="${name#worker/}"
      local_name="${local_name#child:}"
      local bus_to
      if [[ "$local_name" == %* ]]; then
        bus_to="$local_name"   # bare pane ID — deliver_tmux resolves directly
      else
        bus_to="worker/$local_name"
      fi
      # Always do tmux instant delivery
      tmux send-keys -t "$TARGET" "$_FALLBACK_SIG $CONTENT" 2>/dev/null || true
      tmux send-keys -t "$TARGET" -H 0d 2>/dev/null || true
      # Also emit to bus for durable side-effects (best-effort)
      _bus_emit "$bus_to" "$CONTENT" "$SUMMARY" "broadcast" || true
      echo "  → $name ($TARGET)"
      SENT=$((SENT + 1))
    done < <(jq -r --arg proj "$OWN_PROJECT" "$JQ_FILTER" "$PANE_REGISTRY" 2>/dev/null | sort -u)

    # 2) Flat workers from registry.json (primary source for new-style workers)
    if [ -n "${FLAT_REGISTRY:-}" ] && [ -f "$FLAT_REGISTRY" ]; then
      while IFS=$'\t' read -r pane_id worker_name; do
        if [ -z "$pane_id" ] || [ "$pane_id" = "null" ]; then continue; fi
        [ "$pane_id" = "$OWN_PANE" ] && continue
        TARGET=$(_pane_target "$pane_id")
        if [ -z "$TARGET" ]; then
          echo "  ⚠ $worker_name ($pane_id): no active pane (skipped)"
          continue
        fi
        tmux send-keys -t "$TARGET" "$_FALLBACK_SIG $CONTENT" 2>/dev/null || true
        tmux send-keys -t "$TARGET" -H 0d 2>/dev/null || true
        _bus_emit "worker/$worker_name" "$CONTENT" "$SUMMARY" "broadcast" || true
        echo "  → $worker_name ($TARGET)"
        SENT=$((SENT + 1))
      done < <(jq -r 'to_entries[] | select(.value.pane_id != null and .value.pane_id != "") | [.value.pane_id, .key] | @tsv' "$FLAT_REGISTRY" 2>/dev/null)
    fi

    SCOPE=$( [ "$PRIMARY_ONLY" = "true" ] && echo "primary workers" || echo "workers + children" )
    echo "Broadcast to $SENT $SCOPE${SUMMARY:+ — $SUMMARY}"
    ;;

  shutdown)
    RECIPIENT="${1:?Usage: worker-message.sh shutdown <worker-name> [\"<reason>\"]}"
    shift
    REASON="${1:-Your task is complete. Please wrap up and stop.}"

    PANE_ID=$(_worker_pane "$RECIPIENT")
    [ -z "$PANE_ID" ] && {
      echo "ERROR: Worker '$RECIPIENT' not found in pane registry." >&2
      exit 1
    }
    TARGET=$(_pane_target "$PANE_ID")
    [ -z "$TARGET" ] && {
      echo "ERROR: Worker '$RECIPIENT' pane $PANE_ID has no active tmux target." >&2
      exit 1
    }

    MSG="SHUTDOWN REQUEST: Please wrap up your current task and stop. Reason: $REASON"
    # Always do tmux instant delivery
    tmux send-keys -t "$TARGET" "$_FALLBACK_SIG $MSG" 2>/dev/null || true
    tmux send-keys -t "$TARGET" -H 0d 2>/dev/null || true
    # Also emit to bus for durable side-effects (best-effort)
    _bus_emit "worker/$RECIPIENT" "$MSG" "shutdown" "shutdown" || true
    echo "Shutdown request sent to $RECIPIENT ($TARGET)"
    ;;

  list)
    echo "Registered workers + children:"
    echo ""
    { printf "WORKER\tPANE_ID\tTARGET\tTYPE\n"
      # Flat workers from registry.json (primary — new system)
      [ -n "${FLAT_REGISTRY:-}" ] && [ -f "$FLAT_REGISTRY" ] && \
        jq -r 'to_entries[] | [.key, (.value.pane_id // "?"), (.value.pane_target // "?"), "flat"] | @tsv' \
          "$FLAT_REGISTRY" 2>/dev/null | sort
      # Legacy harness workers from pane-registry.json
      jq -r '
        (to_entries | map(select(.value.harness | startswith("worker/"))) | map(.key)) as $wids |
        to_entries[]
        | select(
            (.value.harness | startswith("worker/"))
            or ((.value.parent_pane // "") as $p | $p != "" and ([$p] | inside($wids)))
          )
        | [
            (.value.harness // ("child-of:" + (.value.parent_pane // "?")) | ltrimstr("worker/")),
            .key,
            (.value.pane_target // "?"),
            (if (.value.harness | startswith("worker/")) then "legacy" else "child" end)
          ]
        | @tsv' "$PANE_REGISTRY" 2>/dev/null | sort
    } | column -t -s $'\t' || echo "(none registered)"
    echo ""
    echo "Tip: 'worker-message.sh send <WORKER> \"message\"' (use WORKER name column)"
    ;;

  help|*)
    echo "Usage: worker-message.sh <send|broadcast|shutdown|list>"
    echo ""
    echo "Commands:"
    echo "  send <worker> \"<msg>\" [--summary \"...\"]    DM a specific worker by name"
    echo "  broadcast \"<msg>\" [--summary \"...\"]        Send same message to all workers"
    echo "  shutdown <worker> [\"<reason>\"]              Request graceful stop"
    echo "  list                                        Show all registered workers"
    echo ""
    echo "Examples:"
    echo "  worker-message.sh send chief-of-staff \"Branch worker/chatbot-tools is ready for merge\""
    echo "  worker-message.sh broadcast \"Deploying to test — hold off on prod pushes\""
    echo "  worker-message.sh shutdown ui-patrol \"Regression sweep complete\""
    echo "  worker-message.sh list"
    exit 0
    ;;
esac
