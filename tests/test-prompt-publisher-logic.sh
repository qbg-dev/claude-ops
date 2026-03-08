#!/usr/bin/env bash
# test-prompt-publisher-logic.sh — Unit tests for prompt-publisher.sh logic:
# dedup, graceful-stop sentinel cancellation, content flags, session.start, and error handling.
set -uo pipefail

source "$(dirname "$0")/helpers.sh"

PUBLISHER_SH="$HOME/.claude-ops/hooks/publishers/prompt-publisher.sh"

# ══════════════════════════════════════════════════════════════════════
# Dedup logic
# ══════════════════════════════════════════════════════════════════════
echo "── prompt-publisher: dedup logic ──"

# Test: uses MD5 hash for dedup
assert_file_contains "dedup uses md5 hash" "$PUBLISHER_SH" "md5"

# Test: stores hash in .last_hash file
assert_file_contains "dedup stores hash in .last_hash" "$PUBLISHER_SH" ".last_hash"

# Test: compares current hash with stored hash
assert_file_contains "dedup compares hashes" "$PUBLISHER_SH" "DEDUP_HASH"

# Test: skips on duplicate (exits 0 with {})
TOTAL=$((TOTAL + 1))
DEDUP_SKIP=$(grep -A2 'cat "$DEDUP_FILE"' "$PUBLISHER_SH" | grep -c "exit 0" || echo 0)
if [ "$DEDUP_SKIP" -ge 1 ]; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} dedup exits 0 on duplicate prompt"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} dedup doesn't exit on duplicate"
fi

# Test: dedup dir derived from project name
assert_file_contains "dedup scoped to project" "$PUBLISHER_SH" 'PROJECT=$(basename "$CWD")'

# ══════════════════════════════════════════════════════════════════════
# Graceful-stop sentinel cancellation
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── prompt-publisher: graceful-stop cancel ──"

# Test: checks for graceful-stop sentinel
assert_file_contains "checks graceful-stop file" "$PUBLISHER_SH" "graceful-stop"

# Test: removes sentinel on new activity
assert_file_contains "removes sentinel on new input" "$PUBLISHER_SH" 'rm -f "$_GS_FILE"'

# Test: sentinel path is session-scoped
assert_file_contains "sentinel path includes session ID" "$PUBLISHER_SH" 'sessions/$SESSION_ID/graceful-stop'

# ══════════════════════════════════════════════════════════════════════
# Content flags detection
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── prompt-publisher: content flags ──"

# Test: detects code blocks
assert_file_contains "detects code blocks (triple backtick)" "$PUBLISHER_SH" '```'

# Test: detects URLs
assert_file_contains "detects URLs" "$PUBLISHER_SH" 'https?://'

# Test: detects file paths
assert_file_contains "detects file paths" "$PUBLISHER_SH" 'HAS_FILE_PATH='

# Test: detects questions
assert_file_contains "detects questions" "$PUBLISHER_SH" 'IS_QUESTION='

# Test: detects slash commands
assert_file_contains "detects slash commands" "$PUBLISHER_SH" 'IS_SLASH_COMMAND='
assert_file_contains "extracts slash command name" "$PUBLISHER_SH" 'SLASH_COMMAND='

# ══════════════════════════════════════════════════════════════════════
# Session.start event
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── prompt-publisher: session.start event ──"

# Test: publishes session.start on first prompt
assert_file_contains "publishes session.start" "$PUBLISHER_SH" 'session.start'

# Test: uses marker file to avoid duplicate session.start
assert_file_contains "uses session-started marker" "$PUBLISHER_SH" "session-started"

# Test: marker is per-session
assert_file_contains "marker scoped to session" "$PUBLISHER_SH" 'sessions/$SESSION_ID/session-started'

# ══════════════════════════════════════════════════════════════════════
# Error handling
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── prompt-publisher: error handling ──"

