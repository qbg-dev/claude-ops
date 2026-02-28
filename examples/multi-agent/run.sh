#!/usr/bin/env bash
# run.sh — Multi-agent harness example.
#
# Demonstrates:
#   1. Coordinator harness (module-manager) with task assignments
#   2. Two worker harnesses that claim and execute tasks
#   3. Inter-agent messaging via the event bus
#   4. Task ownership and status propagation
#
# This script scaffolds both harnesses and validates the structure.
# It does NOT launch actual agents (safe for CI).
#
# Usage: bash examples/multi-agent/run.sh
set -euo pipefail

BORING="${BORING_DIR:-$HOME/.boring}"
PROJECT_DIR="$(mktemp -d /tmp/boring-multi-XXXXXX)"

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[multi-agent]${NC} $*"; }
warn()  { echo -e "${YELLOW}[multi-agent]${NC} $*"; }

trap 'rm -rf "$PROJECT_DIR"' EXIT

info "Working directory: $PROJECT_DIR"
cd "$PROJECT_DIR" && git init -q && git commit --allow-empty -m "init" -q

# ── Step 1: Scaffold coordinator ─────────────────────────────────
info "Scaffolding coordinator harness ..."
bash "$BORING/scripts/scaffold.sh" code-review "$PROJECT_DIR" \
  --from-description "Coordinate parallel code review across multiple workers"

# ── Step 2: Populate coordinator task graph ───────────────────────
info "Writing coordinator task graph ..."
cat > "$PROJECT_DIR/.claude/harness/code-review/tasks.json" <<'JSON'
{
  "tasks": {
    "T-1": {
      "status": "pending",
      "description": "Scan the codebase and divide review work into 2 batches",
      "blockedBy": [],
      "owner": null
    },
    "T-2": {
      "status": "pending",
      "description": "Launch worker-alpha; assign it batch 1 (src/api/)",
      "blockedBy": ["T-1"],
      "owner": null
    },
    "T-3": {
      "status": "pending",
      "description": "Launch worker-beta; assign it batch 2 (src/ui/)",
      "blockedBy": ["T-1"],
      "owner": null
    },
    "T-4": {
      "status": "pending",
      "description": "Wait for both workers; collect findings; write REVIEW.md",
      "blockedBy": ["T-2", "T-3"],
      "owner": null
    }
  }
}
JSON

# ── Step 3: Scaffold worker harnesses ────────────────────────────
info "Scaffolding worker harnesses ..."
bash "$BORING/scripts/scaffold.sh" "code-review/worker-alpha" "$PROJECT_DIR" \
  --from-description "Review src/api/ for bugs and security issues"
bash "$BORING/scripts/scaffold.sh" "code-review/worker-beta" "$PROJECT_DIR" \
  --from-description "Review src/ui/ for bugs and accessibility issues"

# Write worker task graphs
info "Writing worker task graphs ..."
cat > "$PROJECT_DIR/.claude/harness/code-review/worker-alpha/tasks.json" <<'JSON'
{
  "tasks": {
    "W-1": {
      "status": "pending",
      "description": "Read all files in src/api/ and note issues",
      "blockedBy": []
    },
    "W-2": {
      "status": "pending",
      "description": "Write findings to claude_files/review-api.md",
      "blockedBy": ["W-1"]
    },
    "W-3": {
      "status": "pending",
      "description": "Publish task.completed to notify coordinator",
      "blockedBy": ["W-2"]
    }
  }
}
JSON

cat > "$PROJECT_DIR/.claude/harness/code-review/worker-beta/tasks.json" <<'JSON'
{
  "tasks": {
    "W-1": {
      "status": "pending",
      "description": "Read all files in src/ui/ and note issues",
      "blockedBy": []
    },
    "W-2": {
      "status": "pending",
      "description": "Write findings to claude_files/review-ui.md",
      "blockedBy": ["W-1"]
    },
    "W-3": {
      "status": "pending",
      "description": "Publish task.completed to notify coordinator",
      "blockedBy": ["W-2"]
    }
  }
}
JSON

# ── Step 4: Initialize the event bus ────────────────────────────
info "Initializing event bus ..."
source "$BORING/lib/event-bus.sh"
bus_publish "worker.started" '{"harness":"code-review","worker":"code-review/worker-alpha","task_id":"W-1"}' 2>/dev/null || true
bus_publish "worker.started" '{"harness":"code-review","worker":"code-review/worker-beta","task_id":"W-1"}' 2>/dev/null || true

# ── Step 5: Verify all structures ────────────────────────────────
info "Verifying coordinator + workers ..."
for harness in "code-review" "code-review/worker-alpha" "code-review/worker-beta"; do
  dir="$PROJECT_DIR/.claude/harness/$harness"
  if [ -f "$dir/tasks.json" ] && [ -f "$dir/agents/module-manager/config.json" ]; then
    info "  ✓ $harness"
  else
    warn "  ✗ $harness (missing files)"
    exit 1
  fi
done

# ── Result ────────────────────────────────────────────────────────
echo ""
info "Multi-agent harness example passed."
echo ""
echo "  Coordinator: code-review"
echo "  Workers: code-review/worker-alpha, code-review/worker-beta"
echo ""
echo "  To run the coordinator agent:"
echo "    bash $PROJECT_DIR/.claude/scripts/code-review-seed.sh > /tmp/seed.txt"
echo "    cat /tmp/seed.txt | claude --dangerously-skip-permissions"
echo ""
echo "  The coordinator will scaffold workers, assign tasks, and collect results."
