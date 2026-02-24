#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# report-issue.sh — Structured issue reporting for agents
# ══════════════════════════════════════════════════════════════════
# Any agent (sweep, harness worker, monitor) can call this to file
# a structured issue. Issues are stored in claude_files/agent-issues.jsonl
# and a wisp is emitted to harness-beads.json for visibility.
#
# Usage:
#   report-issue --title "Short description" \
#     --severity "medium" \
#     --category "permissions" \
#     --description "Detailed description" \
#     [--harness "name"] \
#     [--file "/path/if/relevant"] \
#     [--project "/path/to/project"]
#
# Categories: permissions, config, bug, infra, suggestion
# Severities: low, medium, high, critical
#
# Good issue writing:
#   - Title: what happened (not what you expected)
#   - Description: what you were doing, what went wrong, what you expected
#   - Include the exact error message or behavior
#   - Include the file path / command that failed
#   - Suggest a fix if you have one
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Defaults ───────────────────────────────────────────────────
TITLE=""
SEVERITY=""
CATEGORY=""
DESCRIPTION=""
HARNESS=""
FILE_PATH=""
PROJECT_ROOT=""

# ── CLI parsing ────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --title)       TITLE="$2"; shift 2 ;;
    --severity)    SEVERITY="$2"; shift 2 ;;
    --category)    CATEGORY="$2"; shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --harness)     HARNESS="$2"; shift 2 ;;
    --file)        FILE_PATH="$2"; shift 2 ;;
    --project)     PROJECT_ROOT="$2"; shift 2 ;;
    --help|-h)
      cat <<'HELP'
report-issue — Structured issue reporting for agents

Usage:
  report-issue --title "Short description" \
    --severity "medium" \
    --category "permissions" \
    --description "Detailed description" \
    [--harness "name"] \
    [--file "/path/if/relevant"] \
    [--project "/path/to/project"]

Required:
  --title        What happened (short, descriptive)
  --severity     low | medium | high | critical
  --category     permissions | config | bug | infra | suggestion
  --description  Detailed context: what you were doing, what went wrong,
                 exact error message, file/command that failed, suggested fix

Optional:
  --harness      Which harness encountered the issue
  --file         File path relevant to the issue
  --project      Project root (default: auto-detect from manifests)

Good issue writing:
  - Title: what happened (not what you expected)
  - Description: what you were doing, what went wrong, what you expected
  - Include the exact error message or behavior
  - Include the file path / command that failed
  - Suggest a fix if you have one

Examples:
  report-issue --title "Permission denied writing reflections" \
    --severity medium --category permissions \
    --description "Write(**/claude_files/*-reflections.jsonl) pattern doesn't match new file creation"

  report-issue --title "Bastion SSH timeout during meta-reflect" \
    --severity low --category infra \
    --harness meta-reflect \
    --description "SSH to bastion hung for 30s during context gathering. Workaround: skipped MySQL check."
HELP
      exit 0
      ;;
    *) echo "Unknown arg: $1. Use --help for usage." >&2; exit 1 ;;
  esac
done

# ── Validate required fields ──────────────────────────────────
missing=()
[ -z "$TITLE" ] && missing+=("--title")
[ -z "$SEVERITY" ] && missing+=("--severity")
[ -z "$CATEGORY" ] && missing+=("--category")
[ -z "$DESCRIPTION" ] && missing+=("--description")

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: Missing required arguments: ${missing[*]}" >&2
  echo "Use --help for usage." >&2
  exit 1
fi

# ── Validate enum values ──────────────────────────────────────
case "$SEVERITY" in
  low|medium|high|critical) ;;
  *) echo "ERROR: Invalid severity '$SEVERITY'. Must be: low|medium|high|critical" >&2; exit 1 ;;
esac

case "$CATEGORY" in
  permissions|config|bug|infra|suggestion) ;;
  *) echo "ERROR: Invalid category '$CATEGORY'. Must be: permissions|config|bug|infra|suggestion" >&2; exit 1 ;;
esac

# ── Resolve project root ──────────────────────────────────────
if [ -z "$PROJECT_ROOT" ]; then
  # Try to find from active harness manifests
  source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || true
  if command -v harness_list_active &>/dev/null; then
    # harness_list_active returns "name|root|progress" per line
    first_active=$(harness_list_active 2>/dev/null | head -1 || true)
    if [ -n "$first_active" ]; then
      first_name=$(echo "$first_active" | cut -d'|' -f1)
      PROJECT_ROOT=$(harness_project_root "$first_name" 2>/dev/null) || true
    fi
  fi
  # Fallback to Wechat project
  [ -z "$PROJECT_ROOT" ] && PROJECT_ROOT="/Users/wz/Desktop/zPersonalProjects/Wechat"
