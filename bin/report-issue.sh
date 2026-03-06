#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# report-issue.sh — Structured issue & feature request reporting
# ══════════════════════════════════════════════════════════════════
# Any agent (sweep, harness worker, monitor) can call this to file
# a structured issue or feature request.
#
# Bug reports: stored in claude_files/agent-issues.jsonl (per-project)
# Feature requests: stored in ~/.claude-ops/state/feature-requests.jsonl (global)
#
# Usage (bug report — default):
#   report-issue --title "Short description" \
#     --severity "medium" \
#     --category "permissions" \
#     --description "Detailed description" \
#     [--harness "name"] \
#     [--file "/path/if/relevant"] \
#     [--project "/path/to/project"]
#
# Usage (feature request):
#   report-issue --type feature \
#     --title "Short description" \
#     --description "Detailed description" \
#     [--priority "high"] \
#     [--category "infra"] \
#     [--harness "name"]
#
# Bug categories: permissions, config, bug, infra, suggestion
# Bug severities: low, medium, high, critical
# Feature priorities: low, medium, high
# ══════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Defaults ───────────────────────────────────────────────────
REPORT_TYPE="bug"
TITLE=""
SEVERITY=""
PRIORITY=""
CATEGORY=""
DESCRIPTION=""
HARNESS=""
FILE_PATH=""
PROJECT_ROOT=""
GITHUB=false
DRY_RUN=false
GITHUB_REPO="${CLAUDE_OPS_GITHUB_REPO:-qbg-dev/claude-ops}"

# ── CLI parsing ────────────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --type)        REPORT_TYPE="$2"; shift 2 ;;
    --title)       TITLE="$2"; shift 2 ;;
    --severity)    SEVERITY="$2"; shift 2 ;;
    --priority)    PRIORITY="$2"; shift 2 ;;
    --category)    CATEGORY="$2"; shift 2 ;;
    --description) DESCRIPTION="$2"; shift 2 ;;
    --harness)     HARNESS="$2"; shift 2 ;;
    --file)        FILE_PATH="$2"; shift 2 ;;
    --project)     PROJECT_ROOT="$2"; shift 2 ;;
    --github)      GITHUB=true; shift ;;
    --dry-run)     DRY_RUN=true; shift ;;
    --repo)        GITHUB_REPO="$2"; shift 2 ;;
    --help|-h)
      cat <<'HELP'
report-issue — Structured issue & feature request reporting

Usage (bug report — default):
  report-issue --title "Short description" \
    --severity "medium" \
    --category "permissions" \
    --description "Detailed description" \
    [--harness "name"] [--file "/path"] [--project "/path"]

Usage (feature request):
  report-issue --type feature \
    --title "Short description" \
    --description "Detailed description" \
    [--priority "high"] [--category "infra"] [--harness "name"]

Bug required:  --title, --severity, --category, --description
Feature required: --title, --description
Feature optional: --priority (default: medium), --category

Categories: permissions, config, bug, infra, suggestion
Severities: low, medium, high, critical
Priorities: low, medium, high

Examples:
  # Bug report
  report-issue --title "Permission denied writing reflections" \
    --severity medium --category permissions \
    --description "Write pattern doesn't match new file creation"

  # Feature request
  report-issue --type feature \
    --title "Add --dry-run to all sweeps" \
    --description "Each sweep should support --dry-run" \
    --priority high
HELP
      exit 0
      ;;
    *) echo "Unknown arg: $1. Use --help for usage." >&2; exit 1 ;;
  esac
done

# ── Validate type ────────────────────────────────────────────
case "$REPORT_TYPE" in
  bug|feature) ;;
  *) echo "ERROR: Invalid type '$REPORT_TYPE'. Must be: bug|feature" >&2; exit 1 ;;
esac

# ── Validate required fields (depends on type) ──────────────
missing=()
[ -z "$TITLE" ] && missing+=("--title")
[ -z "$DESCRIPTION" ] && missing+=("--description")

if [ "$REPORT_TYPE" = "bug" ]; then
  [ -z "$SEVERITY" ] && missing+=("--severity")
  [ -z "$CATEGORY" ] && missing+=("--category")
fi

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: Missing required arguments: ${missing[*]}" >&2
  echo "Use --help for usage." >&2
  exit 1
