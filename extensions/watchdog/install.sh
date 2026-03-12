#!/usr/bin/env bash
# install.sh — Install watchdog as a launchd daemon (macOS)
# Part of tmux-agents fleet. Monitors workers, respawns on crash.
set -euo pipefail

FLEET_DIR="${CLAUDE_FLEET_DIR:-$HOME/.claude-fleet}"
WATCHDOG_SCRIPT="$FLEET_DIR/extensions/watchdog/src/watchdog.ts"
STATE_DIR="$FLEET_DIR/state"
PLIST_NAME="com.tmux-agents.watchdog"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"

BUN_PATH="$(which bun 2>/dev/null || echo /opt/homebrew/bin/bun)"

# Auto-detect PATH for launchd (which has a minimal default PATH)
DETECTED_PATH="/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -d "$HOME/.bun/bin" ] && DETECTED_PATH="$HOME/.bun/bin:$DETECTED_PATH"
[ -d "$HOME/.local/bin" ] && DETECTED_PATH="$HOME/.local/bin:$DETECTED_PATH"
[ -d "/opt/homebrew/bin" ] && DETECTED_PATH="/opt/homebrew/bin:$DETECTED_PATH"

if [ ! -f "$WATCHDOG_SCRIPT" ]; then
  echo "ERROR: watchdog.ts not found at $WATCHDOG_SCRIPT"
  echo "Install claude-fleet first: git clone ... ~/.claude-fleet"
  exit 1
fi

if [ -f "$PLIST_PATH" ]; then
  echo "Watchdog already installed at $PLIST_PATH"
  echo "To reinstall: launchctl unload $PLIST_PATH && rm $PLIST_PATH && bash $0"
  exit 0
fi

mkdir -p "$STATE_DIR"

cat > "$PLIST_PATH" <<EOPLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$PLIST_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_PATH</string>
    <string>run</string>
    <string>$WATCHDOG_SCRIPT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$DETECTED_PATH</string>
    <key>PROJECT_ROOT</key><string>$PROJECT_ROOT</string>
    <key>CLAUDE_FLEET_DIR</key><string>$FLEET_DIR</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$STATE_DIR/watchdog.log</string>
  <key>StandardErrorPath</key><string>$STATE_DIR/watchdog.log</string>
</dict>
</plist>
EOPLIST

launchctl load "$PLIST_PATH"
echo "Watchdog installed and started: $PLIST_PATH"
echo "Logs: tail -f $STATE_DIR/watchdog.log"