fi

# ── Generate issue ID ─────────────────────────────────────────
TIMESTAMP=$(date +%s)
RANDOM_SUFFIX=$(xxd -l 4 -p /dev/urandom | cut -c1-4)
ISSUE_ID="issue-${TIMESTAMP}-${RANDOM_SUFFIX}"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# ── Detect reporter identity ──────────────────────────────────
REPORTER=""
# Check if we're in a sweep context
if [ -n "${SWEEP_NAME:-}" ]; then
  REPORTER="sweep:${SWEEP_NAME}"
elif [ -n "$HARNESS" ]; then
  REPORTER="harness:${HARNESS}"
else
  # Try to detect from tmux pane (walk process tree, not display-message which returns focused pane)
  _find_own_pane() {
    local search_pid=$$
    local pane_map=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null)
    [ -z "$pane_map" ] && return 1
    while [ "$search_pid" -gt 1 ]; do
      local match=$(echo "$pane_map" | awk -v pid="$search_pid" '$1 == pid {print $2; exit}')
      [ -n "$match" ] && { echo "$match"; return 0; }
      search_pid=$(ps -o ppid= -p "$search_pid" 2>/dev/null | tr -d ' ')
    done
    return 1
  }
  _pane_id_to_target() {
    tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
      | awk -v id="$1" '$1 == id {print $2; exit}'
  }
  PANE_ID=$(_find_own_pane 2>/dev/null || echo "")
  if [ -n "$PANE_ID" ]; then
    META_FILE="/tmp/tmux_pane_meta_${PANE_ID}"
    if [ -f "$META_FILE" ]; then
      harness_from_meta=$(jq -r '.harness // empty' "$META_FILE" 2>/dev/null)
      if [ -n "$harness_from_meta" ]; then
        REPORTER="harness:${harness_from_meta}"
      fi
    fi
    # Fallback: use pane coordinates
    if [ -z "$REPORTER" ]; then
      PANE_TARGET=$(_pane_id_to_target "$PANE_ID" 2>/dev/null || echo "unknown")
      REPORTER="agent:${PANE_TARGET}"
    fi
  fi
fi
[ -z "$REPORTER" ] && REPORTER="unknown"

# ── Build context object ──────────────────────────────────────
PANE_TARGET=$(_pane_id_to_target "${PANE_ID:-}" 2>/dev/null || echo "")
SESSION_ID="${CLAUDE_SESSION_ID:-}"

# ── Write issue to JSONL ──────────────────────────────────────
ISSUES_FILE="$PROJECT_ROOT/claude_files/agent-issues.jsonl"
mkdir -p "$(dirname "$ISSUES_FILE")"

jq -n -c \
  --arg id "$ISSUE_ID" \
  --arg ts "$TS" \
  --arg reporter "$REPORTER" \
  --arg title "$TITLE" \
  --arg severity "$SEVERITY" \
  --arg category "$CATEGORY" \
  --arg description "$DESCRIPTION" \
  --arg harness "$HARNESS" \
  --arg pane "$PANE_TARGET" \
  --arg session_id "$SESSION_ID" \
  --arg file "$FILE_PATH" \
  '{
    id: $id,
    ts: $ts,
    reporter: $reporter,
    title: $title,
    severity: $severity,
    category: $category,
    description: $description,
    harness: (if $harness != "" then $harness else null end),
    context: {
      pane: (if $pane != "" then $pane else null end),
      session_id: (if $session_id != "" then $session_id else null end),
      file: (if $file != "" then $file else null end)
    },
    status: "open",
    resolution: null
  }' >> "$ISSUES_FILE"

# ── Emit wisp ─────────────────────────────────────────────────
BEAD_SCRIPT="$HOME/.claude-ops/lib/bead.sh"
if [ -f "$BEAD_SCRIPT" ]; then
  WISP_MSG="[${SEVERITY}] ${CATEGORY}: ${TITLE}"
  bash "$BEAD_SCRIPT" wisp "$REPORTER" "$WISP_MSG" "issue-triage" 2>/dev/null || true
fi

# ── Output ────────────────────────────────────────────────────
echo "$ISSUE_ID"
