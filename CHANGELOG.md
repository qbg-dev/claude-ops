# Changelog

All notable changes to claude-fleet (formerly claude-ops) are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.0] — 2026-03-10

### Added
- **`fleet` CLI** — single command for all fleet operations: `fleet create`, `fleet start`, `fleet stop`, `fleet ls`, `fleet config`, `fleet defaults`, `fleet fork`, `fleet log`, `fleet mail`, `fleet mcp`
- **`fleet setup`** — one-command bootstrap: checks deps, creates symlinks, registers MCP server, creates defaults
- **`fleet mcp`** — manage MCP server registration (`register`, `unregister`, `status`, `build`)
- **Per-worker directories** — each worker gets its own dir at `~/.claude/fleet/{project}/{name}/` with `config.json`, `state.json`, `mission.md`, `launch.sh`, `token`
- **`defaults.json`** — global defaults at `~/.claude/fleet/defaults.json`, overridden by per-worker config, overridden by CLI flags
- **12 system hooks** — irremovable safety hooks (block rm -rf, force push, checkout main, direct config edits)
- **Dynamic hook management** — workers register/remove their own hooks at runtime via MCP tools
- **Hook ownership tiers** — `system` (irremovable), `creator` (worker can't remove), `self` (worker manages)
- **Liveness detection** in `fleet ls` — cross-references tmux panes to detect dead workers

### Changed
- **Renamed** `claude-ops` → `claude-fleet` (GitHub repo, symlinks, env vars, docs)
- **MCP server** runs from TypeScript source via `bun run index.ts` instead of compiled `node index.js`
- **Storage model** migrated from monolithic `registry.json` to per-worker directories
- **`CLAUDE_OPS_DIR`** → `CLAUDE_FLEET_DIR` (both still work via `resolve-deps.sh` compat shim)
- **Settings.json** hook paths updated from `~/.claude/ops/` to `~/.claude-fleet/`
- **README.md** rewritten — positions as lightweight tmux-based Claude Code orchestration platform
- **`docs/getting-started.md`** rewritten for `fleet` CLI workflow

### Removed
- **Direct dependency on `registry.json`** for config (kept as backward-compat runtime state)
- **Manual `.mcp.json` wiring** — MCP server now registered globally via `fleet mcp register`
- **`init-project.sh` requirement** — `fleet create` handles all project bootstrapping

---

## [Unreleased]

### Added
- **`fleet onboard`** — interactive fleet architect agent that guides 9-phase project onboarding (discovery → fleet design → missions → safety hooks → REVIEW.md → extensions → Fleet Mail → verification → power user guide)
- **Full hook activation** — `setup-hooks.sh` now installs 40+ hooks across all 18 Claude Code events (was 16 hooks across 4 events). New events: SessionStart, SessionEnd, InstructionsLoaded, PostToolUse, PostToolUseFailure, PermissionRequest, SubagentStart, SubagentStop, Notification, TeammateIdle, TaskCompleted, ConfigChange, WorktreeCreate, WorktreeRemove
- **Watchdog launchd daemon** — `extensions/watchdog/install.sh` creates a macOS launchd service with KeepAlive + RunAtLoad for automatic crash recovery, stuck detection (>10min idle via liveness heartbeat), and sleep/wake cycle management
- `docs/getting-started.md` — install, scaffold, launch, verify
- `docs/architecture.md` — 5-component deep dive, data flow, file ownership map
- `docs/event-bus.md` — full bus API, side-effects, schema reference
- `docs/hooks.md` — hook pipeline, context injection, policy enforcement, custom authoring
- `CHANGELOG.md` — this file

### Fixed
- **`setup-hooks.sh`** — `_comment` entries in `manifest.json` (e.g. `{"_comment": "..."}`) no longer crash the Python parser with `KeyError: 'event'`
- **`lint-hooks.sh`** — same `_comment` fix in both file-check and registration-check Python blocks

---

## [0.2.0] — 2026-02-28

### Added
- **oss-steward harness** — dogfooding demo: an autonomous agent manages this repo's own docs (`feat: scaffold oss-steward harness`)
- **Notification event type** — `notification` events go through the bus as side-effects, triggering `terminal-notifier` via `notify_human_agent.sh` (`feat(bus): notification event type`)
- **README.md + install.sh** — full pitch, quick-start, architecture diagram, feature comparison table, curl-pipe-bash installer (`feat: prepare claude-ops for open-source release`)

### Changed
- **Portability fix** — all hardcoded `/Users/wz/` paths replaced with `$HOME` or dynamic resolution (`fix: remove all hardcoded /Users/wz/ paths for portability`)

### Security
- **Tool policy gate hardened** — oss-steward permissions sandboxed to repo only + Nexus; red-team fixes applied (`security: harden tool-policy-gate + oss-steward permissions`)
- **oss-steward permissions tightened** — write access restricted to `~/.claude-ops/` only (`chore(oss-steward): tighten permissions`)

---

## [0.1.0] — 2026-02-28

### Added
- **harness-launch fix** — detect running Claude TUI and inject seed directly on wake instead of spawning duplicate (`fix(harness-launch): detect running Claude TUI`)
- **Prompt publisher hardened** — `trap ERR` in prompt-publisher to suppress UserPromptSubmit hook noise in TUI (`fix(hooks): trap ERR in prompt-publisher`)
- **Hook error suppression** — all hooks exit 0 on error to suppress TUI hook error banners (`fix(hooks): exit 0 on error`)
- **Scaffold test suite rewrite** — full rewrite for v3 structure; all scaffold paths covered (`test(scaffold): rewrite test suite for v3 structure`)
- **Watchdog ordering fix** — check `graceful-stop` sentinel BEFORE process-alive check; avoids false crash detection on clean stops (`fix(watchdog): check graceful-stop FIRST`)
- **v3 harness structure** — `module-manager` replaces `sidecar` everywhere; scaffold, docs, routing all updated (`fix(harness): v3 scaffold + docs — module-manager replaces sidecar`)
- **module-manager routing** — all sidecar hardcodes replaced throughout hooks and dispatch (`fix(harness): module-manager routing`)

---

## [0.0.3] — 2026-02-24

### Added
- **Mission-driven harness evolution** — wave gates, substep checks, deploy inference, REFLECT schema for cycle learnings (`feat: mission-driven harness evolution`)
- **Phase 0 sketch gate** — agents must produce an ASCII/visual sketch of their vision before entering the implementation phase (`feat: Phase 0 sketch gate`)
- **Mission-pursuit harness** — agents pursue open-ended missions beyond a fixed task list; long-running lifecycle type introduced (`feat: mission-pursuit harness`)
