#!/usr/bin/env bash
# worker-commit.sh — Structured commit helper for flat workers.
# Validates format, auto-fills metadata, optionally runs verification.
#
# Usage:
#   bash worker-commit.sh "fix(chatbot): prevent identity spoofing [R01]"
#   bash worker-commit.sh "fix(chatbot): prevent identity spoofing [R01]" \
#     --verified-test --verified-tsc --verified-deploy
#   bash worker-commit.sh --interactive
#
# Must be run from a worker worktree (branch: worker/<name>).
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────
# Resolve paths
# ──────────────────────────────────────────────────────────────────────

WORKTREE_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
WORKER_NAME="${BRANCH#worker/}"

# Find main repo root (worktree parent)
MAIN_ROOT="$WORKTREE_ROOT"
if [ -f "$WORKTREE_ROOT/.git" ]; then
  MAIN_ROOT=$(grep gitdir "$WORKTREE_ROOT/.git" | sed 's/gitdir: //' | sed 's|/.git/worktrees/.*||')
fi

WORKER_DIR="$MAIN_ROOT/.claude/workers/$WORKER_NAME"
STATE_FILE="$WORKER_DIR/state.json"
TEMPLATE="$MAIN_ROOT/.claude/workers/.commit-template.md"

# ──────────────────────────────────────────────────────────────────────
# Parse arguments
# ──────────────────────────────────────────────────────────────────────

SUBJECT=""
INTERACTIVE=0
VERIFIED_TEST=0
VERIFIED_TSC=0
VERIFIED_DEPLOY=0
VERIFIED_ENDPOINT=0
SCREENSHOT_PATH=""
EXTRA_CHANGES=""
FILES_TO_ADD=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interactive)       INTERACTIVE=1; shift ;;
    --verified-test)     VERIFIED_TEST=1; shift ;;
    --verified-tsc)      VERIFIED_TSC=1; shift ;;
    --verified-deploy)   VERIFIED_DEPLOY=1; shift ;;
    --verified-endpoint) VERIFIED_ENDPOINT=1; shift ;;
    --screenshots)       SCREENSHOT_PATH="$2"; shift 2 ;;
    --changes)           EXTRA_CHANGES="$2"; shift 2 ;;
    --add)               FILES_TO_ADD="$2"; shift 2 ;;
    -*)                  echo "Unknown flag: $1"; exit 1 ;;
    *)
      if [ -z "$SUBJECT" ]; then
        SUBJECT="$1"
      else
        echo "Unexpected argument: $1"; exit 1
      fi
      shift
      ;;
  esac
done

# ──────────────────────────────────────────────────────────────────────
# Validate branch
# ──────────────────────────────────────────────────────────────────────

