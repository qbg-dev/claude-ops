# Changelog

All notable changes to claude-ops are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- `docs/getting-started.md` — install, scaffold, launch, verify
- `docs/architecture.md` — 5-component deep dive, data flow, file ownership map
- `docs/event-bus.md` — full bus API, side-effects, schema reference
- `docs/hooks.md` — hook pipeline, context injection, policy enforcement, custom authoring
- `CHANGELOG.md` — this file

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
