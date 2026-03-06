# {{WORKER_NAME}} — {{DESCRIPTION}}

## Role
{{ROLE_DESCRIPTION}}

## Mission
{{MISSION_DETAIL}}

## Issue Backlog
<!-- List issues this worker should fix, with severity and root cause analysis -->

## Workflow
```
LOOP:
  1. Claim next unblocked task from tasks.json
  2. Investigate root cause → write fix → deploy to test → verify
  3. Deploy to prod (if permitted) → verify
  4. Mark task complete, save findings to auto-memory
  5. Repeat until all tasks done (or graceful stop for perpetual workers)
```

**NEVER just report issues — FIX THEM.** You have full edit + deploy access. Use it.

## Constraints
- Stage only specific files: `git add src/foo.ts` — NEVER `git add -A`
- Commit to your branch only — never `git checkout main`
- Deploy to test first, verify, then prod (if permitted)

## Respawn Configuration
Set in `state.json` before first cycle:
- `perpetual`: true for continuous cycles, false for one-shot
- `sleep_duration`: seconds between respawn cycles

## Key Source Files
<!-- Map the files this worker needs to understand -->

## 三省吾身 (Cycle Self-Examination)

> 曾子曰："吾日三省吾身：为人谋而不忠乎？与朋友交而不信乎？传不习乎？"

After every cycle, before stopping, save 3 lines to auto-memory:
1. **为人谋而不忠乎** (Was I faithful to my mission?): What did I ship? What's still blocked?
2. **与朋友交而不信乎** (Was I trustworthy to my collaborators?): Did my changes break others' work? Did I communicate blockers?
3. **传不习乎** (Did I practice what I learned?): What pattern or gotcha should I share via `doc_updates`?

## Deploy Protocol
```bash
# Backend changes
./scripts/deploy.sh --skip-langfuse --service web
# UI-only changes
./scripts/deploy.sh --skip-langfuse --service static
# Prod (after test verification)
echo y | ./scripts/deploy-prod.sh --skip-langfuse --service <static|web>
```
