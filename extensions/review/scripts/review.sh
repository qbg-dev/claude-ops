#!/usr/bin/env bash
# scripts/review.sh — Deterministic scanner for REVIEW.md items 17–22.
# Complements check-docs.sh (items 1–5). Run before committing.
# Usage: bash scripts/review.sh [--staged-only]
#   --staged-only: Only scan staged diff (for pre-commit hook use)
set -euo pipefail

FLEET_DIR="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0")")/../../.." && pwd)"
ERRORS=0
WARNINGS=0

err()  { echo "FAIL:  $1"; ERRORS=$((ERRORS + 1)); }
warn() { echo "WARN:  $1"; WARNINGS=$((WARNINGS + 1)); }
pass() { echo "PASS:  $1"; }

STAGED_ONLY=false
[ "${1:-}" = "--staged-only" ] && STAGED_ONLY=true

# ---------------------------------------------------------------------------
# 17. Version string drift
#     cli/index.ts .version() vs CHANGELOG.md latest release vs package.json
# ---------------------------------------------------------------------------
echo "=== 17. Version string drift ==="

CLI_VERSION=$(sed -n 's/.*\.version("\([0-9][0-9.]*\)".*/\1/p' "$FLEET_DIR/cli/index.ts" | head -1)
# Latest non-Unreleased version in CHANGELOG
CHANGELOG_VERSION=$(sed -n 's/^## \[\([0-9][0-9.]*\)\].*/\1/p' "$FLEET_DIR/CHANGELOG.md" | head -1)
# package.json version (may not exist)
PKG_VERSION=""
if [ -f "$FLEET_DIR/package.json" ]; then
  PKG_VERSION=$(sed -n 's/.*"version": *"\([0-9][0-9.]*\)".*/\1/p' "$FLEET_DIR/package.json" | head -1)
fi

DRIFT=false
if [ "$CLI_VERSION" != "$CHANGELOG_VERSION" ]; then
  err "CLI version ($CLI_VERSION) != CHANGELOG latest ($CHANGELOG_VERSION)"
  DRIFT=true
fi
if [ -n "$PKG_VERSION" ] && [ "$PKG_VERSION" != "$CLI_VERSION" ]; then
  err "package.json version ($PKG_VERSION) != CLI version ($CLI_VERSION)"
  DRIFT=true
fi
if ! $DRIFT; then
  pass "Version consistent: $CLI_VERSION"
fi

# ---------------------------------------------------------------------------
# 18. Changelog freshness
#     If cli/ or mcp/ source files changed, [Unreleased] should have entries
# ---------------------------------------------------------------------------
echo ""
echo "=== 18. Changelog freshness ==="

if $STAGED_ONLY; then
  CHANGED_SRC=$(git diff --cached --name-only -- 'cli/' 'mcp/' 2>/dev/null || true)
else
  # Check uncommitted changes
  CHANGED_SRC=$(git diff --name-only -- 'cli/' 'mcp/' 2>/dev/null || true)
  CHANGED_SRC="$CHANGED_SRC$(git diff --cached --name-only -- 'cli/' 'mcp/' 2>/dev/null || true)"
fi

if [ -n "$CHANGED_SRC" ]; then
  # Check if [Unreleased] section has content (non-empty lines between [Unreleased] and next ##)
  UNRELEASED_CONTENT=$(sed -n '/^## \[Unreleased\]/,/^## \[/p' "$FLEET_DIR/CHANGELOG.md" \
    | grep -v '^## ' | grep -v '^$' | grep -v '^---' | head -1)
  if [ -z "$UNRELEASED_CONTENT" ]; then
    warn "Source files changed in cli/ or mcp/ but [Unreleased] section is empty"
  else
    pass "Changelog [Unreleased] has entries"
  fi
else
  pass "No cli/mcp source changes — changelog check skipped"
fi

# ---------------------------------------------------------------------------
# 19. Secrets in staged diff
#     Scan for tokens, passwords, secrets, Bearer in staged changes
# ---------------------------------------------------------------------------
echo ""
echo "=== 19. Secrets in staged diff ==="

if $STAGED_ONLY; then
  DIFF_CONTENT=$(git diff --cached 2>/dev/null || true)
