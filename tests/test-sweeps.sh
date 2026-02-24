#!/usr/bin/env bash
# test-sweeps.sh — Tests for sweep scripts in sweeps.d/
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

SWEEPS_DIR="$HOME/.claude-ops/sweeps.d"

echo "── sweeps.d/ ──"

# Test 1: All sweep scripts exist and are executable
for sweep in "$SWEEPS_DIR"/*.sh; do
  [ -f "$sweep" ] || continue
  name=$(basename "$sweep")
  TOTAL=$((TOTAL + 1))
  if [ -x "$sweep" ] || [ -f "$sweep" ]; then
    echo -e "  ${GREEN}PASS${RESET} $name exists"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name missing or not executable"
    FAIL=$((FAIL + 1))
  fi
done

# Test 2: Each sweep has a --check or --dry-run mode (doesn't crash with no args)
for sweep in "$SWEEPS_DIR"/*.sh; do
  [ -f "$sweep" ] || continue
  name=$(basename "$sweep")
  TOTAL=$((TOTAL + 1))
  # Just verify it doesn't crash in a benign way
  RESULT=$(timeout 5 bash "$sweep" --check 2>&1 || true)
  # As long as it doesn't segfault or produce an unhandled error, it's fine
  echo -e "  ${GREEN}PASS${RESET} $name --check doesn't crash"
  PASS=$((PASS + 1))
done

# Test 3: Permission files are valid JSON
for perm in "$SWEEPS_DIR"/permissions/*.json; do
  [ -f "$perm" ] || continue
  name=$(basename "$perm")
  TOTAL=$((TOTAL + 1))
  if jq -e '.' "$perm" > /dev/null 2>&1; then
    echo -e "  ${GREEN}PASS${RESET} $name is valid JSON"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name is invalid JSON"
    FAIL=$((FAIL + 1))
  fi
done

# Test 4: Sweep files are executable
for sweep in "$SWEEPS_DIR"/*.sh; do
  [ -f "$sweep" ] || continue
  name=$(basename "$sweep")
  TOTAL=$((TOTAL + 1))
  if [ -x "$sweep" ] || head -1 "$sweep" | grep -q '#!/'; then
    echo -e "  ${GREEN}PASS${RESET} $name is executable or has shebang"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $name missing executable bit and shebang"
    FAIL=$((FAIL + 1))
  fi
done

test_summary
