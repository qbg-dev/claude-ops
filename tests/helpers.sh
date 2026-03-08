#!/usr/bin/env bash
# helpers.sh — Shared test utilities for the harness test suite.
# Source this in each test file: source "$(dirname "$0")/helpers.sh"

PASS=0
FAIL=0
TOTAL=0

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

assert() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$actual" | grep -qF -- "$expected"; then
    echo -e "  ${GREEN}PASS${RESET} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    expected to contain: $expected"
    echo "    got: $(echo "$actual" | head -3)"
    FAIL=$((FAIL + 1))
  fi
}

assert_equals() {
  local name="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$expected" = "$actual" ]; then
    echo -e "  ${GREEN}PASS${RESET} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    expected: $expected"
    echo "    got: $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_not_empty() {
  local name="$1" actual="$2"
  TOTAL=$((TOTAL + 1))
  if [ -n "$actual" ] && [ "$actual" != "{}" ]; then
    echo -e "  ${GREEN}PASS${RESET} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    expected non-empty value, got: '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_empty() {
  local name="$1" actual="$2"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "{}" ] || [ -z "$actual" ]; then
    echo -e "  ${GREEN}PASS${RESET} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    expected empty/{}  got: $(echo "$actual" | head -2)"
    FAIL=$((FAIL + 1))
  fi
}

assert_exit() {
  local name="$1" expected_code="$2"
  shift 2
  TOTAL=$((TOTAL + 1))
  local actual_code=0
  "$@" > /dev/null 2>&1 || actual_code=$?
  if [ "$actual_code" -eq "$expected_code" ]; then
    echo -e "  ${GREEN}PASS${RESET} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    expected exit $expected_code, got $actual_code"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_exists() {
  local name="$1" file="$2"
  TOTAL=$((TOTAL + 1))
  if [ -f "$file" ]; then
    echo -e "  ${GREEN}PASS${RESET} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    file not found: $file"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_contains() {
  local name="$1" file="$2" expected="$3"
  TOTAL=$((TOTAL + 1))
  if [ -f "$file" ] && grep -qF -- "$expected" "$file" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} $name"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    file: $file"
    echo "    expected to contain: $expected"
    FAIL=$((FAIL + 1))
  fi
}

assert_symlink() {
  local name="$1" link="$2" target="$3"
  TOTAL=$((TOTAL + 1))
  if [ -L "$link" ]; then
    local actual_target=$(readlink "$link")
    if [ "$actual_target" = "$target" ]; then
      echo -e "  ${GREEN}PASS${RESET} $name"
      PASS=$((PASS + 1))
    else
      echo -e "  ${RED}FAIL${RESET} $name"
      echo "    symlink points to: $actual_target"
      echo "    expected: $target"
      FAIL=$((FAIL + 1))
    fi
  else
    echo -e "  ${RED}FAIL${RESET} $name"
    echo "    not a symlink: $link"
    FAIL=$((FAIL + 1))
  fi
}

# Print test summary and return exit code
test_summary() {
  echo ""
  echo -e "  ${GREEN}$PASS passed${RESET}, ${RED}$FAIL failed${RESET}, $TOTAL total"
  [ "$FAIL" -eq 0 ] && return 0 || return 1
}