else
  DIFF_CONTENT=$(git diff --cached 2>/dev/null || true)
  DIFF_CONTENT="$DIFF_CONTENT$(git diff 2>/dev/null || true)"
fi

if [ -n "$DIFF_CONTENT" ]; then
  # Only scan added lines (lines starting with +, not +++ file headers)
  ADDED_LINES=$(echo "$DIFF_CONTENT" | grep '^+[^+]' || true)

  if [ -n "$ADDED_LINES" ]; then
    # Filter out allowlisted patterns: type definitions, doc examples, test fixtures, comments
    SUSPECT=$(echo "$ADDED_LINES" \
      | grep -iE '(token|password|secret|bearer|api_key|apikey)[[:space:]]*[:=]' \
      | grep -v '// ' \
      | grep -v '\.test\.' \
      | grep -v 'type ' \
      | grep -v 'interface ' \
      | grep -v '\.md' \
      | grep -v 'example' \
      | grep -v 'placeholder' \
      | grep -v 'FLEET_MAIL_TOKEN' \
      | grep -v 'process\.env\.' \
      | grep -v 'getenv\|os\.environ' \
      | grep -v '"\$' \
      | grep -v 'description' \
      | grep -v 'note=' \
      || true)

    if [ -n "$SUSPECT" ]; then
      err "Potential secrets found in diff:"
      echo "$SUSPECT" | head -5
      [ "$(echo "$SUSPECT" | wc -l)" -gt 5 ] && echo "  ... and more"
    else
      pass "No secrets detected in added lines"
    fi
  else
    pass "No added lines to scan"
  fi
else
  pass "No diff to scan"
fi

# ---------------------------------------------------------------------------
# 20. Import boundary violation
#     mcp/worker-fleet/ must not import from cli/
#     cli/ must not import from mcp/
# ---------------------------------------------------------------------------
echo ""
echo "=== 20. Import boundary violation ==="

BOUNDARY_ERRORS=0

# mcp importing from cli
MCP_TO_CLI=$(grep -rn 'from.*["\x27]\.\./\.\./cli/' "$FLEET_DIR/mcp/" 2>/dev/null \
  || grep -rn 'require.*cli/' "$FLEET_DIR/mcp/" 2>/dev/null \
  || true)
if [ -n "$MCP_TO_CLI" ]; then
  err "mcp/ imports from cli/:"
  echo "$MCP_TO_CLI"
  BOUNDARY_ERRORS=$((BOUNDARY_ERRORS + 1))
fi

# cli importing from mcp
CLI_TO_MCP=$(grep -rn 'from.*["\x27]\.\./\.\./mcp/' "$FLEET_DIR/cli/" 2>/dev/null \
  || grep -rn 'require.*mcp/' "$FLEET_DIR/cli/" 2>/dev/null \
  || true)
if [ -n "$CLI_TO_MCP" ]; then
  err "cli/ imports from mcp/:"
  echo "$CLI_TO_MCP"
  BOUNDARY_ERRORS=$((BOUNDARY_ERRORS + 1))
fi

if [ "$BOUNDARY_ERRORS" -eq 0 ]; then
  pass "No cross-boundary imports between cli/ and mcp/"
fi

# ---------------------------------------------------------------------------
# 21. MCP tool count drift
#     CLAUDE.md "MCP tools (N)" must match actual tool registrations
# ---------------------------------------------------------------------------
echo ""
echo "=== 21. MCP tool count drift ==="

# Documented count from CLAUDE.md header
DOC_COUNT=$(sed -n 's/.*MCP tools (\([0-9]*\)).*/\1/p' "$FLEET_DIR/CLAUDE.md" | head -1)

# Actual count from index.ts header comment
ACTUAL_COUNT=$(sed -n 's/^ \* \([0-9]*\) tools.*/\1/p' "$FLEET_DIR/mcp/worker-fleet/index.ts" | head -1)

# Fallback: count tool registrations by scanning for tool function names in tools/*.ts
if [ -z "$ACTUAL_COUNT" ]; then
  # Count unique server.tool() calls or tool name strings
  ACTUAL_COUNT=$(grep -rh 'server\.tool(' "$FLEET_DIR/mcp/worker-fleet/tools/" 2>/dev/null \
    | wc -l | tr -d ' ')
fi

