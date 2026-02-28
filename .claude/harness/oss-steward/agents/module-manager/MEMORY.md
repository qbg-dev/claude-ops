# Memory — oss-steward

## Cycle 1 Learnings (2026-02-28)

### What was already done at start
- README.md and install.sh were already written before this cycle started
- T-1 and T-2 were effectively completed by Warren prior to first agent cycle

### What was done this cycle
- T-1..T-12 all completed; T-13 (issue triage) remains recurring/pending
- New harness scaffolded: test-watcher (long-running, 15-min cycles)
- New files created: AGENTS.md, CHANGELOG.md, docs/{getting-started,architecture,event-bus,hooks}.md, examples/{minimal-harness,multi-agent}/*, .github/workflows/ci.yml, scripts/launch-test-watcher.sh, docs/promotion/{show-hn,reddit-claude-ai}.md

### README feedback from Warren
- Remove feature lists and comparison tables — they clutter
- Emphasize built ON Claude Code, using its native capabilities
- Designed for human steering and input (not purely autonomous)
- The design explanation should focus on: coordinator+worker composition, event bus via hooks, watchdog respawn, multi-agent layer

### Key file paths (confirmed)
- `lib/event-bus.sh` — bus_publish, bus_read, bus_subscribe, bus_ack, bus_query, bus_git_checkpoint, bus_compact
- `lib/harness-jq.sh` — harness_current_task, harness_next_task, harness_done_count, locked_jq_write, hq_send, harness_bump_session
- `lib/pane-resolve.sh` — hook_pass, hook_block, hook_context, hook_parse_input, resolve_pane_and_harness
- `hooks/interceptors/pre-tool-context-injector.sh` — PreToolUse: policy match, inbox, acceptance, file-edit warnings
- `hooks/gates/stop-harness-dispatch.sh` — Stop: bounded gate, long-running sentinel, escape hatch
- `bus/schema.json` — event type registry with side_effects arrays
- `scripts/scaffold.sh` — creates full harness structure including agents/module-manager/

### AGENTS.md = combined prompt file
Warren requested a single-file reference for bootstrapping agents. Created AGENTS.md at repo root with all API references, install steps, task schema, hook contract, and end-of-cycle checklist.

### test-watcher harness
- Long-running (sleep_duration=1800s = 30 min cycles)
- Tasks C-1..C-5 in each cycle; C-5 blocked on all others
- Agent must reset task statuses to "pending" after each cycle for next iteration
- Scope: read-only on lib/hooks/scripts/tests/docs; write only MEMORY.md + tasks.json + acceptance.md
- API layer (bus_publish, harness_current_task, hook_pass, etc.) must never be changed

### CI structure
- `.github/workflows/ci.yml` runs on push + PR to main
- Steps: install deps, copy repo to ~/.boring, run tests/run-all.sh, run both examples

### Wave HTML format
- Files at `harness/reports/{name}/wave-N.html`
- Structure: header with harness name + wave badge, feature cards with before/after, analysis section, footer
- CSS variables: --bg #fafaf9, --accent #c8a24e, --success #16a34a
