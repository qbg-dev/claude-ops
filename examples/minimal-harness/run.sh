#!/usr/bin/env bash
# run.sh — Minimal harness example.
#
# Demonstrates:
#   1. Scaffold a bounded harness from scratch
#   2. Populate the task graph
#   3. Register in the manifest
#   4. Verify key files exist
#
# This runs to completion without launching a Claude agent—
# it just sets up the harness and proves scaffold works.
#
# Usage: bash examples/minimal-harness/run.sh
set -euo pipefail

BORING="${BORING_DIR:-$HOME/.boring}"
EXAMPLE_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(mktemp -d /tmp/boring-minimal-XXXXXX)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[minimal-harness]${NC} $*"; }
warn()  { echo -e "${YELLOW}[minimal-harness]${NC} $*"; }

trap 'rm -rf "$PROJECT_DIR"' EXIT

info "Working directory: $PROJECT_DIR"

# ── Step 1: Scaffold the harness ─────────────────────────────────
info "Scaffolding bounded harness 'hello-world' ..."
bash "$BORING/scripts/scaffold.sh" hello-world "$PROJECT_DIR" \
  --from-description "A minimal hello-world harness that greets the user"

# ── Step 2: Populate the task graph ──────────────────────────────
info "Writing task graph ..."
cat > "$PROJECT_DIR/.claude/harness/hello-world/tasks.json" <<'JSON'
{
  "tasks": {
    "T-1": {
      "status": "pending",
      "description": "Read the project README and summarize it in one paragraph",
      "blockedBy": []
    },
    "T-2": {
      "status": "pending",
      "description": "Write a SUMMARY.md with the one-paragraph summary",
      "blockedBy": ["T-1"]
    },
    "T-3": {
      "status": "pending",
      "description": "Update MEMORY.md with key findings and run bus_git_checkpoint",
      "blockedBy": ["T-2"]
    }
  }
}
JSON

# ── Step 3: Write harness context ────────────────────────────────
info "Writing harness context ..."
cat > "$PROJECT_DIR/.claude/harness/hello-world/harness.md" <<'MD'
# hello-world Harness

## Goal
Demonstrate a minimal bounded harness: read a README, write a summary, stop cleanly.

## Terrain Map
- README.md — the file to summarize
- SUMMARY.md — the output file you will create

## Constraints
- Write only SUMMARY.md and MEMORY.md — no other files
- Stage specific files only: `git add SUMMARY.md`
- Never push to main without operator approval

## When You're Done
Run bus_git_checkpoint and update MEMORY.md before stopping.
MD

# ── Step 4: Verify key files ────────────────────────────────────
info "Verifying scaffolded files ..."
REQUIRED=(
  "$PROJECT_DIR/.claude/harness/hello-world/tasks.json"
  "$PROJECT_DIR/.claude/harness/hello-world/harness.md"
  "$PROJECT_DIR/.claude/harness/hello-world/policy.json"
  "$PROJECT_DIR/.claude/harness/hello-world/agents/module-manager/config.json"
  "$PROJECT_DIR/.claude/harness/hello-world/agents/module-manager/state.json"
  "$PROJECT_DIR/.claude/harness/hello-world/agents/module-manager/MEMORY.md"
  "$PROJECT_DIR/.claude/harness/hello-world/agents/module-manager/inbox.jsonl"
  "$PROJECT_DIR/.claude/harness/hello-world/agents/module-manager/permissions.json"
  "$PROJECT_DIR/.claude/harness/hello-world/agents/module-manager/mission.md"
  "$PROJECT_DIR/.claude/scripts/hello-world-seed.sh"
)

ALL_OK=true
for f in "${REQUIRED[@]}"; do
  if [ -f "$f" ]; then
    info "  ✓ $(basename "$(dirname "$f")")/$(basename "$f")"
  else
    warn "  ✗ MISSING: $f"
    ALL_OK=false
  fi
done

# ── Step 5: Show seed generation ─────────────────────────────────
info "Generating seed prompt (preview) ..."
SEED=$(bash "$PROJECT_DIR/.claude/scripts/hello-world-seed.sh" 2>/dev/null | head -5)
echo "$SEED"
echo "  [... seed continues ...]"

# ── Result ────────────────────────────────────────────────────────
echo ""
if [ "$ALL_OK" = "true" ]; then
  info "Minimal harness example passed."
  echo ""
  echo "  To launch an agent against this harness:"
  echo "    bash $PROJECT_DIR/.claude/scripts/hello-world-seed.sh > /tmp/seed.txt"
  echo "    cat /tmp/seed.txt | claude --dangerously-skip-permissions --model claude-sonnet-4-6"
else
  echo -e "${RED}Some files were missing. Check output above.${NC}" >&2
  exit 1
fi
