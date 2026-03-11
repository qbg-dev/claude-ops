#!/usr/bin/env bash
# scripts/verification-hash.sh — Compute the verification proof path for current staged changes.
# Usage: bash scripts/verification-hash.sh
#   Outputs the full path where the proof XML should be written.
#   Hash is derived from staged diff content, so any staging change invalidates it.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
VERIFY_DIR="$REPO_ROOT/.git/verification"
mkdir -p "$VERIFY_DIR"

# Hash the staged diff content — any change to staging invalidates the proof
HASH=$(git diff --cached | shasum -a 256 | cut -c1-16)

# If nothing is staged, hash the empty string (commit will fail anyway, but be consistent)
if [ -z "$HASH" ]; then
  HASH=$(echo -n "" | shasum -a 256 | cut -c1-16)
fi

echo "$VERIFY_DIR/$HASH.xml"
