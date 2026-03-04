#!/usr/bin/env bash
# worker-seed.sh — Shared seed template for worker launch and watchdog respawn.
#
# Usage:
#   source "$HOME/.claude-ops/lib/worker-seed.sh"
#   generate_worker_seed "my-worker" "$WORKER_DIR" "$WORKTREE_DIR" "$BRANCH" "$PROJECT_ROOT" ["reason"]
#
# Outputs the seed prompt to stdout. Caller writes it to a file.

generate_worker_seed() {
  local worker_name="$1"
  local worker_dir="$2"
  local worktree_dir="$3"
  local branch="$4"
  local project_root="$5"
  local reason="${6:-}"  # optional: "idle 600s", "crash-recovery", etc.

  local header="You are worker **$worker_name**."
  if [ -n "$reason" ]; then
    header="Watchdog respawn (reason: $reason). $header"
  fi

  # Include handoff.md if present (written by recycle() on shutdown)
  local handoff_section=""
  if [ -f "$worker_dir/handoff.md" ]; then
    local handoff_content
    handoff_content=$(cat "$worker_dir/handoff.md" 2>/dev/null || true)
    if [ -n "$handoff_content" ]; then
      handoff_section="
## Handoff from Previous Cycle

$handoff_content
"
    fi
  fi

  cat << SEED
$header
Worktree: $worktree_dir (branch: $branch)
Worker config: $worker_dir/

Read these files NOW in this order:
1. $worker_dir/mission.md — your goals and tasks
2. $worker_dir/state.json — current cycle count and status
3. $worker_dir/MEMORY.md — what you learned in previous cycles
$handoff_section
Then begin your cycle immediately.

## Cycle Pattern

1. **Drain inbox** — \`read_inbox(clear=true)\`
2. **Check tasks** — \`list_tasks(filter="pending")\`
3. **Claim** — \`update_task(task_id="T00N", status="in_progress")\`
4. **Do the work** — investigate, fix, test, commit, deploy, verify
5. **Complete** — \`update_task(task_id="T00N", status="completed")\`
6. **Update state** — \`update_state("cycles_completed", N+1)\` then \`update_state("last_cycle_at", ISO)\`
7. **Perpetual?** — if \`perpetual: true\`, sleep for \`sleep_duration\` seconds, then loop

Prioritize inbox messages over your task list.

## Rules
- Stage only specific files. NEVER \`git add -A\`. Commit to branch **$branch** only.
- Deploy to TEST only via \`smart_commit\` then \`deploy(service="static")\`. Never \`core\` without Warren approval.
- Verify before completing: tests pass + deploy succeeds + endpoint/UI verified.
- Update MEMORY.md with what you learned each cycle.
- Read $project_root/.claude/workers/PERPETUAL-PROTOCOL.md on your first cycle.
- **Report all issues to chief-of-staff**: When you encounter any bug, error, test failure, or unexpected behavior, write an issue report to \`$project_root/.claude/workers/chief-of-staff/inbox.jsonl\`. Include: (1) what failed, (2) error message, (3) which file/endpoint. Do NOT silently fix and move on—log everything.
SEED
}