# Test: always outputs {} even on error (ERR trap)
assert_file_contains "ERR trap outputs {}" "$PUBLISHER_SH" "trap 'echo \"{}\"; exit 0' ERR"

# Test: empty prompt → early exit
assert_file_contains "exits on empty prompt" "$PUBLISHER_SH" '[ -z "$PROMPT" ]'

# Test: bus_publish failure is non-fatal
TOTAL=$((TOTAL + 1))
if grep -q 'bus_publish.*||' "$PUBLISHER_SH" 2>/dev/null; then
  PASS=$((PASS + 1))
  echo -e "  ${GREEN}PASS${RESET} bus_publish failure is non-fatal"
else
  FAIL=$((FAIL + 1))
  echo -e "  ${RED}FAIL${RESET} bus_publish failure may be fatal (no || handler)"
fi

# ══════════════════════════════════════════════════════════════════════
# Bus payload structure
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── prompt-publisher: bus payload ──"

# Test: payload includes all required fields
assert_file_contains "payload has type field" "$PUBLISHER_SH" 'type "prompt"'
assert_file_contains "payload has session_id" "$PUBLISHER_SH" 'sid "$SESSION_ID"'
assert_file_contains "payload has harness" "$PUBLISHER_SH" 'harness'
assert_file_contains "payload has char_count" "$PUBLISHER_SH" 'char_count'
assert_file_contains "payload has word_count" "$PUBLISHER_SH" 'word_count'

# Test: git context collection
assert_file_contains "collects git branch" "$PUBLISHER_SH" "git_branch"
assert_file_contains "collects git repo" "$PUBLISHER_SH" "git_repo"

# Test: system context
assert_file_contains "collects hostname" "$PUBLISHER_SH" "hostname"

# ══════════════════════════════════════════════════════════════════════
# Content flag regex patterns — unit test actual detection
# ══════════════════════════════════════════════════════════════════════
echo ""
echo "── prompt-publisher: content flag regex validation ──"

# URL detection pattern
URL_PATTERN='https?://'
echo "Visit https://example.com for details" | grep -qE "$URL_PATTERN" && S="match" || S="no"
assert_equals "URL detected in text" "match" "$S"

echo "No links here" | grep -qE "$URL_PATTERN" && S="match" || S="no"
assert_equals "no URL in plain text" "no" "$S"

# Slash command detection pattern
SLASH_PATTERN='^/[a-zA-Z]'
echo "/commit -m fix" | grep -qE "$SLASH_PATTERN" && S="match" || S="no"
assert_equals "slash command detected: /commit" "match" "$S"

echo "// comment" | grep -qE "$SLASH_PATTERN" && S="match" || S="no"
assert_equals "double slash is not slash command" "no" "$S"

echo "fix the /path/to/file" | grep -qE "$SLASH_PATTERN" && S="match" || S="no"
assert_equals "mid-text path is not slash command" "no" "$S"

# File path detection
FILE_PATH_PATTERN='(^|[[:space:]])(\/[a-zA-Z0-9_./-]+|~\/[a-zA-Z0-9_./-]+|\.\/[a-zA-Z0-9_./-]+)'
echo "Edit ~/Documents/file.txt please" | grep -qE "$FILE_PATH_PATTERN" && S="match" || S="no"
assert_equals "file path detected: ~/Documents/file.txt" "match" "$S"

echo "Look at ./src/main.ts" | grep -qE "$FILE_PATH_PATTERN" && S="match" || S="no"
assert_equals "relative file path detected: ./src/main.ts" "match" "$S"

echo "Check /etc/hosts" | grep -qE "$FILE_PATH_PATTERN" && S="match" || S="no"
assert_equals "absolute path detected: /etc/hosts" "match" "$S"

echo "Just a normal message" | grep -qE "$FILE_PATH_PATTERN" && S="match" || S="no"
assert_equals "no file path in normal text" "no" "$S"

test_summary