fi

# ── Validate enum values ──────────────────────────────────────
if [ "$REPORT_TYPE" = "bug" ]; then
  case "$SEVERITY" in
    low|medium|high|critical) ;;
    *) echo "ERROR: Invalid severity '$SEVERITY'. Must be: low|medium|high|critical" >&2; exit 1 ;;
  esac

  case "$CATEGORY" in
    permissions|config|bug|infra|suggestion) ;;
    *) echo "ERROR: Invalid category '$CATEGORY'. Must be: permissions|config|bug|infra|suggestion" >&2; exit 1 ;;
  esac
fi

if [ "$REPORT_TYPE" = "feature" ]; then
  [ -z "$PRIORITY" ] && PRIORITY="medium"
  case "$PRIORITY" in
    low|medium|high) ;;
    *) echo "ERROR: Invalid priority '$PRIORITY'. Must be: low|medium|high" >&2; exit 1 ;;
  esac
  # Category is optional for features
  if [ -n "$CATEGORY" ]; then
    case "$CATEGORY" in
      permissions|config|bug|infra|suggestion) ;;
      *) echo "ERROR: Invalid category '$CATEGORY'. Must be: permissions|config|bug|infra|suggestion" >&2; exit 1 ;;
    esac
  fi
fi

# ── Resolve project root (bugs only — features are global) ───
if [ "$REPORT_TYPE" = "bug" ] && [ -z "$PROJECT_ROOT" ]; then
  source "$HOME/.claude-ops/lib/fleet-jq.sh" 2>/dev/null || true
  if command -v harness_list_active &>/dev/null; then
    first_active=$(harness_list_active 2>/dev/null | head -1 || true)
    if [ -n "$first_active" ]; then
      first_name=$(echo "$first_active" | cut -d'|' -f1)
      PROJECT_ROOT=$(harness_project_root "$first_name" 2>/dev/null) || true
    fi
  fi
  [ -z "$PROJECT_ROOT" ] && PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
fi

# ── Generate ID ──────────────────────────────────────────────
TIMESTAMP=$(date +%s)
RANDOM_SUFFIX=$(xxd -l 4 -p /dev/urandom | cut -c1-4)
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$REPORT_TYPE" = "feature" ]; then
  RECORD_ID="feat-${TIMESTAMP}-${RANDOM_SUFFIX}"
else
  RECORD_ID="issue-${TIMESTAMP}-${RANDOM_SUFFIX}"
fi

# ── Detect reporter identity ──────────────────────────────────
REPORTER=""
if [ -n "${SWEEP_NAME:-}" ]; then
  REPORTER="sweep:${SWEEP_NAME}"
elif [ -n "$HARNESS" ]; then
  REPORTER="harness:${HARNESS}"
else
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
    _PANE_REGISTRY="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}/pane-registry.json"
    if [ -f "$_PANE_REGISTRY" ]; then
      harness_from_meta=$(jq -r --arg pid "$PANE_ID" '.[$pid].harness // empty' "$_PANE_REGISTRY" 2>/dev/null)
      if [ -n "$harness_from_meta" ]; then
        REPORTER="harness:${harness_from_meta}"
      fi
    fi
    if [ -z "$REPORTER" ]; then
      PANE_TARGET=$(_pane_id_to_target "$PANE_ID" 2>/dev/null || echo "unknown")
      REPORTER="agent:${PANE_TARGET}"
    fi
  fi
fi
[ -z "$REPORTER" ] && REPORTER="unknown"

# ── Build context ─────────────────────────────────────────────
PANE_TARGET=$(_pane_id_to_target "${PANE_ID:-}" 2>/dev/null || echo "")
SESSION_ID="${CLAUDE_SESSION_ID:-}"

