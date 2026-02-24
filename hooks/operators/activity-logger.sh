#!/usr/bin/env bash
# activity-logger.sh — PostToolUse hook that appends structured events to JSONL.
#
# K8s analogy: Informer / event stream
# Monitor reads this instead of scraping tmux captures — structured, filterable, lossless.
# File: /tmp/claude_activity_{harness}.jsonl
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
REGISTRY="$HARNESS_SESSION_REGISTRY"
INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
[ -z "$SESSION_ID" ] && exit 0

# Only log for harness sessions
HARNESS=""
if [ -f "$REGISTRY" ]; then
  HARNESS=$(jq -r --arg sid "$SESSION_ID" '.[$sid] // ""' "$REGISTRY" 2>/dev/null || echo "")
fi
[ -z "$HARNESS" ] && exit 0

LOG="/tmp/claude_activity_${HARNESS}.jsonl"

# Rotate if log exceeds 1MB — keep last 500 lines
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 1048576 ]; then
  tail -500 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
fi

# Extract event data
python3 -c "
import json, sys, datetime

data = json.load(sys.stdin)
ti = data.get('tool_input', {})
if isinstance(ti, str):
    try: ti = json.loads(ti)
    except: ti = {}

tool = data.get('tool_name', '')
event = {
    'ts': datetime.datetime.utcnow().isoformat() + 'Z',
    'tool': tool,
    'session': '$SESSION_ID'
}

# Extract relevant fields by tool type
if tool == 'Bash':
    cmd = ti.get('command', '')
    event['cmd'] = cmd[:120]  # truncate
    event['bg'] = ti.get('run_in_background', False)
elif tool in ('Write', 'Edit', 'Read', 'NotebookEdit'):
    event['file'] = ti.get('file_path', '').replace('$PROJECT_ROOT/', '')
    if tool == 'Edit':
        event['old_len'] = len(ti.get('old_string', ''))
        event['new_len'] = len(ti.get('new_string', ''))
elif tool in ('Glob', 'Grep'):
    event['pattern'] = ti.get('pattern', '')[:80]

# Append as single JSONL line
with open('$LOG', 'a') as f:
    f.write(json.dumps(event) + '\n')
" <<< "$INPUT" 2>/dev/null || true

# Also emit to unified metrics stream for control plane
python3 -c "
import json, sys, datetime

data = json.load(sys.stdin)
ti = data.get('tool_input', {})
if isinstance(ti, str):
    try: ti = json.loads(ti)
    except: ti = {}

tool = data.get('tool_name', '')
event = {
    'ts': datetime.datetime.utcnow().isoformat() + 'Z',
    'type': 'tool_use',
    'tool': tool,
    'harness': '$HARNESS',
    'session': '$SESSION_ID'
}

if tool == 'Bash':
    event['cmd'] = ti.get('command', '')[:80]
elif tool in ('Write', 'Edit'):
    event['file'] = ti.get('file_path', '').split('/')[-1]

with open('/tmp/harness_metrics.jsonl', 'a') as f:
    f.write(json.dumps(event) + '\n')
" <<< "$INPUT" 2>/dev/null || true

exit 0