if [ -n "$DOC_COUNT" ] && [ -n "$ACTUAL_COUNT" ]; then
  if [ "$DOC_COUNT" != "$ACTUAL_COUNT" ]; then
    err "CLAUDE.md says MCP tools ($DOC_COUNT) but actual count is $ACTUAL_COUNT"
  else
    pass "MCP tool count matches: $DOC_COUNT"
  fi
else
  warn "Could not determine tool counts (doc=$DOC_COUNT, actual=$ACTUAL_COUNT)"
fi

# Also check the tool table row count in CLAUDE.md
TABLE_ROWS=$(sed -n '/^## MCP tools/,/^## /p' "$FLEET_DIR/CLAUDE.md" \
  | grep '^| `' | wc -l | tr -d ' ')
if [ -n "$ACTUAL_COUNT" ] && [ "$TABLE_ROWS" -gt 0 ]; then
  if [ "$TABLE_ROWS" != "$ACTUAL_COUNT" ]; then
    warn "CLAUDE.md tool table has $TABLE_ROWS rows but $ACTUAL_COUNT tools registered"
  else
    pass "Tool table row count matches: $TABLE_ROWS"
  fi
fi

# ---------------------------------------------------------------------------
# 22. Idempotency regression (advisory — can't fully test without side effects)
#     Check for obvious anti-patterns: append-without-check, push-without-dedup
# ---------------------------------------------------------------------------
echo ""
echo "=== 22. Idempotency regression (heuristic) ==="

IDEMP_ISSUES=0

# Check setup-hooks.sh for append patterns without existence checks
if [ -f "$FLEET_DIR/scripts/setup-hooks.sh" ]; then
  # Look for raw file appends (>>) without preceding if/grep guard
  APPEND_LINES=$(grep -n '>>' "$FLEET_DIR/scripts/setup-hooks.sh" \
    | grep -v '#' | grep -v 'log' || true)
  if [ -n "$APPEND_LINES" ]; then
    # Check if each append has a guard within 3 lines before it
    while IFS= read -r line; do
      LINENO_NUM=$(echo "$line" | cut -d: -f1)
      START=$((LINENO_NUM > 3 ? LINENO_NUM - 3 : 1))
      CONTEXT=$(sed -n "${START},${LINENO_NUM}p" "$FLEET_DIR/scripts/setup-hooks.sh")
      if ! echo "$CONTEXT" | grep -qE 'if |grep -q|test |^\['; then
        warn "setup-hooks.sh:$LINENO_NUM — append (>>) without guard (possible duplicate on re-run)"
        IDEMP_ISSUES=$((IDEMP_ISSUES + 1))
      fi
    done <<< "$APPEND_LINES"
  fi
fi

# Check fleet setup (cli/commands/) for push-without-dedup patterns
for f in "$FLEET_DIR"/cli/commands/setup*.ts "$FLEET_DIR"/cli/commands/onboard*.ts; do
  [ -f "$f" ] || continue
  # Look for .push() without a preceding .includes() or .find() check
  PUSH_LINES=$(grep -n '\.push(' "$f" | grep -v '//' || true)
  if [ -n "$PUSH_LINES" ]; then
    while IFS= read -r line; do
      LINENO_NUM=$(echo "$line" | cut -d: -f1)
      START=$((LINENO_NUM > 5 ? LINENO_NUM - 5 : 1))
      CONTEXT=$(sed -n "${START},${LINENO_NUM}p" "$f")
      if ! echo "$CONTEXT" | grep -qE 'includes|find\(|some\(|has\(|indexOf|filter'; then
        warn "$(basename "$f"):$LINENO_NUM — .push() without dedup check (possible duplicate on re-run)"
        IDEMP_ISSUES=$((IDEMP_ISSUES + 1))
      fi
    done <<< "$PUSH_LINES"
  fi
done

if [ "$IDEMP_ISSUES" -eq 0 ]; then
  pass "No obvious idempotency anti-patterns detected"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "==========================================="
if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
  echo "All checks passed (items 17-22)"
  exit 0
elif [ "$ERRORS" -eq 0 ]; then
  echo "$WARNINGS warning(s), 0 errors (items 17-22)"
  exit 0
else
  echo "$ERRORS error(s), $WARNINGS warning(s) (items 17-22)"
  echo "Fix errors before committing."
  exit 1
fi
