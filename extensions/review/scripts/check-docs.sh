#!/usr/bin/env bash
# scripts/check-docs.sh — Quick deterministic doc sync scan.
# Useful as a first-pass during verification, but NOT the gate.
# The pre-commit hook requires AI-verified proof XML (see doc-sync-checklist.md).
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")/../../.." && pwd)"
ERRORS=0

err() { echo "ERROR: $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo "WARN:  $1"; }

# ---------------------------------------------------------------------------
# Extract registered command names AND aliases from source files
# .command("xxx") → primary name, .alias("yyy") → alias
# ---------------------------------------------------------------------------
REGISTERED=""
ALIASES=""
for f in "$FLEET_DIR"/cli/commands/*.ts; do
  name=$(sed -n 's/.*\.command("\([a-z][a-z-]*\).*/\1/p' "$f" | head -1)
  alias=$(sed -n 's/.*\.alias("\([a-z][a-z-]*\)".*/\1/p' "$f" | head -1)
  [ -n "$name" ] && REGISTERED="$REGISTERED $name"
  [ -n "$alias" ] && ALIASES="$ALIASES $alias"
done
REGISTERED=$(echo "$REGISTERED" | tr ' ' '\n' | sort -u | grep -v '^$')
ALIASES=$(echo "$ALIASES" | tr ' ' '\n' | sort -u | grep -v '^$')
# ALL_NAMES = primary commands + aliases (for matching docs)
ALL_NAMES=$(printf '%s\n%s' "$REGISTERED" "$ALIASES" | sort -u | grep -v '^$')

CMD_COUNT=$(echo "$REGISTERED" | wc -l | tr -d ' ')
echo "Found $CMD_COUNT registered commands: $(echo $REGISTERED | tr '\n' ' ')"
[ -n "$ALIASES" ] && echo "Aliases: $(echo $ALIASES | tr '\n' ' ')"
echo ""

# ---------------------------------------------------------------------------
# 1. Check CLAUDE.md — every registered command should appear as "fleet <cmd>"
# ---------------------------------------------------------------------------
echo "Checking CLAUDE.md..."
for cmd in $REGISTERED; do
  if ! grep -q "fleet $cmd" "$FLEET_DIR/CLAUDE.md"; then
    # Check if this command's alias appears instead
    # Find alias from same source file
    src_file="$FLEET_DIR/cli/commands/$(echo "$cmd" | tr '-' '-').ts"
    # Try to find the source file containing .command("$cmd")
    alias_found=false
    for f in "$FLEET_DIR"/cli/commands/*.ts; do
      if grep -q "\.command(\"$cmd" "$f"; then
        file_alias=$(sed -n 's/.*\.alias("\([a-z][a-z-]*\)".*/\1/p' "$f" | head -1)
        if [ -n "$file_alias" ] && grep -q "fleet $file_alias" "$FLEET_DIR/CLAUDE.md"; then
          alias_found=true
        fi
        break
      fi
    done
    if ! $alias_found; then
      err "MISSING in CLAUDE.md: fleet $cmd"
    fi
  fi
done

# Reverse: commands in CLAUDE.md CLI block that don't exist in source
# Extract "fleet xxx" from the CLI code block (between ``` markers in ## CLI section)
DOC_CMDS=$(sed -n '/^## CLI/,/^## /p' "$FLEET_DIR/CLAUDE.md" \
  | sed -n '/^```/,/^```/p' \
  | sed -n 's/^fleet \([a-z][a-z-]*\).*/\1/p' \
  | sort -u)
for cmd in $DOC_CMDS; do
  if ! echo "$ALL_NAMES" | grep -qx "$cmd"; then
    err "STALE in CLAUDE.md: fleet $cmd (command no longer exists)"
  fi
done

# ---------------------------------------------------------------------------
# 2. Check completions/fleet.zsh
# ---------------------------------------------------------------------------
COMPLETIONS="$FLEET_DIR/completions/fleet.zsh"
if [ -f "$COMPLETIONS" ]; then
  echo "Checking completions/fleet.zsh..."
  for cmd in $REGISTERED; do
    if ! grep -q "'$cmd:" "$COMPLETIONS"; then
      # Check aliases too (ls→list, restart→start, etc.)
      err "MISSING in completions: $cmd"
    fi
  done

  # Reverse: completions referencing removed commands
  COMP_CMDS=$(sed -n "s/.*'\([a-z][a-z-]*\):.*/\1/p" "$COMPLETIONS" | sort -u)
  for cmd in $COMP_CMDS; do
    if ! echo "$REGISTERED" | grep -qx "$cmd"; then
      # Skip known aliases
      case "$cmd" in
        ls|restart|cfg|logs|dr) continue ;;
      esac
      err "STALE in completions: $cmd (command no longer exists)"
    fi
  done
else
  warn "No completions file found at $COMPLETIONS"
fi

# ---------------------------------------------------------------------------
# 3. Check cli/tests/help-format.test.ts ALL_COMMANDS array
# ---------------------------------------------------------------------------
TEST_FILE="$FLEET_DIR/cli/tests/help-format.test.ts"
if [ -f "$TEST_FILE" ]; then
  echo "Checking cli/tests/help-format.test.ts..."
  for cmd in $REGISTERED; do
    if ! grep -q "\"$cmd\"" "$TEST_FILE"; then
      err "MISSING in help-format.test.ts ALL_COMMANDS: $cmd"
    fi
  done

  # Reverse: test commands that don't exist
  TEST_CMDS=$(sed -n 's/.*"\([a-z][a-z-]*\)".*/\1/p' "$TEST_FILE" \
    | grep -v 'contains\|commands\|exits\|description\|Usage\|shows\|aliases\|Fleet\|persistent' \
    | sort -u)
  for cmd in $TEST_CMDS; do
    if ! echo "$REGISTERED" | grep -qx "$cmd"; then
      # Skip common test strings that aren't command names
      case "$cmd" in
        json|project|version|help) continue ;;
      esac
      err "STALE in help-format.test.ts: $cmd (command no longer exists)"
    fi
  done
else
  warn "No test file found at $TEST_FILE"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "✓ All documentation in sync ($CMD_COUNT commands)"
  exit 0
else
  echo "✗ Found $ERRORS sync error(s). Fix documentation before committing."
  exit 1
fi
