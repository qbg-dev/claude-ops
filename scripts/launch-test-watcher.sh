#!/usr/bin/env bash
# launch-test-watcher.sh — Launch the test-watcher persistent agent.
#
# The test-watcher runs in a dedicated tmux pane and cycles every 15 minutes:
#   1. Run tests/run-all.sh
#   2. Run both examples
#   3. Scan lib/ + hooks/ for abstraction issues
#   4. Check doc–code drift
#   5. Publish findings; sleep; repeat
#
# Usage:
#   bash scripts/launch-test-watcher.sh
#   bash scripts/launch-test-watcher.sh --window my-session:2
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLAUDE_OPS="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
SEED_SCRIPT="$PROJECT_ROOT/.claude/scripts/test-watcher-seed.sh"
WINDOW="${1:-}"

if [ ! -f "$SEED_SCRIPT" ]; then
  echo "ERROR: seed script not found: $SEED_SCRIPT" >&2
  echo "Run: bash $CLAUDE_OPS/scripts/scaffold.sh --long-running test-watcher $PROJECT_ROOT" >&2
  exit 1
fi

echo "Generating test-watcher seed..."
"$SEED_SCRIPT" > /tmp/test-watcher-seed.txt

if [ -n "$WINDOW" ]; then
  # Explicit window target — split a new pane there
  PANE=$(tmux split-window -t "$WINDOW" -P -F '#{pane_id}' -d \
    "cd $PROJECT_ROOT && cat /tmp/test-watcher-seed.txt | claude --dangerously-skip-permissions --model claude-sonnet-4-6")
  echo "test-watcher launched as pane $PANE in $WINDOW"
else
  # Default: split a new pane in the current window (stays alongside oss-steward)
  CURRENT_WINDOW=$(tmux display-message -p '#{session_name}:#{window_index}' 2>/dev/null || echo "")
  PANE=$(tmux split-window -t "$CURRENT_WINDOW" -P -F '#{pane_id}' -d \
    "cd $PROJECT_ROOT && cat /tmp/test-watcher-seed.txt | claude --dangerously-skip-permissions --model claude-sonnet-4-6")
  echo ""
  echo "test-watcher launched as pane $PANE in $CURRENT_WINDOW"
  echo "Watch: tmux pipe-pane -t $PANE -o 'cat >> /tmp/test-watcher.log'"
fi
