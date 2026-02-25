#!/usr/bin/env bash
# deploy-mutator.sh — PreToolUse admission controller for Bash commands.
#
# K8s analogy: MutatingAdmissionWebhook
# Reads best-practices.json for deploy rules, auto-injects required flags.
# Output: {"updatedInput": {"command": "..."}} to rewrite, or {} to pass through.
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

INPUT=$(cat)

# Extract the command from tool_input
COMMAND=$(echo "$INPUT" | python3 -c "
import sys, json
data = json.load(sys.stdin)
ti = data.get('tool_input', {})
if isinstance(ti, str):
    ti = json.loads(ti)
print(ti.get('command', ''))
" 2>/dev/null || echo "")

# Only process deploy commands
if ! echo "$COMMAND" | grep -qE 'deploy(-prod|-test)?\.sh'; then
  echo '{}'
  exit 0
fi

# Check if a harness is active (only mutate for harness sessions)
source "$HOME/.claude-ops/lib/harness-jq.sh" 2>/dev/null || HARNESS_SESSION_REGISTRY="$HOME/.claude-ops/state/session-registry.json"
REGISTRY="$HARNESS_SESSION_REGISTRY"
SESSION_ID=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('session_id',''))" 2>/dev/null || echo "")
HARNESS=""
if [ -f "$REGISTRY" ] && [ -n "$SESSION_ID" ]; then
  HARNESS=$(jq -r --arg sid "$SESSION_ID" '.[$sid] // ""' "$REGISTRY" 2>/dev/null || echo "")
fi

# Only apply to harness sessions (any harness, not just miniapp-chat)
if [ -z "$HARNESS" ]; then
  echo '{}'
  exit 0
fi

# Load best practices from the harness-specific file (or use defaults)
BP_FILE=$(harness_rules_file "$HARNESS" "$PROJECT_ROOT")
RULES_PREFIX=$([ -n "$BP_FILE" ] && harness_rules_jq_prefix "$BP_FILE" || echo "")
REQUIRED_FLAGS=""
MIN_TIMEOUT=480000
if [ -n "$BP_FILE" ] && [ -f "$BP_FILE" ]; then
  REQUIRED_FLAGS=$(jq -r "${RULES_PREFIX}.deploy.required_flags // [] | join(\" \")" "$BP_FILE" 2>/dev/null || echo "")
  MIN_TIMEOUT=$(jq -r "${RULES_PREFIX}.deploy.min_timeout // 480000" "$BP_FILE" 2>/dev/null || echo "480000")
fi

MODIFIED="$COMMAND"
MUTATIONS=""

# Inject --fast if missing
if echo "$MODIFIED" | grep -q 'deploy' && ! echo "$MODIFIED" | grep -q '\-\-fast'; then
  MODIFIED=$(echo "$MODIFIED" | sed 's/deploy-prod\.sh/deploy-prod.sh --fast/')
  MODIFIED=$(echo "$MODIFIED" | sed 's/deploy\.sh/deploy.sh --fast/')
  MUTATIONS="${MUTATIONS}+--fast "
fi

# Inject --skip-langfuse if missing
if ! echo "$MODIFIED" | grep -q '\-\-skip-langfuse'; then
  MODIFIED="${MODIFIED} --skip-langfuse"
  MUTATIONS="${MUTATIONS}+--skip-langfuse "
fi

# Block deploy to test (test server is down)
if echo "$MODIFIED" | grep -qE 'deploy\.sh' && ! echo "$MODIFIED" | grep -q 'deploy-prod'; then
  python3 -c "
import json
print(json.dumps({
  'decision': 'block',
  'reason': 'Test server is down. Use deploy-prod.sh instead.'
}))
"
  exit 0
fi

# Suggest --service static for UI-only changes (if no --service flag present)
if ! echo "$MODIFIED" | grep -q '\-\-service'; then
  CHANGED_FILES=$(git diff --name-only HEAD 2>/dev/null || echo "")
  if [ -n "$CHANGED_FILES" ]; then
    UI_ONLY=true
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      case "$f" in
        src/admin/app/*|dist/*|*.css) ;;
        *) UI_ONLY=false; break ;;
      esac
    done <<< "$CHANGED_FILES"

    if [ "$UI_ONLY" = true ]; then
      MODIFIED=$(echo "$MODIFIED" | sed 's/deploy-prod\.sh/deploy-prod.sh --service static/')
      MUTATIONS="${MUTATIONS}+--service static (UI-only changes detected) "
    fi
  fi
fi

# If no mutations needed, pass through
if [ "$MODIFIED" = "$COMMAND" ]; then
  echo '{}'
  exit 0
fi

# Emit mutated command
python3 -c "
import json, sys
original = sys.argv[1]
modified = sys.argv[2]
mutations = sys.argv[3].strip()

result = {
  'updatedInput': {
    'command': modified
  }
}
# Log mutation for observability
import datetime
with open('/tmp/deploy-mutations.log', 'a') as f:
    f.write(f'{datetime.datetime.now().isoformat()} | {mutations} | {original[:80]}\n')

print(json.dumps(result))
" "$COMMAND" "$MODIFIED" "$MUTATIONS"
