# Worker Type Templates

Six archetypes. Preview with `fleet get <name>`; create with `fleet create --type <type> <name> "<mission>"`.

| Type | Lifecycle | Access | Use case |
|------|-----------|--------|----------|
| **implementer** | One-shot or cycled | Read-write, no push | Task-backlog-driven: fix bugs, build features |
| **optimizer** | Perpetual | Read-write, no push | Eval-driven: run evals, fix worst gaps, prove improvement |
| **monitor** | Perpetual | Read-only | Watch for anomalies, report to chief-of-staff |
| **merger** | Perpetual | Full + cherry-pick + deploy test | Cherry-pick worker commits to main, deploy to test, notify for E2E |
| **chief-of-staff** | Perpetual | Read + message only | Comms hub: relay messages, optimize missions, monitor fleet health |
| **verifier** | One-shot | Read-write, no push | Verification: test refactors against exhaustive checklists |

## Usage

```bash
# Via CLI
fleet create --type merger my-merger "# My Merger\n..."

# Manual
cp -r ~/.claude-fleet/templates/flat-worker/types/optimizer/ .claude/workers/my-worker/
# Fill in {{placeholders}} in mission.md
```

## Key Differences

**implementer** — has a task backlog, works through it, stops when done. "NEVER just report — FIX THEM."

**optimizer** — no backlog, runs an eval each cycle to find what to fix. Measures before/after. The eval score must never regress.

**monitor** — strictly read-only (enforced by `disallowed_tools`). Reports findings to chief-of-staff, never fixes them directly.

**merger** — exclusive git write authority on main. Cherry-picks worker commits, deploys to test, notifies workers for E2E verification. Never deploys to prod.

**chief-of-staff** — no code, no git, no deploy. Routes messages between Warren, workers, and merger. Optimizes worker missions. The fleet's nervous system.

## Handoff & Self-Recycle

Workers pass context to their next cycle via:
- **`handoff.md`**: Structured status (what's done, what's next, blockers). Auto-injected into next seed.
- **`handoff/`** directory: Richer context (code snippets, investigation logs). Files <100 lines inlined into seed.

Both cleared after absorption. Flow: write handoff -> update state -> save to auto-memory -> `/exit` -> watchdog respawns.
