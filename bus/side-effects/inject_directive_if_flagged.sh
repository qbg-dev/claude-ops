#!/usr/bin/env bash
# inject_directive_if_flagged.sh — Append to agent MEMORY.md if routing=directive.
set -euo pipefail

payload=$(cat)
routing=$(echo "$payload" | jq -r '.routing // ""' 2>/dev/null || echo "")
[ "$routing" != "directive" ] && exit 0

to=$(echo "$payload" | jq -r '.to // ""' 2>/dev/null || echo "")
[ -z "$to" ] && exit 0

pr="${PROJECT_ROOT:-.}"
memory_path="$pr/.claude/harness/$to/agents/sidecar/MEMORY.md"
[ ! -f "$memory_path" ] && exit 0

sender=$(echo "$payload" | jq -r '.from // "unknown"' 2>/dev/null || echo "unknown")
content_text=$(echo "$payload" | jq -r '.body // .content // ""' 2>/dev/null || echo "")
ts_str=$(date "+%Y-%m-%d %H:%M")

echo "" >> "$memory_path"
echo "## [BUS DIRECTIVE] $sender — $ts_str" >> "$memory_path"
echo "" >> "$memory_path"
echo "$content_text" >> "$memory_path"

# Publish agent.memory-updated for observability (fire-and-forget)
if [ -f "$HOME/.claude-ops/lib/event-bus.sh" ]; then
  _mem_payload=$(jq -nc --arg agent "$to" --arg src "directive" --arg file "$memory_path" --arg sender "$sender" \
    '{agent:$agent, source:$src, file:$file, trigger_from:$sender}' 2>/dev/null || true)
  if [ -n "$_mem_payload" ]; then
    (PROJECT_ROOT="$pr" BUS_DIR="$pr/.claude/bus" \
      bash -c "source '$HOME/.claude-ops/lib/event-bus.sh' && bus_publish 'agent.memory-updated' '$_mem_payload'" 2>/dev/null || true) &
    disown 2>/dev/null || true
  fi
fi
