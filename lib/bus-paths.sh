#!/usr/bin/env bash
# bus-paths.sh — Shared path resolution for bus side-effect scripts.
#
# Usage: source ~/.claude-ops/lib/bus-paths.sh
#
# Functions:
#   resolve_agent_inbox  <agent_name> — Returns inbox.jsonl path for agent
#   resolve_agent_outbox <agent_name> — Returns outbox.jsonl path for agent

# Resolve a file path within an agent's directory.
# Resolution order:
#   "worker/$name"        → .claude/workers/$name/$filename  (flat worker fleet)
#   "mod-x/worker-name"   → .claude/harness/mod-x/agents/worker/worker-name/$filename  (harness)
#   "mod-x"               → module-manager → sidecar (legacy) → harness root
resolve_agent_file() {
  local agent="$1" filename="$2" pr="${PROJECT_ROOT:-.}"
  # Flat worker: "worker/$name" → .claude/workers/$name/$filename
  if [[ "$agent" == worker/* ]]; then
    echo "$pr/.claude/workers/${agent#worker/}/$filename"
    return
  fi
  if [[ "$agent" == */* ]]; then
    local module="${agent%%/*}" worker="${agent##*/}"
    echo "$pr/.claude/harness/$module/agents/worker/$worker/$filename"
  else
    local p_mm="$pr/.claude/harness/$agent/agents/module-manager/$filename"
    local p_sc="$pr/.claude/harness/$agent/agents/sidecar/$filename"
    local p_root="$pr/.claude/harness/$agent/$filename"
    if [ -d "$(dirname "$p_mm")" ]; then
      echo "$p_mm"
    elif [ -d "$(dirname "$p_sc")" ]; then
      echo "$p_sc"
    else
      echo "$p_root"
    fi
  fi
}

resolve_agent_inbox() {
  resolve_agent_file "$1" "inbox.jsonl"
}

resolve_agent_outbox() {
  resolve_agent_file "$1" "outbox.jsonl"
}
