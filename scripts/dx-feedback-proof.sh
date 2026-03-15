#!/usr/bin/env bash
# scripts/dx-feedback-proof.sh — Generate proof template for DX feedback findings.
#
# Usage:
#   bash scripts/dx-feedback-proof.sh              # print template to stdout
#   bash scripts/dx-feedback-proof.sh --write      # write to .git/dx-feedback/{SHA}-proof.xml
#   bash scripts/dx-feedback-proof.sh --edit       # write + open in $EDITOR
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHA=$(git rev-parse HEAD)
GIT_DIR="$(git rev-parse --absolute-git-dir)"
DXF_DIR="$GIT_DIR/dx-feedback"
FEEDBACK="$DXF_DIR/${SHA}.md"
PROOF="$DXF_DIR/${SHA}-proof.xml"

if [ ! -f "$FEEDBACK" ]; then
  echo "No DX feedback found for commit $SHA."
  echo "Run 'git push' first to trigger the DX feedback pipeline."
  exit 1
fi

if [ "${1:-}" = "--write" ] || [ "${1:-}" = "--edit" ]; then
  mkdir -p "$DXF_DIR"
  bun run "$SCRIPT_DIR/dx-feedback-gate.ts" --sha "$SHA" --feedback "$FEEDBACK" --generate-template > "$PROOF"
  echo "Proof template written to: $PROOF"
  echo "Fill in status (addressed|wontfix|skip) and note for each finding, then push again."
  if [ "${1:-}" = "--edit" ] && [ -n "${EDITOR:-}" ]; then
    "$EDITOR" "$PROOF"
  fi
else
  bun run "$SCRIPT_DIR/dx-feedback-gate.ts" --sha "$SHA" --feedback "$FEEDBACK" --generate-template
fi
