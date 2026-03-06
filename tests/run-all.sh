#!/usr/bin/env bash
# run-all.sh — Run the full harness test suite.
# Usage: bash ~/.claude-ops/tests/run-all.sh
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_TESTS=0
SUITE_PASS=0
SUITE_FAIL=0
FAILED_SUITES=()

echo "════════════════════════════════════════"
echo "  Harness Test Suite"
echo "════════════════════════════════════════"
echo ""

for test in "$TESTS_DIR"/test-*.sh; do
  [ -f "$test" ] || continue
  NAME=$(basename "$test")

  # Allow CI / callers to skip environment-specific suites
  if [[ -n "${CLAUDE_OPS_SKIP_SUITES:-}" ]]; then
    BASENAME="${NAME%.sh}"
    SKIP=false
    for skip_name in $CLAUDE_OPS_SKIP_SUITES; do
      [[ "$BASENAME" == "$skip_name" ]] && SKIP=true && break
    done
    if [[ "$SKIP" == "true" ]]; then
      echo "── $NAME ── [SKIPPED]"
      echo ""
      continue
    fi
  fi

  # Run the test and capture output + exit code
  OUTPUT=$(bash "$test" 2>&1) || true
  EXIT_CODE=$?

  echo "$OUTPUT"

  # Extract pass/fail counts from the summary line
  PASS=$(echo "$OUTPUT" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+' || echo 0)
  FAIL=$(echo "$OUTPUT" | grep -oE '[0-9]+ failed' | grep -oE '[0-9]+' || echo 0)
  TESTS=$(echo "$OUTPUT" | grep -oE '[0-9]+ total' | grep -oE '[0-9]+' || echo 0)

  TOTAL_PASS=$((TOTAL_PASS + PASS))
  TOTAL_FAIL=$((TOTAL_FAIL + FAIL))
  TOTAL_TESTS=$((TOTAL_TESTS + TESTS))

  if [ "$FAIL" -eq 0 ] && [ "$EXIT_CODE" -eq 0 ]; then
    SUITE_PASS=$((SUITE_PASS + 1))
  else
    SUITE_FAIL=$((SUITE_FAIL + 1))
    FAILED_SUITES+=("$NAME")
  fi

  echo ""
done

echo "════════════════════════════════════════"
echo "  GRAND TOTAL"
echo "════════════════════════════════════════"
echo -e "  Suites:  ${GREEN}$SUITE_PASS passed${RESET}, ${RED}$SUITE_FAIL failed${RESET}"
echo -e "  Tests:   ${GREEN}$TOTAL_PASS passed${RESET}, ${RED}$TOTAL_FAIL failed${RESET}, $TOTAL_TESTS total"

if [ ${#FAILED_SUITES[@]} -gt 0 ]; then
  echo ""
  echo -e "  ${RED}Failed suites:${RESET}"
  for s in "${FAILED_SUITES[@]}"; do
    echo "    - $s"
  done
fi

echo "════════════════════════════════════════"

[ "$TOTAL_FAIL" -eq 0 ] && exit 0 || exit 1