# ── Write record ─────────────────────────────────────────────
if [ "$REPORT_TYPE" = "feature" ]; then
  # Feature requests go to global state file
  OUTPUT_FILE="$HOME/.claude-ops/state/feature-requests.jsonl"
  mkdir -p "$(dirname "$OUTPUT_FILE")"

  jq -n -c \
    --arg id "$RECORD_ID" \
    --arg ts "$TS" \
    --arg type "feature-request" \
    --arg reporter "$REPORTER" \
    --arg title "$TITLE" \
    --arg description "$DESCRIPTION" \
    --arg priority "$PRIORITY" \
    --arg category "$CATEGORY" \
    --arg harness "$HARNESS" \
    '{
      id: $id,
      ts: $ts,
      type: $type,
      reporter: $reporter,
      title: $title,
      description: $description,
      priority: $priority,
      category: (if $category != "" then $category else null end),
      harness: (if $harness != "" then $harness else null end),
      status: "open",
      resolution: null
    }' >> "$OUTPUT_FILE"
else
  # Bug reports go to per-project issues file
  OUTPUT_FILE="$PROJECT_ROOT/claude_files/agent-issues.jsonl"
  mkdir -p "$(dirname "$OUTPUT_FILE")"

  jq -n -c \
    --arg id "$RECORD_ID" \
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
    }' >> "$OUTPUT_FILE"
fi

# ── GitHub issue creation ─────────────────────────────────────
if [ "$GITHUB" = "true" ]; then
  if ! command -v gh &>/dev/null; then
    echo "WARN: gh CLI not found — skipping GitHub issue creation" >&2
  else
    # Map severity/priority to GitHub labels
    GH_LABELS=""
    if [ "$REPORT_TYPE" = "bug" ]; then
      case "$SEVERITY" in
        critical) GH_LABELS="bug,priority:critical" ;;
        high)     GH_LABELS="bug,priority:high" ;;
        medium)   GH_LABELS="bug" ;;
        low)      GH_LABELS="bug,priority:low" ;;
      esac
      [ -n "$CATEGORY" ] && [ "$CATEGORY" != "bug" ] && GH_LABELS="${GH_LABELS},${CATEGORY}"
    else
      case "$PRIORITY" in
        high)   GH_LABELS="enhancement,priority:high" ;;
        medium) GH_LABELS="enhancement" ;;
        low)    GH_LABELS="enhancement,priority:low" ;;
      esac
    fi

    # Build structured body
    _TYPE_LABEL="Bug"
    [ "$REPORT_TYPE" = "feature" ] && _TYPE_LABEL="Feature"
    GH_BODY="## ${_TYPE_LABEL} Report

**Reporter:** ${REPORTER}
**Harness:** ${HARNESS:-n/a}
**Session:** ${SESSION_ID:-n/a}
**Local ID:** ${RECORD_ID}

### Description

${DESCRIPTION}"
    [ -n "$FILE_PATH" ] && GH_BODY="${GH_BODY}

**File:** \`${FILE_PATH}\`"
    [ "$REPORT_TYPE" = "bug" ] && GH_BODY="${GH_BODY}

**Severity:** ${SEVERITY}
**Category:** ${CATEGORY}"
    [ "$REPORT_TYPE" = "feature" ] && GH_BODY="${GH_BODY}

**Priority:** ${PRIORITY}"
    GH_BODY="${GH_BODY}

---
*Filed automatically by claude-ops agent*"

    if [ "$DRY_RUN" = "true" ]; then
      echo "DRY-RUN: Would create GitHub issue on ${GITHUB_REPO}:" >&2
      echo "  Title: ${TITLE}" >&2
      echo "  Labels: ${GH_LABELS}" >&2
      echo "  Body length: ${#GH_BODY} chars" >&2
    else
      GH_URL=$(gh issue create \
        --repo "$GITHUB_REPO" \
        --title "$TITLE" \
        --body "$GH_BODY" \
        --label "$GH_LABELS" \
        2>/dev/null || echo "")
      if [ -n "$GH_URL" ]; then
        echo "GitHub: $GH_URL" >&2
        # Publish bus event for observability
        if command -v bus_publish &>/dev/null; then
          bus_publish "agent.issue-filed" \
            "$(jq -nc --arg id "$RECORD_ID" --arg url "$GH_URL" --arg title "$TITLE" --arg reporter "$REPORTER" \
              '{id:$id,github_url:$url,title:$title,reporter:$reporter}')" 2>/dev/null || true
        fi
      else
        echo "WARN: Failed to create GitHub issue" >&2
      fi
    fi
  fi
fi

# ── Output ────────────────────────────────────────────────────
echo "$RECORD_ID"
