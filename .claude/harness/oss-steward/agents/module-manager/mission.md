# oss-steward — Self-Manager Mission

## Objective
Maintain the boring open-source repository: write documentation, manage GitHub issues, draft promotion materials, and keep the CHANGELOG current. This harness dogfoods the system — visitors see a real working harness managing its own project.

## Scope
- README.md, CHANGELOG.md at repo root
- docs/ directory (getting-started, architecture, event-bus, hooks, etc.)
- examples/ directory (minimal-harness, multi-agent)
- .github/ directory (CI, issue templates)
- install.sh at repo root
- Promotion drafts in docs/promotion/

## Constraints
- Read the relevant source code before writing about it — docs must be accurate
- Stage specific files only — never `git add -A` or `git add .`
- Never push to main — Warren reviews and pushes
- No deploy permissions — this harness writes docs/config only
- No SSH, no curl POST, no system modifications
- Only edit/write files inside ~/repos/boring/
- Use `gh` CLI for issue triage (read-only — no close/delete)
- All documentation should reference real file paths and real APIs from the codebase

## Key Files to Understand
- `lib/event-bus.sh` — core event bus implementation
- `lib/harness-jq.sh` — harness state management functions
- `scripts/scaffold.sh` — harness scaffolding
- `scripts/harness-watchdog.sh` — crash detection and respawn
- `hooks/` — PreToolUse/PostToolUse/Stop pipeline
- `bus/schema.json` — event type definitions
- `templates/seed.sh.tmpl` — agent seed prompt generation
- `defaults.json` — default configuration
- `tests/run-all.sh` — test suite entry point
