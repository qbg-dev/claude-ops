# Agent Type Templates

Three agent archetypes for flat workers. Each type provides opinionated defaults for `permissions.json`, `mission.md`, and `state.json`.

## Types

| Type | Permissions | Model | Use When |
|------|------------|-------|----------|
| **implementer** | Full edit/write/deploy | sonnet | Worker fixes bugs, builds features, deploys code |
| **monitor** | Read-only (no Edit/Write) | opus | Worker patrols, audits, or watches for anomalies |
| **coordinator** | Full + git merge/push | sonnet | Worker merges branches, deploys to prod, triages |

## Usage

Copy the base `flat-worker/` template, then overlay the type-specific files:

```bash
WORKER_DIR=".claude/workers/my-worker"
cp -r ~/.claude-ops/templates/flat-worker/ "$WORKER_DIR/"
# Overlay type-specific files
cp ~/.claude-ops/templates/flat-worker/types/monitor/* "$WORKER_DIR/"
# Edit mission.md — fill in {{placeholders}}
```

## Key Differences

### implementer (default for most workers)
- Can edit source, write files, deploy to test + prod
- `perpetual: false` by default (one-shot task worker)
- Mission template includes "NEVER just report — FIX THEM"

### monitor (read-only patrol)
- Cannot Edit or Write to src/data — enforced by denyList
- `perpetual: true`, `sleep_duration: 1800` (30 min cycles)
- Reports all findings to chief-of-staff via `worker-message.sh`
- Chief-of-staff triages and assigns to implementer workers

### coordinator (chief-of-staff)
- Can git merge, git push, deploy to prod
- `perpetual: true`, `sleep_duration: 1800`
- Receives reports from monitors, creates tasks for implementers
- Handles branch merges and conflict resolution

## Vision Gate

All types start with `vision_approved: false`. On first boot, the stop hook blocks until:
1. Worker creates `vision.html` from `~/.claude-ops/templates/vision.html.tmpl`
2. Warren reviews and sets `vision_approved: true` in state.json

## Handoff & Self-Recycle

Workers can recycle themselves (graceful respawn via watchdog) and pass context to their next instance:

- **`handoff.md`**: Written before `/exit`. Auto-injected into the next instance's seed prompt by the launcher. Best for structured status (what's done, what's next, blockers).
- **`handoff/`** directory: For richer context — code snippets, investigation logs, curl output, etc. Files under 100 lines are inlined into the seed; larger files are referenced by path.

Both are cleared by the next instance after absorption. The self-recycle flow:
1. Write handoff.md (and optionally handoff/ files)
2. Update state.json (cycles_completed++, last_cycle_at)
3. Save durable learnings to auto-memory
4. `/exit` → watchdog respawns after `sleep_duration` seconds
