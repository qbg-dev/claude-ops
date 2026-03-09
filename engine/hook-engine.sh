#!/usr/bin/env bash
# hook-engine.sh — Unified dynamic hook dispatch.
# Registered on ALL events. Reads dynamic hooks from ~/.claude/ops/hooks/dynamic/{worker}.json
# and applies block/inject decisions.
#
# Replaces: dynamic-hook-dispatcher.sh, subagent-lifecycle.sh (hook dispatch parts),
#           stop-worker-dispatch.sh (blocking-hook-check, lines 25-36)
#
# Output protocol:
#   Block:  {"decision":"block","reason":"..."}
#   Inject: {"additionalContext":"..."}
#   Pass:   {}
#
# Fail-open: any error → {} (never accidentally block)
set -uo pipefail
trap 'echo "{}"; exit 0' ERR

# ── Read input ──────────────────────────────────────────────────
INPUT=$(cat)

EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null || echo "")
[ -z "$EVENT" ] && { echo '{}'; exit 0; }

# Worker identity — no worker means no dynamic hooks to check
WORKER="${WORKER_NAME:-}"
[ -z "$WORKER" ] && { echo '{}'; exit 0; }

# ── Hooks file ──────────────────────────────────────────────────
HOOKS_DIR="${CLAUDE_HOOKS_DIR:-$HOME/.claude/ops/hooks/dynamic}"
HOOKS_FILE="$HOOKS_DIR/${WORKER}.json"
[ ! -f "$HOOKS_FILE" ] && { echo '{}'; exit 0; }

# Parse identity
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null || echo "")
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // "{}"' 2>/dev/null || echo "{}")
IS_SUBAGENT=false
[ -n "$AGENT_ID" ] && IS_SUBAGENT=true

# ── SubagentStop: auto-complete hooks scoped to this agent ──────
if [ "$EVENT" = "SubagentStop" ] && [ -n "$AGENT_ID" ]; then
  _NOW=$(date -Iseconds 2>/dev/null || date -u +%FT%TZ)
  _UPDATED=$(jq --arg aid "$AGENT_ID" --arg now "$_NOW" \
    '.hooks = [.hooks[] | if (.agent_id == $aid and .completed == false) then .completed = true | .completed_at = $now | .result = "auto-completed: subagent stopped" else . end]' \
    "$HOOKS_FILE" 2>/dev/null || echo "")
  if [ -n "$_UPDATED" ]; then
    echo "$_UPDATED" > "$HOOKS_FILE" 2>/dev/null || true
  fi
fi

# ── Filter hooks matching this event ────────────────────────────
# Subagents see: hooks scoped to their agent_id + unscoped hooks
# Parent sees: unscoped hooks only
if [ "$IS_SUBAGENT" = "true" ]; then
  MATCHING=$(jq --arg ev "$EVENT" --arg aid "$AGENT_ID" \
    '[.hooks[] | select(.event == $ev and .completed == false and (.agent_id == $aid or .agent_id == null or .agent_id == ""))]' \
    "$HOOKS_FILE" 2>/dev/null || echo "[]")
else
  MATCHING=$(jq --arg ev "$EVENT" \
    '[.hooks[] | select(.event == $ev and .completed == false and (.agent_id == null or .agent_id == ""))]' \
    "$HOOKS_FILE" 2>/dev/null || echo "[]")
fi

COUNT=$(echo "$MATCHING" | jq 'length' 2>/dev/null || echo "0")
[ "$COUNT" -eq 0 ] && { echo '{}'; exit 0; }

# ── Condition matching (for PreToolUse/PostToolUse) ─────────────
_matches_condition() {
  local hook_json="$1"
  local cond
  cond=$(echo "$hook_json" | jq -r '.condition // empty' 2>/dev/null || echo "")
  [ -z "$cond" ] && return 0  # No condition = always matches

  # Tool name match
  local cond_tool
  cond_tool=$(echo "$hook_json" | jq -r '.condition.tool // empty' 2>/dev/null || echo "")
  if [ -n "$cond_tool" ] && [ -n "$TOOL_NAME" ]; then
    [ "$TOOL_NAME" != "$cond_tool" ] && return 1
  fi

  # File glob match
  local cond_glob
  cond_glob=$(echo "$hook_json" | jq -r '.condition.file_glob // empty' 2>/dev/null || echo "")
  if [ -n "$cond_glob" ]; then
    local file_path
    file_path=$(echo "$TOOL_INPUT" | jq -r '.file_path // .path // .command // ""' 2>/dev/null || echo "")
    if [ -n "$file_path" ]; then
      # Use bash pattern matching
      [[ "$file_path" != $cond_glob ]] && return 1
    fi
  fi

  # Command pattern match (regex)
  local cond_cmd
  cond_cmd=$(echo "$hook_json" | jq -r '.condition.command_pattern // empty' 2>/dev/null || echo "")
  if [ -n "$cond_cmd" ]; then
    local cmd_str
    cmd_str=$(echo "$TOOL_INPUT" | jq -r '.command // ""' 2>/dev/null || echo "")
    if [ -n "$cmd_str" ]; then
      echo "$cmd_str" | grep -qE "$cond_cmd" || return 1
    fi
  fi

  return 0
}

# ── Process matching hooks ──────────────────────────────────────
BLOCK_REASONS=""
INJECT_CONTEXTS=""

for i in $(seq 0 $((COUNT - 1))); do
  HOOK=$(echo "$MATCHING" | jq ".[$i]" 2>/dev/null || echo "{}")

  # Check condition matching for tool events
  if [[ "$EVENT" == "PreToolUse" || "$EVENT" == "PostToolUse" ]]; then
    _matches_condition "$HOOK" || continue
  fi

  IS_BLOCKING=$(echo "$HOOK" | jq -r '.blocking // false' 2>/dev/null || echo "false")
  HOOK_ID=$(echo "$HOOK" | jq -r '.id // "?"' 2>/dev/null || echo "?")
  DESC=$(echo "$HOOK" | jq -r '.description // "dynamic hook"' 2>/dev/null || echo "dynamic hook")
  CONTENT=$(echo "$HOOK" | jq -r '.content // .description // ""' 2>/dev/null || echo "")

  if [ "$IS_BLOCKING" = "true" ]; then
    BLOCK_REASONS="${BLOCK_REASONS}  [${HOOK_ID}] ${DESC}\n"
  elif [ -n "$CONTENT" ]; then
    INJECT_CONTEXTS="${INJECT_CONTEXTS}${CONTENT}\n"
  fi
done

# ── Emit decision ──────────────────────────────────────────────
# Blocking takes priority (PreToolUse and Stop can block; PostToolUse cannot)
if [ -n "$BLOCK_REASONS" ] && [ "$EVENT" != "PostToolUse" ]; then
  PENDING_COUNT=$(echo -e "$BLOCK_REASONS" | grep -c '\[' || echo "0")
  REASON=$(printf '## %s pending blocking hook(s)\n\n%b\nComplete each with complete_hook(id) before proceeding.' "$PENDING_COUNT" "$BLOCK_REASONS")
  jq -n --arg reason "$REASON" '{"decision":"block","reason":$reason}'
  exit 0
fi

# Inject context if any non-blocking hooks matched
if [ -n "$INJECT_CONTEXTS" ]; then
  CTX=$(printf '%b' "$INJECT_CONTEXTS" | head -c 2000)
  jq -n --arg ctx "$CTX" '{"additionalContext":$ctx}'
  exit 0
fi

echo '{}'
exit 0
