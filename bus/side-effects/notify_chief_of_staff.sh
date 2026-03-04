#!/usr/bin/env bash
# notify_chief_of_staff.sh — Deliver worker.commit events to chief-of-staff.
# Dual delivery: inbox.jsonl (durable) + tmux send-keys (instant).
set -euo pipefail

payload=$(cat)
worker=$(echo "$payload" | jq -r '.worker // ""' 2>/dev/null || echo "")
[ -z "$worker" ] && exit 0

# Skip if the committer IS chief-of-staff (avoid self-notification)
[ "$worker" = "chief-of-staff" ] && exit 0

# Resolve project root
pr="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || echo "")}"
# Resolve main repo root if in worktree
if [[ "$pr" == *-w-* ]]; then
  pr=$(echo "$pr" | sed 's|-w-[^/]*$||')
fi
_REGISTRY="${pr}/.claude/workers/registry.json"

# 1. Durable: append to chief-of-staff's inbox.jsonl
cos_inbox="$pr/.claude/workers/chief-of-staff/inbox.jsonl"
if [ -d "$(dirname "$cos_inbox")" ]; then
  echo "$payload" >> "$cos_inbox"
fi

# 2. Instant: tmux send-keys to chief-of-staff's pane (from registry.json)
cos_pane=""
if [ -f "$_REGISTRY" ]; then
  cos_pane=$(jq -r '.["chief-of-staff"].pane_id // ""' "$_REGISTRY" 2>/dev/null || echo "")
fi
[ -z "$cos_pane" ] && exit 0

cos_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
  | awk -v id="$cos_pane" '$1 == id {print $2; exit}')
[ -z "$cos_target" ] && exit 0

sha=$(echo "$payload" | jq -r '.commit_sha // .sha // "?"' 2>/dev/null)
msg=$(echo "$payload" | jq -r '.message // .msg // .description // ""' 2>/dev/null)
branch=$(echo "$payload" | jq -r '.branch // ""' 2>/dev/null)
event_type=$(echo "$payload" | jq -r '._event_type // "commit"' 2>/dev/null)

# Use appropriate label based on event type
if [[ "$event_type" == *"merge-request"* ]]; then
  label="merge-request from"
else
  label="commit from"
fi

tmux send-keys -t "$cos_target" "[$label $worker] $sha on $branch: $msg"
tmux send-keys -t "$cos_target" -H 0d
