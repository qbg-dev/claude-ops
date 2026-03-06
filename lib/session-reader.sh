#!/usr/bin/env bash
# session-reader.sh — Helper functions for reading Claude Code session JSONL transcripts.
#
# Session transcripts live at ~/.claude/projects/{slug}/{session_id}.jsonl
# and contain structured records of all conversation turns, tool use, errors, etc.
#
# Usage:
#   source ~/.claude-ops/lib/session-reader.sh
#   JSONL=$(session_find "my-harness")
#   session_summary "$JSONL"
#   session_errors "$JSONL" 50
#   session_recent_tools "$JSONL" 30

# ─────────────────────────────────────────────────────────────
# session_find <harness_name>
#
# Finds the current session's JSONL file for the given harness.
# Strategy:
#   1. Read activity log → extract session ID → find matching JSONL
#   2. Fallback: most-recently-modified .jsonl in the project slug dir
#
# Output: absolute path to JSONL file (or empty string if not found)
# ─────────────────────────────────────────────────────────────
session_find() {
  local harness="$1"
  local _state_dir="${HARNESS_STATE_DIR:-$HOME/.claude-ops/state}"
  local activity_log="${_state_dir}/activity/claude_activity_${harness}.jsonl"
  local projects_dir="$HOME/.claude/projects"

  # Strategy 1: Get session ID from activity log
  if [ -f "$activity_log" ]; then
    local session_id
    session_id=$(tail -5 "$activity_log" 2>/dev/null | jq -r 'select(.session != null and .session != "") | .session' 2>/dev/null | tail -1)
    if [ -n "$session_id" ] && [ "$session_id" != "null" ]; then
      # Search for matching JSONL file
      local match
      match=$(find "$projects_dir" -name "${session_id}.jsonl" -type f 2>/dev/null | head -1)
      if [ -n "$match" ] && [ -f "$match" ]; then
        echo "$match"
        return 0
      fi
      # If full ID didn't match, try prefix match (backwards compat with truncated IDs)
      if [ ${#session_id} -lt 36 ]; then
        match=$(find "$projects_dir" -name "${session_id}*.jsonl" -type f 2>/dev/null | head -1)
        if [ -n "$match" ] && [ -f "$match" ]; then
          echo "$match"
          return 0
        fi
      fi
    fi
  fi

  # Strategy 2: Fallback — most recently modified JSONL in any project slug dir
  # Try to narrow by harness manifest's project root
  local project_root=""
  local manifest="$HOME/.claude-ops/harnesses/$harness/manifest.json"
  if [ -f "$manifest" ]; then
    project_root=$(jq -r '.project_root // ""' "$manifest" 2>/dev/null)
  fi

  if [ -n "$project_root" ]; then
    # Derive the slug from the project root (replace / with -)
    local slug
    slug=$(echo "$project_root" | sed 's|^/||; s|/|-|g')
    local slug_dir="$projects_dir/-${slug}"
    if [ -d "$slug_dir" ]; then
      local newest
      newest=$(find "$slug_dir" -name '*.jsonl' -type f -newer "$slug_dir" -o -name '*.jsonl' -type f 2>/dev/null \
        | xargs ls -t 2>/dev/null | head -1)
      # ls -t with eza might not sort by time, use stat instead
      newest=$(find "$slug_dir" -name '*.jsonl' -type f -exec stat -f '%m %N' {} \; 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2-)
      if [ -n "$newest" ] && [ -f "$newest" ]; then
        echo "$newest"
        return 0
      fi
    fi
  fi

  # Last resort: search all project dirs
  local newest
  newest=$(find "$projects_dir" -name '*.jsonl' -type f -exec stat -f '%m %N' {} \; 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-)
  if [ -n "$newest" ] && [ -f "$newest" ]; then
    echo "$newest"
    return 0
  fi

  echo ""
  return 1
}

# ─────────────────────────────────────────────────────────────
# session_summary <jsonl_path> [last_n]
#
# Extracts a concise monitoring digest from the last N entries.
# Output: JSON with turn_count, last_tool, last_error, token_trend,
#         thinking_active, minutes_since_last_assistant
# ─────────────────────────────────────────────────────────────
session_summary() {
  local jsonl_path="$1"
  local last_n="${2:-20}"

  [ ! -f "$jsonl_path" ] && echo '{"error":"file_not_found"}' && return 1

  tail -"$last_n" "$jsonl_path" 2>/dev/null | python3 -c "
import json, sys, time
from datetime import datetime

lines = []
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        lines.append(json.loads(line))
    except:
        pass

# Count turns by role
assistant_count = 0
user_count = 0
last_tool = None
last_error = None
token_trend = []
thinking_active = False
last_assistant_ts = None
tool_uses = []

for entry in lines:
    msg = entry.get('message', {})
    role = msg.get('role', '')
    entry_type = entry.get('type', role)

    if role == 'assistant':
        assistant_count += 1
        # Extract usage for token trend
        usage = msg.get('usage', {})
        if usage:
            output_tokens = usage.get('output_tokens', 0)
            if output_tokens > 0:
                token_trend.append(output_tokens)
        # Check for thinking content
        for block in msg.get('content', []):
            if block.get('type') == 'thinking':
                thinking_active = True
            if block.get('type') == 'tool_use':
                tool_name = block.get('name', '')
                tool_uses.append(tool_name)
                last_tool = tool_name
        # Track timestamp
        ts_str = entry.get('timestamp', '')
        if ts_str:
            try:
                last_assistant_ts = datetime.fromisoformat(ts_str.rstrip('Z'))
            except:
                pass

    elif role == 'user':
        user_count += 1

    # Check for tool results with errors
    if entry_type == 'progress':
        content = msg.get('content', []) if msg else entry.get('content', [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('is_error'):
                    last_error = str(block.get('content', ''))[:200]

    # Also check assistant content for tool_result errors
    if role == 'user':
        content = msg.get('content', [])
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('is_error'):
                    err_content = block.get('content', '')
                    if isinstance(err_content, list):
                        err_content = ' '.join(str(c.get('text','')) for c in err_content if isinstance(c, dict))
                    last_error = str(err_content)[:200]

# Calculate minutes since last assistant
minutes_since = None
if last_assistant_ts:
    try:
        delta = datetime.utcnow() - last_assistant_ts
        minutes_since = round(delta.total_seconds() / 60, 1)
    except:
        pass

result = {
    'turn_count': assistant_count + user_count,
    'assistant_turns': assistant_count,
    'last_tool': last_tool,
    'last_error': last_error,
    'token_trend': token_trend[-3:],
    'thinking_active': thinking_active,
    'minutes_since_last_assistant': minutes_since,
    'recent_tools': tool_uses[-5:]
}
print(json.dumps(result))
" 2>/dev/null || echo '{"error":"parse_failed"}'
}

# ─────────────────────────────────────────────────────────────
# session_errors <jsonl_path> [last_n]
#
# Extracts tool errors/failures from last N entries.
# Output: one per line: "tool_name: error message"
# ─────────────────────────────────────────────────────────────
session_errors() {
  local jsonl_path="$1"
  local last_n="${2:-30}"

  [ ! -f "$jsonl_path" ] && return 1

  tail -"$last_n" "$jsonl_path" 2>/dev/null | python3 -c "
import json, sys

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        entry = json.loads(line)
    except:
        continue

    msg = entry.get('message', {})
    role = msg.get('role', '')
    content = msg.get('content', [])

    if not isinstance(content, list):
        continue

    # Tool results with errors come in user messages
    if role == 'user':
        for block in content:
            if isinstance(block, dict) and block.get('type') == 'tool_result' and block.get('is_error'):
                tool_id = block.get('tool_use_id', 'unknown')
                err = block.get('content', '')
                if isinstance(err, list):
                    err = ' '.join(str(c.get('text','')) for c in err if isinstance(c, dict))
                err = str(err)[:150]
                print(f'{tool_id}: {err}')

    # Also check progress entries with errors
    entry_type = entry.get('type', '')
    if entry_type == 'progress':
        for block in content if isinstance(content, list) else []:
            if isinstance(block, dict) and block.get('is_error'):
                print(f'progress: {str(block.get(\"content\",\"\"))[:150]}')
" 2>/dev/null
}

# ─────────────────────────────────────────────────────────────
# session_recent_tools <jsonl_path> [last_n]
#
# Lists recent tool uses from the last N entries.
# Output: one per line: "tool_name file_or_target"
# ─────────────────────────────────────────────────────────────
session_recent_tools() {
  local jsonl_path="$1"
  local last_n="${2:-30}"

  [ ! -f "$jsonl_path" ] && return 1

  tail -"$last_n" "$jsonl_path" 2>/dev/null | python3 -c "
import json, sys

for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        entry = json.loads(line)
    except:
        continue

    msg = entry.get('message', {})
    role = msg.get('role', '')
    if role != 'assistant':
        continue

    content = msg.get('content', [])
    if not isinstance(content, list):
        continue

    for block in content:
        if not isinstance(block, dict) or block.get('type') != 'tool_use':
            continue
        name = block.get('name', 'unknown')
        inp = block.get('input', {})
        target = ''
        if name in ('Read', 'Write', 'Edit', 'NotebookEdit'):
            target = inp.get('file_path', '')
            # Shorten paths
            target = target.split('/')[-1] if '/' in target else target
        elif name == 'Bash':
            target = inp.get('command', '')[:60]
        elif name in ('Glob', 'Grep'):
            target = inp.get('pattern', '')[:60]
        elif name == 'Task':
            target = inp.get('description', '')[:40]
        elif name == 'WebFetch':
            target = inp.get('url', '')[:60]
        print(f'{name} {target}')
" 2>/dev/null
}
