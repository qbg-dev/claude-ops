#!/usr/bin/env bash
# pre-tool-context-injector.sh — PreToolUse hook that injects relevant context before tool calls.
#
# K8s analogy: Dynamic Admission Controller with sidecar injection
# Reads policy.json context-injections (maintained by monitor) and injects
# relevant context as additionalContext based on file paths, commands, or tool types.
#
# Also injects:
#   - Inbox messages (recent from harness inbox.jsonl, up to 20)
#   - Acceptance summary (compact pass/fail status from acceptance.md)
#
# This is "RAG for tool calls" — the monitor maintains the knowledge base,
# this hook queries it at the moment of action.
set -uo pipefail
# Always emit {} on any error so Claude Code doesn't show hook error in TUI
# exit 0 in trap ensures we NEVER exit non-zero — prevents TUI "hook error" noise
trap 'echo "{}"; exit 0' ERR

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
[ -f "$HOME/.boring/lib/event-bus.sh" ] && source "$HOME/.boring/lib/event-bus.sh"
CONTEXT_INJECTOR_MAX_MATCHES="${CONTEXT_INJECTOR_MAX_MATCHES:-3}"
INBOX_ENABLED="${INBOX_ENABLED:-true}"
INBOX_SCAN_WINDOW_SEC="${INBOX_SCAN_WINDOW_SEC:-1800}"
INBOX_MAX_INJECT_MESSAGES="${INBOX_MAX_INJECT_MESSAGES:-20}"
INBOX_ACCEPTANCE_INJECT="${INBOX_ACCEPTANCE_INJECT:-true}"

# Use shared pane resolution library (replaces inline harness-jq.sh source)
source "$HOME/.boring/lib/pane-resolve.sh"

INPUT=$(cat)

# Parse input via jq (replaces python3 json.load)
hook_parse_input "$INPUT"
SESSION_ID="$_HOOK_SESSION_ID"
TOOL_NAME="$_HOOK_TOOL_NAME"
TOOL_INPUT="$_HOOK_TOOL_INPUT"

# Resolve pane + harness via shared library (replaces 3-line inline resolution)
resolve_pane_and_harness "$SESSION_ID"
[ -z "$HARNESS" ] && { hook_pass; exit 0; }

# ── Cancel graceful-stop sentinel on any tool activity ──────────────────
# If the stop hook fired but the agent is still making tool calls, it means
# the agent resumed (operator typed, bus message arrived). Remove the sentinel
# so the watchdog does NOT rotate this agent.
_GS_FILE="$HOME/.boring/state/sessions/$SESSION_ID/graceful-stop"
[ -f "$_GS_FILE" ] && rm -f "$_GS_FILE" 2>/dev/null || true

# Resolve injections file (policy.json -> context-injections.json, new path -> legacy)
INJECTIONS=$(harness_inject_file "$HARNESS" "$PROJECT_ROOT")

# -- Policy.json context injections (via standalone script) ----
CONTEXT=""
if [ -n "$INJECTIONS" ] && [ -f "$INJECTIONS" ]; then
  INJECT_PREFIX=$(harness_inject_jq_prefix "$INJECTIONS")
  CONTEXT=$(echo "$INPUT" | python3 "$HOME/.boring/lib/py/policy_match.py" \
    --injections "$INJECTIONS" \
    --prefix "${INJECT_PREFIX:-.}" \
    --max "$CONTEXT_INJECTOR_MAX_MATCHES" \
    2>/dev/null || true)
fi

# -- Phase enforcement context injection (long-running harnesses only) --
PHASE_CONTEXT=""
CYCLE_PHASE_ENFORCEMENT="${CYCLE_PHASE_ENFORCEMENT:-true}"
if [ "$CYCLE_PHASE_ENFORCEMENT" = "true" ]; then
  PHASE_PROGRESS=$(harness_progress_path "$HARNESS" "$PROJECT_ROOT" 2>/dev/null || echo "")
  if [ -n "$PHASE_PROGRESS" ] && [ -f "$PHASE_PROGRESS" ]; then
    PHASE_LIFECYCLE=$(harness_lifecycle "$PHASE_PROGRESS" 2>/dev/null || echo "bounded")
    if [ "$PHASE_LIFECYCLE" = "long-running" ]; then
      PHASE_CUR=$(harness_cycle_phase "$PHASE_PROGRESS" 2>/dev/null || echo "unknown")
      if [ "$PHASE_CUR" != "unknown" ]; then
        case "$PHASE_CUR" in
          probe)     PHASE_CONTEXT="[PHASE: PROBE] You are in PROBE phase. Update acceptance.md before advancing." ;;
          reconcile) PHASE_CONTEXT="[PHASE: RECONCILE] You are in RECONCILE phase. Document gaps before advancing." ;;
          act)       PHASE_CONTEXT="[PHASE: ACT] You are in ACT phase. Record work done (tasks_created/files_changed) before advancing." ;;
          persist)   PHASE_CONTEXT="[PHASE: PERSIST] You are in PERSIST phase. Add journal entry before completing cycle." ;;
        esac
      fi
    fi
  fi
fi

# -- Inbox scan + Acceptance summary + File-edit aggregation ----
# Two paths: bus-based (cursor, O(1) per topic) or legacy (time-window scan, O(N*M))
INBOX_CONTEXT=""
if [ "$INBOX_ENABLED" = "true" ]; then
  HARNESS_DIR="$PROJECT_ROOT/.claude/harness/$HARNESS"

  # -- Inbox scan via standalone script --
  if [ -z "$INBOX_CONTEXT" ]; then
    _ACCEPTANCE_FLAG=""
    [ "$INBOX_ACCEPTANCE_INJECT" = "true" ] && _ACCEPTANCE_FLAG="--acceptance" || _ACCEPTANCE_FLAG="--no-acceptance"

    export HARNESS HARNESS_DIR
    LEGACY_CONTEXT=$(python3 "$HOME/.boring/lib/py/inbox_scan.py" \
      --window "$INBOX_SCAN_WINDOW_SEC" \
      --max "$INBOX_MAX_INJECT_MESSAGES" \
      $_ACCEPTANCE_FLAG \
      2>/dev/null || true)
    INBOX_CONTEXT="$LEGACY_CONTEXT"
  fi
fi

# -- Merge all context sources ----
MERGED=""
if [ -n "$CONTEXT" ]; then
  MERGED="$CONTEXT"
fi
if [ -n "$PHASE_CONTEXT" ]; then
  [ -n "$MERGED" ] && MERGED="${MERGED}\n- ${PHASE_CONTEXT}" || MERGED="- ${PHASE_CONTEXT}"
fi
if [ -n "$INBOX_CONTEXT" ]; then
  [ -n "$MERGED" ] && MERGED="${MERGED}\n${INBOX_CONTEXT}" || MERGED="$INBOX_CONTEXT"
fi

# If we have context to inject, return it as additionalContext (replaces python3 json.dumps)
if [ -n "$MERGED" ]; then
  hook_context "$MERGED"
else
  hook_pass
fi
