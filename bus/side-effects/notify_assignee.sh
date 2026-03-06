#!/usr/bin/env bash
# notify_assignee.sh — Deliver event to target agent's inbox.jsonl
set -euo pipefail
source "$HOME/.claude-ops/lib/bus-paths.sh"

payload=$(cat)
to=$(echo "$payload" | jq -r '.to // ""' 2>/dev/null || echo "")
[ -z "$to" ] && exit 0

inbox=$(resolve_agent_inbox "$to")
[ -d "$(dirname "$inbox")" ] && echo "$payload" >> "$inbox"
