#!/usr/bin/env bash
# scripts/check-templates.sh — Template seed staleness scanner.
# Checks that template seeds reference tools, events, and worker types that
# actually exist in the codebase. Catches drift between templates and reality.
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")/.." && pwd)"
ERRORS=0
WARNINGS=0

err()  { echo "FAIL:  $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo "WARN:  $1"; WARNINGS=$((WARNINGS + 1)); }
pass() { echo "PASS:  $1"; }

# ---------------------------------------------------------------------------
# 1. MCP tool names in seed-context.md must match registered tools
# ---------------------------------------------------------------------------
echo "=== Template: MCP tool references ==="

# Extract registered tool names from source (may be empty if fleet MCP was removed)
TOOL_NAMES=""
if [ -d "$FLEET_DIR/mcp/worker-fleet/tools" ]; then
  TOOL_NAMES=$(grep -rh -A1 'server\.registerTool(' "$FLEET_DIR/mcp/worker-fleet/tools/" 2>/dev/null \
    | grep -oE '"[a-z_]+"' | tr -d '"' | sort -u || true)
fi

if [ -z "$TOOL_NAMES" ]; then
  pass "Fleet MCP server removed or has no tools — MCP reference check N/A"
fi

SEED_CONTEXT="$FLEET_DIR/templates/seed-context.md"
if [ -n "$TOOL_NAMES" ] && [ -f "$SEED_CONTEXT" ]; then
  # Extract tool names referenced as `tool_name(` in the seed context
  SEED_TOOLS=$(grep -oE '`[a-z_]+\(' "$SEED_CONTEXT" | tr -d '`(' | sort -u || true)

  for tool in $SEED_TOOLS; do
    # Skip non-MCP functions (common helpers, bash builtins, etc.)
    case "$tool" in
      mail_send|mail_inbox|mail_read|mail_help|round_stop|save_checkpoint|update_state|get_worker_state|add_hook|complete_hook|remove_hook|list_hooks|manage_worker_hooks|create_worker|fleet_help|deep_review)
        if ! echo "$TOOL_NAMES" | grep -qx "$tool"; then
          err "seed-context.md references \`$tool()\` but it's not registered in MCP tools"
        fi
        ;;
    esac
  done

  # Reverse: registered tools not mentioned in seed context
  for tool in $TOOL_NAMES; do
    if ! grep -q "$tool" "$SEED_CONTEXT"; then
      warn "MCP tool '$tool' registered but not documented in seed-context.md"
    fi
  done

  pass "MCP tool reference check complete"
elif [ -z "$TOOL_NAMES" ]; then
  : # already reported above
else
  warn "seed-context.md not found at $SEED_CONTEXT"
fi

# ---------------------------------------------------------------------------
# 2. Hook event names in seed-context.md must match manifest.json
# ---------------------------------------------------------------------------
echo ""
echo "=== Template: Hook event references ==="

MANIFEST="$FLEET_DIR/hooks/manifest.json"
if [ -f "$MANIFEST" ] && [ -f "$SEED_CONTEXT" ]; then
  # Extract event names from manifest
  MANIFEST_EVENTS=$(grep -oE '"event": *"[^"]+"' "$MANIFEST" | sed 's/.*"event": *"//' | sed 's/"//' | sort -u)

  # Extract event names referenced in seed-context.md (in backticks or quotes)
  SEED_EVENTS=$(grep -oE '`(PreToolUse|PostToolUse|PostToolUseFailure|SessionStart|SessionEnd|Stop|PreCompact|SubagentStart|SubagentStop|Notification|UserPromptSubmit|PermissionRequest|InstructionsLoaded|ConfigChange|TaskCompleted|TeammateIdle|WorktreeCreate|WorktreeRemove)`' "$SEED_CONTEXT" \
    | tr -d '`' | sort -u || true)

  for event in $SEED_EVENTS; do
    if ! echo "$MANIFEST_EVENTS" | grep -qx "$event"; then
      err "seed-context.md references event \`$event\` but it's not in hooks/manifest.json"
    fi
  done

  # Count documented vs actual
  MANIFEST_COUNT=$(echo "$MANIFEST_EVENTS" | wc -l | tr -d ' ')
  SEED_EVENT_COUNT=$(echo "$SEED_EVENTS" | grep -c . 2>/dev/null || true)
  SEED_EVENT_COUNT=${SEED_EVENT_COUNT:-0}
  SEED_EVENT_COUNT=$(echo "$SEED_EVENT_COUNT" | tr -d '[:space:]')
  if [ "$SEED_EVENT_COUNT" -lt "$((MANIFEST_COUNT / 2))" ]; then
    warn "seed-context.md documents $SEED_EVENT_COUNT events but manifest has $MANIFEST_COUNT — consider updating"
  fi

  pass "Hook event reference check complete"
else
  warn "manifest.json or seed-context.md not found"
fi

# ---------------------------------------------------------------------------
# 3. Worker type directories must match CLAUDE.md worker types table
# ---------------------------------------------------------------------------
echo ""
echo "=== Template: Worker type consistency ==="

