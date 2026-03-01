#!/usr/bin/env bash
# launch-moltbook-poster.sh — Launch the moltbook-poster agent.
#
# Reads permissions.json for model and setting_sources.
# NOTE: --setting-sources "project,local" only controls settings.json loading.
# It does NOT prevent ~/.claude/CLAUDE.md from loading (stress-tested: 7/8 probes leaked).
# Real isolation relies on: (1) mission.md privacy instructions, (2) Read path blocklist
# in permissions.json, (3) human review of drafts before any POST is sent.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HARNESS="moltbook-poster"
PERMS="$PROJECT_ROOT/.claude/harness/$HARNESS/agents/poster/permissions.json"
SEED_SCRIPT="$PROJECT_ROOT/.claude/scripts/moltbook-poster-seed.sh"

if [ ! -f "$PERMS" ]; then
  echo "ERROR: permissions.json not found at $PERMS" >&2; exit 1
fi
if [ ! -f "$SEED_SCRIPT" ]; then
  echo "ERROR: seed script not found at $SEED_SCRIPT" >&2; exit 1
fi

MODEL=$(jq -r '.model // "sonnet"' "$PERMS")
SETTING_SOURCES=$(jq -r '.setting_sources // "project,local"' "$PERMS")

echo "Generating moltbook-poster seed..."
"$SEED_SCRIPT" > /tmp/moltbook-poster-seed.txt

echo "Launching moltbook-poster (model=$MODEL, setting-sources=$SETTING_SOURCES)..."
CURRENT_WINDOW=$(tmux display-message -p '#{session_name}:#{window_index}' 2>/dev/null || echo "")
PANE=$(tmux split-window -t "$CURRENT_WINDOW" -P -F '#{pane_id}' -d \
  "cd $PROJECT_ROOT && cat /tmp/moltbook-poster-seed.txt | claude --dangerously-skip-permissions --model $MODEL --setting-sources '$SETTING_SOURCES'")
echo "moltbook-poster launched as pane $PANE in $CURRENT_WINDOW"
echo "NOTE: CLAUDE.md isolation is instruction+blocklist based, not flag-based (see script header)"
