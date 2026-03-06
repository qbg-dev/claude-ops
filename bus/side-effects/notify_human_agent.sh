#!/usr/bin/env bash
# notify_human_agent.sh — macOS notification via terminal-notifier with full event context.
# Called for deploy, config-change, notification, and other events warranting the human agent's attention.
# The human agent name is configurable via CLAUDE_OPS_HUMAN_AGENT (default: see defaults.json).
set -euo pipefail

payload=$(cat)

event_type=$(echo "$payload" | jq -r '._event_type // "event"' 2>/dev/null || echo "event")
agent=$(echo "$payload" | jq -r '.from // .agent // .harness // ""' 2>/dev/null || echo "")
body=$(echo "$payload" | jq -r '.message // .body // .content // .result // .error // .summary // ""' 2>/dev/null | head -c 160)
target=$(echo "$payload" | jq -r '.to // ""' 2>/dev/null || echo "")
url=$(echo "$payload" | jq -r '.url // ""' 2>/dev/null || echo "")

# For notification events, use the provided title; otherwise derive from event type
custom_title=$(echo "$payload" | jq -r '.title // ""' 2>/dev/null || echo "")
if [ -n "$custom_title" ]; then
  title="$custom_title"
else
  title="${event_type}"
fi

# Subtitle: who sent it → who it's for
if [ -n "$agent" ] && [ -n "$target" ]; then
  subtitle="${agent} → ${target}"
elif [ -n "$agent" ]; then
  subtitle="${agent}"
elif [ -n "$target" ]; then
  subtitle="to: ${target}"
else
  subtitle="event bus"
fi

# Message: actual content (truncated for banner)
if [ -z "$body" ]; then
  body="(no content)"
fi

# Build click-action args (url support for notification events)
click_args=()
if [ -n "$url" ]; then
  [[ "$url" == /* ]] && url="file://$url"
  click_args+=(-open "$url")
fi

# Build full args array — avoids empty-array set -u crash on bash 3.2 (macOS)
notif_args=(-title "$title" -subtitle "$subtitle" -message "$body" -sound default)
[ ${#click_args[@]} -gt 0 ] && notif_args+=("${click_args[@]}")
terminal-notifier "${notif_args[@]}" 2>/dev/null || true
