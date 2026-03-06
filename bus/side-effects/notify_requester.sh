#!/usr/bin/env bash
# notify_requester.sh — Deliver event back to the originating agent's inbox.
set -euo pipefail
source "$HOME/.claude-ops/lib/bus-paths.sh"

payload=$(cat)
from=$(echo "$payload" | jq -r '.from // ""' 2>/dev/null || echo "")
[ -z "$from" ] && exit 0

inbox=$(resolve_agent_inbox "$from")
[ -d "$(dirname "$inbox")" ] && echo "$payload" >> "$inbox"