if [[ "$BRANCH" != worker/* ]]; then
  echo "ERROR: Not on a worker branch (current: $BRANCH). Expected: worker/<name>"
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Read state.json
# ──────────────────────────────────────────────────────────────────────

CYCLE=0
if [ -f "$STATE_FILE" ]; then
  CYCLE=$(jq -r '.cycles_completed // 0' "$STATE_FILE" 2>/dev/null || echo 0)
fi

# ──────────────────────────────────────────────────────────────────────
# Interactive mode
# ──────────────────────────────────────────────────────────────────────

if [ "$INTERACTIVE" -eq 1 ]; then
  echo "=== Worker Commit (interactive) ==="
  echo "Worker: $WORKER_NAME | Branch: $BRANCH | Cycle: $CYCLE"
  echo ""

  # Show staged files
  STAGED=$(git diff --cached --name-only 2>/dev/null)
  UNSTAGED=$(git diff --name-only 2>/dev/null)
  if [ -n "$STAGED" ]; then
    echo "Staged files:"
    echo "$STAGED" | sed 's/^/  /'
  fi
  if [ -n "$UNSTAGED" ]; then
    echo "Unstaged changes:"
    echo "$UNSTAGED" | sed 's/^/  /'
  fi
  echo ""

  read -rp "Type (fix/feat/refactor/test/docs/chore): " TYPE
  read -rp "Scope (chatbot/miniapp/admin/dashboard/bi/security/deploy): " SCOPE
  read -rp "Short description: " DESC
  read -rp "Mission item (e.g. R01, F12, or empty): " MISSION_ITEM

  if [ -n "$MISSION_ITEM" ]; then
    SUBJECT="${TYPE}(${SCOPE}): ${DESC} [${MISSION_ITEM}]"
  else
    SUBJECT="${TYPE}(${SCOPE}): ${DESC}"
  fi
  echo ""
  echo "Subject: $SUBJECT"
  read -rp "Proceed? (y/n): " CONFIRM
  [ "$CONFIRM" != "y" ] && { echo "Aborted."; exit 1; }
fi

# ──────────────────────────────────────────────────────────────────────
# Validate subject format
# ──────────────────────────────────────────────────────────────────────

if [ -z "$SUBJECT" ]; then
  echo "ERROR: No commit message provided."
  echo "Usage: worker-commit.sh \"type(scope): description [ITEM]\""
  echo "   or: worker-commit.sh --interactive"
  exit 1
fi

# Validate format: type(scope): description
VALID_TYPES="fix|feat|refactor|test|docs|chore"
VALID_SCOPES="chatbot|miniapp|admin|dashboard|bi|security|deploy"
if ! echo "$SUBJECT" | grep -qE "^(${VALID_TYPES})\((${VALID_SCOPES})\): .+"; then
  echo "WARNING: Subject doesn't match format: type(scope): description"
  echo "  Valid types: fix, feat, refactor, test, docs, chore"
  echo "  Valid scopes: chatbot, miniapp, admin, dashboard, bi, security, deploy"
  echo "  Got: $SUBJECT"
  echo ""
  echo "Proceeding anyway (format warning only, not blocking)..."
fi

# ──────────────────────────────────────────────────────────────────────
# Stage files if --add provided
# ──────────────────────────────────────────────────────────────────────

if [ -n "$FILES_TO_ADD" ]; then
  # shellcheck disable=SC2086
  git add $FILES_TO_ADD
fi

# Check we have something to commit
if git diff --cached --quiet 2>/dev/null; then
  echo "ERROR: Nothing staged to commit. Stage files first or use --add."
  exit 1
fi

# ──────────────────────────────────────────────────────────────────────
# Run verifications (unless pre-verified via flags)
# ──────────────────────────────────────────────────────────────────────

TEST_RESULT="[-] skipped"
TSC_RESULT="[-] skipped"
DEPLOY_RESULT="[-] skipped"
ENDPOINT_RESULT="[-] skipped"
SCREENSHOT_RESULT="N/A"

# Detect if UI files changed (for screenshot hint)
UI_CHANGED=0
if git diff --cached --name-only | grep -qE '\.(tsx|css)$'; then
  UI_CHANGED=1
fi

# bun test
if [ "$VERIFIED_TEST" -eq 1 ]; then
  TEST_RESULT="[x] passed (pre-verified)"
else
  echo "Running bun test..."
  if (cd "$WORKTREE_ROOT" && bun test 2>&1 | tail -5); then
    TEST_RESULT="[x] passed"
  else
    TEST_RESULT="[!] failed (see output above)"
  fi
fi

# tsc --noEmit (on changed files only)
if [ "$VERIFIED_TSC" -eq 1 ]; then
  TSC_RESULT="[x] clean (pre-verified)"
else
  CHANGED_TS=$(git diff --cached --name-only | grep -E '\.tsx?$' || true)
  if [ -n "$CHANGED_TS" ]; then
    echo "Running tsc --noEmit on changed TypeScript files..."
    if (cd "$WORKTREE_ROOT" && bunx tsc --noEmit 2>&1 | tail -10); then
      TSC_RESULT="[x] clean"
    else
      TSC_RESULT="[!] errors (see output above)"
    fi
  else
    TSC_RESULT="[-] no TS files changed"
  fi
fi

# Deploy verification
if [ "$VERIFIED_DEPLOY" -eq 1 ]; then
  DEPLOY_RESULT="[x] deployed (pre-verified)"
fi

# Endpoint verification
if [ "$VERIFIED_ENDPOINT" -eq 1 ]; then
  ENDPOINT_RESULT="[x] verified (pre-verified)"
fi

# Screenshots
if [ -n "$SCREENSHOT_PATH" ]; then
  SCREENSHOT_RESULT="[x] $SCREENSHOT_PATH"
elif [ "$UI_CHANGED" -eq 1 ]; then
  SCREENSHOT_RESULT="[-] UI changed but no screenshots provided"
fi

# ──────────────────────────────────────────────────────────────────────
# Build change list from diff
# ──────────────────────────────────────────────────────────────────────

if [ -z "$EXTRA_CHANGES" ]; then
  # Auto-generate from staged files
  CHANGED_FILES=$(git diff --cached --name-only | head -15)
  CHANGE_BULLETS=""
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    CHANGE_BULLETS="${CHANGE_BULLETS}- ${f}\n"
  done <<< "$CHANGED_FILES"
else
  CHANGE_BULLETS="$EXTRA_CHANGES"
fi

# ──────────────────────────────────────────────────────────────────────
# Detect model from environment (best-effort)
# ──────────────────────────────────────────────────────────────────────

MODEL_NAME="sonnet"
if [ -f "$WORKER_DIR/permissions.json" ]; then
  MODEL_NAME=$(jq -r '.model // "sonnet"' "$WORKER_DIR/permissions.json" 2>/dev/null || echo "sonnet")
fi

# ──────────────────────────────────────────────────────────────────────
# Extract mission item from subject (if present)
# ──────────────────────────────────────────────────────────────────────

MISSION_ITEM=$(echo "$SUBJECT" | grep -oE '\[[A-Z][0-9]+\]' | tr -d '[]' || true)

# ──────────────────────────────────────────────────────────────────────
# Build commit message
# ──────────────────────────────────────────────────────────────────────

COMMIT_BODY=$(cat <<EOF
${SUBJECT}

## What changed
$(echo -e "$CHANGE_BULLETS")
## Verification
- ${TEST_RESULT}
- ${TSC_RESULT}
- ${DEPLOY_RESULT}
- ${ENDPOINT_RESULT}
- Screenshots: ${SCREENSHOT_RESULT}

## Context
- Mission item: ${MISSION_ITEM:-none}
- Worker: ${WORKER_NAME}
- Branch: ${BRANCH}
- Cycle: ${CYCLE}

Co-Authored-By: Claude ${MODEL_NAME} <noreply@anthropic.com>
EOF
)

# ──────────────────────────────────────────────────────────────────────
# Commit
# ──────────────────────────────────────────────────────────────────────

echo ""
echo "=== Commit Message ==="
echo "$COMMIT_BODY"
echo "======================"
echo ""

git commit -m "$COMMIT_BODY"
COMMIT_SHA=$(git rev-parse --short HEAD)

echo ""
echo "Committed: $COMMIT_SHA on $BRANCH"

# ──────────────────────────────────────────────────────────────────────
# Update state.json
# ──────────────────────────────────────────────────────────────────────

if [ -f "$STATE_FILE" ]; then
  TMP=$(mktemp)
  # Increment issues_fixed if this is a fix commit
  IS_FIX=0
  echo "$SUBJECT" | grep -qE '^fix\(' && IS_FIX=1

  if [ "$IS_FIX" -eq 1 ]; then
    jq --arg sha "$COMMIT_SHA" --arg msg "$SUBJECT" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.last_commit_sha = $sha | .last_commit_msg = $msg | .last_commit_at = $ts | .issues_fixed = ((.issues_fixed // 0) + 1)' \
      "$STATE_FILE" > "$TMP" 2>/dev/null && mv "$TMP" "$STATE_FILE" || rm -f "$TMP"
  else
    jq --arg sha "$COMMIT_SHA" --arg msg "$SUBJECT" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      '.last_commit_sha = $sha | .last_commit_msg = $msg | .last_commit_at = $ts' \
      "$STATE_FILE" > "$TMP" 2>/dev/null && mv "$TMP" "$STATE_FILE" || rm -f "$TMP"
  fi
  echo "Updated state.json (last_commit: $COMMIT_SHA)"
fi

# ──────────────────────────────────────────────────────────────────────
# Screenshot reminder
# ──────────────────────────────────────────────────────────────────────

if [ "$UI_CHANGED" -eq 1 ] && [ -z "$SCREENSHOT_PATH" ]; then
  echo ""
  echo "REMINDER: UI files changed (.tsx/.css). Consider capturing screenshots:"
  echo "  Save to: $WORKER_DIR/screenshots/${COMMIT_SHA}-<description>.png"
fi

exit 0