TYPES_DIR="$FLEET_DIR/templates/flat-worker/types"
CLAUDE_MD="$FLEET_DIR/CLAUDE.md"
if [ -d "$TYPES_DIR" ] && [ -f "$CLAUDE_MD" ]; then
  # Actual type directories (exclude README.md)
  ACTUAL_TYPES=$(ls -d "$TYPES_DIR"/*/ 2>/dev/null | xargs -n1 basename | sort)

  # Types documented in CLAUDE.md worker types table (format: "| type-name | ...")
  DOC_TYPES=$(sed -n '/^## Worker types/,/^## /p' "$CLAUDE_MD" \
    | grep '^| [a-z]' | sed 's/| \([a-z][a-z-]*\) .*/\1/' | sort || true)

  if [ -z "$DOC_TYPES" ]; then
    warn "No ## Worker types table found in CLAUDE.md — cannot cross-check"
  else
    for t in $ACTUAL_TYPES; do
      if ! echo "$DOC_TYPES" | grep -qx "$t"; then
        err "Worker type '$t' has template directory but is not in CLAUDE.md worker types table"
      fi
      # Check each type has a mission.md
      if [ ! -f "$TYPES_DIR/$t/mission.md" ]; then
        warn "Worker type '$t' missing mission.md template"
      fi
    done

    for t in $DOC_TYPES; do
      if [ ! -d "$TYPES_DIR/$t" ]; then
        err "Worker type '$t' documented in CLAUDE.md but no template directory at types/$t/"
      fi
    done
  fi

  pass "Worker type consistency check complete"
else
  warn "types/ directory or CLAUDE.md not found"
fi

# ---------------------------------------------------------------------------
# 4. CLAUDE.md key files table — referenced files must exist
# ---------------------------------------------------------------------------
echo ""
echo "=== Template: Key files table ==="

if [ -f "$CLAUDE_MD" ]; then
  # Extract file paths from the key files table (between | ` markers)
  KEY_FILES=$(sed -n '/^## Key files/,/^## /p' "$CLAUDE_MD" \
    | grep '^| `' | sed 's/| `\([^`]*\)`.*/\1/' | sort || true)

  if [ -z "$KEY_FILES" ]; then
    warn "No ## Key files table found in CLAUDE.md"
  else
    MISSING=0
    for f in $KEY_FILES; do
      if [ ! -e "$FLEET_DIR/$f" ]; then
        err "Key files table references '$f' but it doesn't exist"
        MISSING=$((MISSING + 1))
      fi
    done

    if [ "$MISSING" -eq 0 ]; then
      pass "All key files exist ($(echo "$KEY_FILES" | wc -l | tr -d ' ') paths)"
    fi
  fi
else
  warn "CLAUDE.md not found"
fi

# ---------------------------------------------------------------------------
# 5. CLAUDE.md hooks count matches manifest
# ---------------------------------------------------------------------------
echo ""
echo "=== Template: Hook count consistency ==="

if [ -f "$CLAUDE_MD" ] && [ -f "$MANIFEST" ]; then
  DOC_HOOK_COUNT=$(grep -oE '[0-9]+ hooks across' "$CLAUDE_MD" | grep -oE '^[0-9]+' | head -1)
  DOC_EVENT_COUNT=$(grep -oE 'across [0-9]+' "$CLAUDE_MD" | grep -oE '[0-9]+' | head -1)

  # Count hooks in manifest (each entry is a hook)
  ACTUAL_HOOKS=$(grep -c '"event":' "$MANIFEST" || echo 0)
  ACTUAL_EVENTS=$(grep -oE '"event": *"[^"]+"' "$MANIFEST" | sort -u | wc -l | tr -d ' ')

  if [ -n "$DOC_HOOK_COUNT" ] && [ "$DOC_HOOK_COUNT" != "$ACTUAL_HOOKS" ]; then
    warn "CLAUDE.md says '$DOC_HOOK_COUNT hooks' but manifest has $ACTUAL_HOOKS"
  fi
  if [ -n "$DOC_EVENT_COUNT" ] && [ "$DOC_EVENT_COUNT" != "$ACTUAL_EVENTS" ]; then
    warn "CLAUDE.md says '$DOC_EVENT_COUNT events' but manifest has $ACTUAL_EVENTS"
  fi
  if [ -n "$DOC_HOOK_COUNT" ] && [ "$DOC_HOOK_COUNT" = "$ACTUAL_HOOKS" ] \
     && [ -n "$DOC_EVENT_COUNT" ] && [ "$DOC_EVENT_COUNT" = "$ACTUAL_EVENTS" ]; then
    pass "Hook counts match: $ACTUAL_HOOKS hooks across $ACTUAL_EVENTS events"
  fi
else
  warn "CLAUDE.md or manifest.json not found"
fi

# ---------------------------------------------------------------------------
# 6. Deep review templates reference correct tool/finding format
# ---------------------------------------------------------------------------
echo ""
echo "=== Template: Deep review seed freshness ==="

DR_WORKER="$FLEET_DIR/templates/deep-review/worker-seed.md"
DR_COORD="$FLEET_DIR/templates/deep-review/coordinator-seed.md"

if [ -n "$TOOL_NAMES" ] && [ -f "$DR_WORKER" ]; then
  # Check worker seed references mail tools that exist
  for tool in mail_send mail_inbox mail_read; do
    if grep -q "$tool" "$DR_WORKER" && ! echo "$TOOL_NAMES" | grep -qx "$tool"; then
      err "worker-seed.md references '$tool' but it's not a registered MCP tool"
    fi
  done
  pass "Deep review worker seed checked"
fi

if [ -n "$TOOL_NAMES" ] && [ -f "$DR_COORD" ]; then
  # Check coordinator seed references mail tools that exist
  for tool in mail_send mail_inbox mail_read; do
    if grep -q "$tool" "$DR_COORD" && ! echo "$TOOL_NAMES" | grep -qx "$tool"; then
      err "coordinator-seed.md references '$tool' but it's not a registered MCP tool"
    fi
  done
  pass "Deep review coordinator seed checked"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
  echo "All template checks passed"
  exit 0
elif [ "$ERRORS" -eq 0 ]; then
  echo "$WARNINGS warning(s), 0 errors"
  exit 0
else
  echo "$ERRORS error(s), $WARNINGS warning(s)"
  echo "Fix errors to ensure template-source consistency."
  exit 1
fi
