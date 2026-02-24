#!/usr/bin/env bash
# context-injector.sh — PreToolUse hook that injects relevant context before tool calls.
#
# K8s analogy: Dynamic Admission Controller with sidecar injection
# Reads {harness}-context-injections.json (maintained by monitor) and injects
# relevant context as additionalContext based on file paths, commands, or tool types.
#
# This is "RAG for tool calls" — the monitor maintains the knowledge base,
# this hook queries it at the moment of action.
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
REGISTRY="$HARNESS_SESSION_REGISTRY"

INPUT=$(cat)

# Only activate for harness sessions (any harness, not just miniapp-chat)
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
HARNESS=""
if [ -f "$REGISTRY" ] && [ -n "$SESSION_ID" ]; then
  HARNESS=$(jq -r --arg sid "$SESSION_ID" '.[$sid] // ""' "$REGISTRY" 2>/dev/null || echo "")
fi
[ -z "$HARNESS" ] && { echo '{}'; exit 0; }

# Derive injections file from harness name
INJECTIONS="$PROJECT_ROOT/claude_files/${HARNESS}-context-injections.json"

# Need injections file
[ ! -f "$INJECTIONS" ] && { echo '{}'; exit 0; }

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('tool_name',''))" 2>/dev/null || echo "")
TOOL_INPUT=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
ti = data.get('tool_input', {})
if isinstance(ti, str):
    ti = json.loads(ti)
print(json.dumps(ti))
" 2>/dev/null || echo "{}")

# Collect all matching context injections
export PROJECT_ROOT INJECTIONS TOOL_NAME TOOL_INPUT
CONTEXT=$(python3 << 'PYEOF'
import json, sys, re, os

project = os.environ.get("PROJECT_ROOT", "")
injections_path = os.environ.get("INJECTIONS", "")
tool_name = os.environ.get("TOOL_NAME", "")
tool_input_raw = os.environ.get("TOOL_INPUT", "{}")

try:
    tool_input = json.loads(tool_input_raw)
except:
    tool_input = {}

try:
    with open(injections_path) as f:
        data = json.load(f)
except:
    sys.exit(0)

matches = []

# 1. File context — match file_path in Write/Edit/Read tool inputs
file_path = tool_input.get("file_path", "")
if file_path and "file_context" in data:
    for pattern, info in data["file_context"].items():
        if pattern in file_path:
            inject_text = info if isinstance(info, str) else info.get("inject", "")
            priority = "medium" if isinstance(info, str) else info.get("priority", "medium")
            if inject_text:
                matches.append((priority, inject_text))

# 2. Command context — match command in Bash tool inputs
command = tool_input.get("command", "")
if command and "command_context" in data:
    for pattern, info in data["command_context"].items():
        try:
            if re.search(pattern, command):
                inject_text = info if isinstance(info, str) else info.get("inject", "")
                priority = "medium" if isinstance(info, str) else info.get("priority", "medium")
                if inject_text:
                    matches.append((priority, inject_text))
        except re.error:
            if pattern in command:
                inject_text = info if isinstance(info, str) else info.get("inject", "")
                if inject_text:
                    matches.append(("medium", inject_text))

# 3. Tool context — match by tool name
if tool_name and "tool_context" in data:
    for t_pattern, info in data["tool_context"].items():
        if t_pattern == tool_name or t_pattern in tool_name:
            inject_when = info.get("inject_when", "always")
            # "always" means inject on every call to this tool type
            if inject_when == "always":
                matches.append(("low", info.get("inject", "")))

if not matches:
    sys.exit(0)

# Sort by priority (critical > high > medium > low), deduplicate
priority_order = {"critical": 0, "high": 1, "medium": 2, "low": 3}
matches.sort(key=lambda x: priority_order.get(x[0], 2))

# Limit to top 3 most relevant to avoid context bloat
seen = set()
output_lines = []
for _, text in matches[:3]:
    if text not in seen:
        seen.add(text)
        output_lines.append(f"- {text}")

if output_lines:
    print("[Harness context]\n" + "\n".join(output_lines))
PYEOF
)

# If we have context to inject, return it as additionalContext
if [ -n "$CONTEXT" ]; then
  python3 -c "
import json, sys
ctx = sys.argv[1]
print(json.dumps({'additionalContext': ctx}))
" "$CONTEXT"
else
  echo '{}'
fi
