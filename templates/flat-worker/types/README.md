# Worker Type Templates

Four archetypes. Copy the matching type when creating a new worker.

| Type | Lifecycle | Access | Use case |
|------|-----------|--------|----------|
| **implementer** | One-shot or cycled | Read-write, no push | Task-backlog-driven: fix bugs, build features |
| **optimizer** | Perpetual | Read-write, no push | Eval-driven: run evals, fix worst gaps, prove improvement |
| **monitor** | Perpetual | Read-only | Watch for anomalies, report to coordinator |
| **coordinator** | Perpetual | Full + merge + deploy | Merge branches, deploy prod, triage reports |

## Usage

```bash
cp -r ~/.claude-ops/templates/flat-worker/types/optimizer/ .claude/workers/my-worker/
# Fill in {{placeholders}} in mission.md
```

## Key Differences

**implementer** — has a task backlog, works through it, stops when done. "NEVER just report — FIX THEM."

**optimizer** — no backlog, runs an eval each cycle to find what to fix. Measures before/after. The eval score must never regress. This is the pattern for `bi-optimizer`, `kefu-optimizer`, `sql-library-builder`, etc.

**monitor** — strictly read-only (enforced by `disallowed_tools`). Reports findings to coordinator, never fixes them directly.

**coordinator** — the only type that can merge to main and deploy to prod. Receives reports from monitors, creates tasks for implementers.

## Handoff & Self-Recycle

Workers pass context to their next cycle via:
- **`handoff.md`**: Structured status (what's done, what's next, blockers). Auto-injected into next seed.
- **`handoff/`** directory: Richer context (code snippets, investigation logs). Files <100 lines inlined into seed.

Both cleared after absorption. Flow: write handoff → update state → save to auto-memory → `/exit` → watchdog respawns.
