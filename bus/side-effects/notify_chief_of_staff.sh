#!/usr/bin/env bash
# notify_chief_of_staff.sh — Deliver worker.commit events to chief-of-staff.
# Dual delivery: inbox.jsonl (durable) + tmux send-keys (instant).
set -euo pipefail
source "$HOME/.boring/lib/harness-jq.sh"
source "$HOME/.boring/lib/bus-paths.sh"

payload=$(cat)
worker=$(echo "$payload" | jq -r '.worker // ""' 2>/dev/null || echo "")
[ -z "$worker" ] && exit 0

# Skip if the committer IS chief-of-staff (avoid self-notification)
[ "$worker" = "chief-of-staff" ] && exit 0

# 1. Durable: append to chief-of-staff's inbox.jsonl
cos_inbox=$(resolve_agent_inbox "worker/chief-of-staff")
if [ -d "$(dirname "$cos_inbox")" ]; then
  echo "$payload" >> "$cos_inbox"
fi

# 2. Instant: tmux send-keys to chief-of-staff's pane (scoped by project)
# STRICT project isolation: never fall back to unscoped lookup to prevent cross-project leakage.
pr="${PROJECT_ROOT:-.}"
cos_pane=$(jq -r --arg proj "$pr" \
  'to_entries[] | select(.value.harness == "worker/chief-of-staff" and (.value.project_root // "") == $proj) | .key' \
  "$PANE_REGISTRY" 2>/dev/null | head -1 || echo "")
[ -z "$cos_pane" ] && exit 0

cos_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' 2>/dev/null \
  | awk -v id="$cos_pane" '$1 == id {print $2; exit}')
[ -z "$cos_target" ] && exit 0

sha=$(echo "$payload" | jq -r '.commit_sha // .sha // "?"' 2>/dev/null)
msg=$(echo "$payload" | jq -r '.message // .msg // ""' 2>/dev/null)
branch=$(echo "$payload" | jq -r '.branch // ""' 2>/dev/null)

tmux send-keys -t "$cos_target" "[commit from $worker] $sha on $branch: $msg"
tmux send-keys -t "$cos_target" -H 0d
