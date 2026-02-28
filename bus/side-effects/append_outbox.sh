#!/usr/bin/env bash
# append_outbox.sh — Append sent message to agent's outbox for audit trail.
# Triggered by cell-message and announcement events.
# Reads .from field to identify sender; writes full event payload to sender's outbox.jsonl.
set -euo pipefail
source "$HOME/.boring/lib/bus-paths.sh"

payload=$(cat)
from=$(echo "$payload" | jq -r '.from // ""' 2>/dev/null || echo "")
[ -z "$from" ] && exit 0

outbox=$(resolve_agent_outbox "$from")
[ -d "$(dirname "$outbox")" ] && echo "$payload" >> "$outbox"
