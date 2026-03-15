# REVIEW.md — Deep Review Rules for claude-fleet

Project context: Agent orchestration platform (Bun + TypeScript + Rust). Graph-native program pipelines, tmux-based lifecycle, Fleet Mail messaging, MCP server, extension system (watchdog, deep review), zsh completions.

---

## Always Flag (default-high severity, see Severity Overrides for exceptions)

### Documentation & Sync (1–7) — pre-commit gate

These are checked by the pre-commit hook whenever CLI, doc, completion, or test files are staged. Claude must verify each and write proof XML before committing.

1. **CLI ↔ CLAUDE.md drift**: Every command registered in `cli/commands/*.ts` (via `.command("name")`) must appear in the `## CLI` code block of `CLAUDE.md`. Aliases (`.alias()`) satisfy the check. No stale commands in CLAUDE.md that were removed from CLI.

2. **CLI ↔ completions drift**: Every registered command must have a `'name:Description'` entry in `completions/_fleet`. Aliases don't need separate entries (zsh resolves them via commander). Commands with flags or subcommands need completion handlers in the `case` block. Only one completion file (`_fleet`) — no duplicates.

3. **CLI ↔ tests drift**: Every registered command must appear in `cli/tests/help-format.test.ts` `ALL_COMMANDS` array. The "contains all N commands" test description must match actual count. `commands-smoke.test.ts` should have `--help` tests for write commands.

4. **Key files table stale**: New command files, scripts, or significant source files must be reflected in the `## Key files` table in CLAUDE.md. Every path in the table must resolve to an existing file — stale entries for deleted/moved files must be removed.

5. **Cross-reference breakage**: `~/.claude/fleet.md` symlink must resolve to the same CLAUDE.md. If MCP tools changed, the MCP tools table must be current.

6. **Version string drift**: `cli/index.ts` `.version()`, `CHANGELOG.md` latest version header, and `package.json` `version` (if present) must all agree. Any version bump must update all locations.

7. **Changelog freshness**: If `cli/` or `mcp/` or `engine/` source files are in the staged diff, `CHANGELOG.md` `[Unreleased]` section should have a corresponding entry. Warn-only — can be `skip` with justification in proof XML.

### Core Infrastructure — CLI, MCP, Config (8–14)

8. **Missing `addGlobalOpts()`**: New commands that don't call `addGlobalOpts(sub)`, breaking `--project` and `--json` passthrough.

9. **Hardcoded tmux session names**: Using literal session names instead of reading from `fleetConfig.tmux_session` or `DEFAULT_SESSION`.

10. **Tool schema mismatch**: MCP tool definitions in `mcp/worker-fleet/tools/*.ts` must match the tool table in CLAUDE.md and the `fleet_help()` output in `mcp/worker-fleet/helpers.ts`.

11. **Missing input validation**: MCP tool handlers accepting worker names, project names, or paths without sanitization. These are called by LLM agents — never trust input. Concrete checks: worker names must match `/^[a-z0-9][a-z0-9-]*$/` (no `.`, `..`, `/`). Paths containing `@` must resolve within `{FLEET_DIR}` — reject `../../` traversal. Project names go through `sanitizeProjectName()`.

12. **State mutation without locking**: Writing to `config.json` or `state.json` without the `mkdir`-based atomic lock pattern. Concurrent workers can corrupt JSON.

13. **Missing error handling on tmux calls**: `Bun.spawnSync()` for tmux commands without checking `exitCode` — tmux may not be running.

14. **Concurrent JSON writes in bridge**: Multiple bridge invocations writing to the same `pipeline-state.json` without coordination. The bridge reads state → mutates → writes back, but parallel agent completions can trigger overlapping bridge calls on the same session directory. Must use the `mkdir`-based lock or atomic-write pattern from `shared/fs.ts`.

### Programs & Pipelines (15–20)

15. **Graph cycle safety**: Back-edges in `ProgramGraph` (edges where `backEdge: true`) must specify `maxIterations`. A back-edge without `maxIterations` creates an infinite agent relaunch loop — the bridge will keep cycling the node forever. The `topologicalSort()` in `engine/program/graph.ts` skips back-edges for ordering but does not validate this invariant.

16. **Dynamic agent generator error handling**: `DynamicAgents` specs with a `generator` function must have a `fallback` array. If the generator throws or returns an empty array (e.g., prior phase output missing), the bridge silently proceeds with zero agents, leaving the pipeline stuck. The `fallback` field in `engine/program/types.ts` exists for this — flag generators without it.

17. **Bridge deprecated field writes**: Programs writing to top-level `ProgramPipelineState` fields (`roleResult`, `reviewConfig`, `spec`, `workerNames`, `coordinatorName`, `judgeName`, `verifierNames`) instead of `ext.*`. These fields are `@deprecated` in `engine/program/types.ts`. New programs must use `state.ext.myField`. The bridge compat layer (`state.roleResult || state.ext?.roleResult`) should not be relied upon for new code.

18. **Session directory reuse**: Bridge reads `pipeline-state.json` from `sessionDir` on every transition. If a previous pipeline's session directory is reused (same program name + timestamp collision, or manual `--session-dir`), stale state from the old pipeline corrupts the new one. Session IDs must be unique — verify `sessionDir` doesn't already contain `pipeline-state.json` before first write.

19. **Prelaunch parser naming convention**: Prelaunch action handlers registered in `engine/program/bridge.ts` use hyphenated names (`"context-prepass"`, `"shuffle-material"`, `"parse-output"`) but imported function names use camelCase or underscores. New actions must follow the existing hyphenated `BridgeAction` type. Flag any action string not in the `BridgeAction` union type.

20. **Compilation artifact cleanup**: `engine/program/compiler.ts` generates wrapper scripts and seed files into `sessionDir`. If compilation fails mid-way, partial artifacts remain. The `cleanup.sh` script generated at bridge time must cover all artifacts — flag compilation code paths that create files without adding them to the cleanup list.

### Hooks & Dynamic Behaviors (21–24)

21. **Hook ownership violation**: Worker-created hooks (`self` tier) that bypass the ownership model — e.g., removing `system` or `creator` hooks, or hooks that disable safety gates. The 12 `SYSTEM_HOOKS` in `shared/types.ts` are irremovable.

22. **Hook event mismatch**: Hook registered for wrong event (e.g., `PreToolUse` handler in a `Stop` event). The `manifest.json` event names must match Claude Code's actual event names: `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `InstructionsLoaded`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted`, `ConfigChange`, `PreCompact`, `WorktreeCreate`, `WorktreeRemove`, `Stop`.

23. **Hook script content vs deny-list**: A hook script that performs actions equivalent to a denied tool (e.g., a `PreToolUse` gate that runs `rm -rf` itself, or a publisher that exfiltrates state via curl). Hook scripts run with the same privileges as Claude Code — the deny-list only blocks Claude's tool calls, not arbitrary shell commands in hooks. Flag any hook script containing destructive commands (`rm -rf`, `git reset --hard`, `git push --force`) or network calls to non-Fleet-Mail endpoints.

24. **Pipeline hook path resolution**: Hooks installed by the bridge at pipeline runtime (Stop hooks for node transitions, gate hooks for convergence checks) use paths relative to the fleet installation directory (`~/.claude-fleet/`). If the bridge resolves paths at compile time but the hook runs at a later time when the fleet directory has been updated or moved, the path breaks silently. Flag any hook `path` field that uses a variable resolved at compile time rather than a stable absolute path or `$FLEET_DIR` reference.

### Worker Lifecycle & Watchdog (25–31)

25. **Dual-instance watchdog prevention** *(critical)*: `extensions/watchdog-rs/src/main.rs` has no pidfile or lockfile guard — it relies solely on launchd `KeepAlive` to ensure single-instance. If a user manually runs `boring-watchdog` while launchd is active, or if launchd respawns before the previous instance exits, two watchdog instances run simultaneously. Each independently relaunches workers, causing double Claude sessions and 2x API credit burn. Flag any change to `main.rs` or `install.rs` that doesn't add or preserve a pidfile/lockfile check. The pidfile should be at `{FLEET_STATE_DIR}/watchdog.pid` and checked with `flock` or atomic `O_EXCL` create.

26. **Pane detection false negatives**: `extensions/watchdog-rs/src/tmux.rs` checks if Claude is running by capturing the last 5 lines of a pane and matching against `TUI_INDICATORS` (`"bypass permissions"`, `"❯"`, `"Plan:"`, `"claude-code"`, `"Thinking"`, `"Tool:"`). If Claude's UI changes indicator text, or if a long tool output pushes indicators off-screen, the watchdog falsely detects a dead session and relaunches — killing an active agent mid-work. Flag changes to TUI_INDICATORS that remove existing patterns, and flag any capture window smaller than 5 lines.

27. **Missing cleanup on nuke/stop**: Worker teardown that leaves orphaned tmux panes, stale worktrees, or dangling Fleet Mail accounts. The `nuke` command must clean all three; `stop` must at minimum kill the pane and set status.

28. **Crash loop bypass**: Changes to watchdog or recycle logic that weaken crash-loop protection (3/hr max). The Rust watchdog in `checker.rs` uses cooldown-based gating — flag any change that reduces cooldown or removes the relaunch count check.

29. **Cooldown vs check_interval timing invariant**: In watchdog config, `cooldown_secs` must be ≥ `check_interval_secs`. If cooldown < check_interval, the watchdog can relaunch a worker on consecutive checks (check fires, relaunch, next check fires before cooldown expires — but cooldown is measured from last relaunch, not last check). Default: check=30s, cooldown=60s. Flag any config change that violates `cooldown >= check_interval`.

30. **Watchdog plugin timeout requirement**: Plugins implementing the `Plugin` trait in `extensions/watchdog-rs/src/plugin.rs` run on their own async interval but share the Tokio runtime. A blocking plugin (e.g., network call that hangs) starves other plugins and the core check loop. Flag any `Plugin::check()` implementation that performs I/O without a timeout (e.g., `tokio::time::timeout` wrapper). The liveness plugin in `plugins/liveness.rs` is file-based (fast) — network-based plugins need explicit timeouts.

31. **Ephemeral vs perpetual misclassification**: Workers with `ephemeral: true` skip watchdog respawn and auto-cleanup. Workers with `sleep_duration > 0` are perpetual (watchdog respawns them). These are independent flags — a worker can be `ephemeral: true` AND `sleep_duration > 0`, which means "perpetual but don't watchdog-respawn" (contradictory). Flag any worker config where both `ephemeral: true` and `sleep_duration > 0`, and any code path that sets one without considering the other.

### Extensions & Manifests (32–33)

32. **Extension manifest required fields**: Every extension in `extensions/*/` must have a `manifest.json` with at minimum: `name`, `version`, `description`. Optional but validated if present: `binary` (must point to a buildable target), `install` (must be a runnable command), `scripts` (values must be relative paths that exist). Flag any extension directory without a manifest, or a manifest missing required fields.

33. **Extension install idempotency**: Extension install commands (from `manifest.json` `install` field or dedicated install scripts like `extensions/review/install.sh`) must be idempotent — running twice produces identical results with no errors. Flag install scripts that fail on "already exists" conditions (e.g., `ln -s` without `-f`, `mkdir` without `-p`, `cargo install` without `--force`).

### Runtime Environment & Path Safety (34–38)

34. **Worktree path injection**: Worker names used in `git worktree add` or file paths without sanitization. Names come from user input or Fleet Mail. Must match `/^[a-z0-9][a-z0-9-]*$/` — reject names containing `/`, `..`, spaces, or shell metacharacters.

35. **launchd PATH/HOME inheritance**: The watchdog runs as a launchd daemon, which inherits a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`). `tmux`, `fleet`, `claude`, and `bun` are typically in `/usr/local/bin`, `~/.bun/bin`, or Homebrew paths — none in launchd's default PATH. Flag any change to `extensions/watchdog-rs/src/install.rs` that generates a plist without explicit `PATH` and `HOME` environment keys. The plist must include at minimum: `PATH` with `/usr/local/bin:$HOME/.bun/bin:$HOME/.local/bin` and `HOME` set to the user's home directory.

36. **Symlink chain resolution**: Scripts that use `dirname "$0"` to find the fleet installation directory will get the symlink's parent, not the target's parent, if the script is invoked through a symlink (e.g., `~/.local/bin/fleet` → `~/.claude-fleet/cli/bin/fleet.sh`). Flag scripts using `dirname "$0"` without a preceding `readlink` loop (or `realpath`) to resolve the symlink chain. Canonical pattern: `SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"`.

37. **Worktree path doubling**: Worker worktree paths are constructed as `{repo}-w-{name}`. If the worker name already contains a `-w-` segment (e.g., forked worker `review-w-pass2`), the path becomes `repo-w-review-w-pass2` and suffix-stripping logic that looks for the last `-w-` segment extracts `pass2` instead of `review-w-pass2`. Flag any worktree path construction or name extraction that uses simple `-w-` split without anchoring to the repo name prefix.

38. **JSDoc glob syntax conflicts**: TypeScript files using JSDoc `@type {import("./path").Type}` inside glob-matched hook scripts can confuse the Bun bundler or test runner if the glob pattern matches `.ts` files not intended for compilation. Flag hook scripts (in `hooks/`) that contain TypeScript-style imports but aren't listed in `tsconfig.json` include paths.

### Security & Input Validation (39–42)

39. **Secrets in staged diff**: Staged changes must not contain Fleet Mail tokens, API keys, passwords, or high-entropy strings matching `token`, `password`, `secret`, `Bearer`. Allowlist: type definitions, doc examples, test fixtures with clearly fake values.

40. **Import boundary violation**: `mcp/worker-fleet/` must not import from `cli/`. `cli/` must not import from `mcp/`. `engine/` must not import from `cli/` or `mcp/`. All three may import from `shared/`. Cross-boundary imports cause runtime failures (MCP server, CLI, and engine bridge are separate processes).

41. **MCP tool count drift**: CLAUDE.md "MCP tools (N)" header must match actual tool count in `mcp/worker-fleet/index.ts`. Tool table rows in CLAUDE.md must match tool registrations.

42. **Hook script @-path directory escape**: Hook scripts that accept `@`-prefixed file path arguments (e.g., `@/path/to/config`) must validate that the resolved path stays within the worker's worktree or fleet directory. An LLM agent could craft `@../../etc/passwd` to read arbitrary files. Flag any `@`-path resolution that doesn't check `realpath` is a prefix of the allowed directory.

### Templates & Seeds (43–48)

43. **MCP tool reference staleness**: `templates/seed-context.md` and `templates/fragments/fleet-tools.md` must reference only MCP tools that are actually registered in `mcp/worker-fleet/tools/*.ts`. Newly registered tools must be documented in seed context.

44. **Hook event staleness**: Hook event names in template seeds must match events in `hooks/manifest.json`. Adding or renaming events requires updating all seed templates. The canonical event list is in rule 22 above.

45. **Worker type drift**: Every directory in `templates/flat-worker/types/` must have a corresponding row in the CLAUDE.md `## Worker types` table, and vice versa. Each type directory must contain a `mission.md`.

46. **Hook count drift**: CLAUDE.md "N hooks across M events" must match the actual counts in `hooks/manifest.json`.

47. **Handlebars partial drift**: Every `{{> partial-name}}` reference in `templates/**/*.md` seed files must resolve to a file in `templates/fragments/`. If a fragment is renamed or deleted, all referencing seeds break silently (Handlebars strict mode is off — unresolved partials render as empty string). Flag any `{{> ...}}` where the partial name doesn't match a filename (minus `.md`) in `templates/fragments/`.

48. **Idempotency regression**: `fleet setup`, `fleet setup --extensions`, `scripts/setup-hooks.sh`, and `fleet doctor --fix` must be idempotent. Running twice produces identical results — no duplicate hooks, no duplicate configs, no errors. This extends to extension install scripts (`extensions/*/install.sh`) — each must handle the "already installed" case gracefully.

---

## Never Flag (intentional design patterns)

1. **`sleep_duration: null` as one-shot signal**: Not a bug — `null` means one-shot worker, `N > 0` means perpetual. No separate `perpetual` field.

2. **`send-keys -H 0d` instead of literal Enter**: tmux `send-keys Enter` is unreliable in some terminal states. Hex 0d is the canonical pattern.

3. **`mkdir`-based locking instead of file locks**: Atomic on all filesystems, no cleanup needed on crash. Intentional simplicity over flock.

4. **Workers can't update other workers' config**: By design. Cross-worker config changes go through Fleet Mail suggestions.

5. **No `disallowed_tools` field**: Removed in v2. Tool restrictions use hooks (`PreToolUse` gate) instead.

6. **`report_to` removed**: Workers communicate via Fleet Mail, not hierarchical reporting.

7. **MCP server split into 15 modules**: Was a 4,656-line monolith. The module count is intentional, not over-engineering.

8. **Handlebars for seed templates**: `engine/program/seed-resolver.ts` uses Handlebars with `noEscape: true` for markdown-safe rendering. The `helperMissing` hook preserving unresolved `{{VARS}}` literally is intentional (phased compilation — eager vars at compile time, deferred vars at bridge time).

9. **Bridge state is JSON-serializable**: `ProgramPipelineState.ext` is `Record<string, unknown>` — no class instances, functions, or circular references. This is by design for `pipeline-state.json` persistence. Don't "fix" it to use typed classes.

10. **`gate:"all"` uses `.done` marker files**: When a pipeline node has `gate: "all"`, the bridge waits for all agents to complete by checking for `.done` marker files in the session directory. This is simpler than IPC and survives crashes.

11. **Extensions use `manifest.json` not `package.json`**: Extensions are not npm packages. The manifest schema is intentionally minimal (name, version, description) and fleet-specific.

12. **Watchdog uses plugin trait**: The `Plugin` trait in `extensions/watchdog-rs/src/plugin.rs` with async `check()` returning `Option<PluginAction>` is the stable interface. Don't collapse plugins into the core check loop.

13. **Deprecated fields preserved with `@deprecated`**: Top-level `ProgramPipelineState` fields (`roleResult`, `reviewConfig`, etc.) are kept for backward compatibility with existing session state files. The bridge compat layer (`state.field || state.ext?.field`) is intentional — don't remove the deprecated fields or the compat reads.

---

## Severity Overrides

| Pattern | Override |
|---------|----------|
| Doc sync drift (1–5) caught by `check-docs.sh` | medium (deterministic scan catches most) |
| Doc sync drift missed by deterministic scan (descriptions, key files) | high (only AI verification catches these) |
| Version string drift (6) | medium (causes confusion, not data loss) |
| Changelog freshness (7) | low (warn-only, not blocking) |
| Missing `addGlobalOpts()` (8) | low (easy to spot, easy to fix) |
| Tool schema mismatch (10) | high (workers rely on accurate tool docs) |
| Missing input validation in MCP handlers (11) | critical (LLM agents are unpredictable callers) |
| State mutation without locking (12) | critical (silent data corruption) |
| Concurrent bridge JSON writes (14) | critical (silent pipeline state corruption) |
| Graph cycle safety (15) | critical (infinite agent relaunch = unbounded API spend) |
| Dynamic agent generator without fallback (16) | high (stuck pipeline, manual recovery needed) |
| Bridge deprecated field writes (17) | medium (compat layer handles it, but tech debt accrues) |
| Session directory reuse (18) | high (stale state corrupts new pipeline) |
| Prelaunch parser naming (19) | low (convention, not runtime failure) |
| Compilation artifact cleanup (20) | medium (disk waste, potential confusion) |
| Hook ownership violation (21) | critical (safety bypass) |
| Hook script content vs deny-list (23) | critical (privilege escalation through hook scripts) |
| Pipeline hook path resolution (24) | high (silent failure on fleet update) |
| Dual-instance watchdog (25) | critical (2x API credit burn, duplicate sessions) |
| Pane detection false negatives (26) | high (kills active agents mid-work) |
| Missing cleanup on nuke/stop (27) | high (orphaned resources accumulate) |
| Crash loop bypass (28) | high (runaway agents burn API credits) |
| Cooldown vs check_interval invariant (29) | medium (relaunch storm, bounded by cooldown) |
| Watchdog plugin timeout (30) | high (starves entire watchdog runtime) |
| Ephemeral vs perpetual misclassification (31) | medium (contradictory config, unpredictable behavior) |
| Extension manifest missing fields (32) | medium (install may fail, not runtime) |
| Extension install idempotency (33) | high (fleet setup breaks on second run) |
| Worktree path injection (34) | critical (shell command injection risk) |
| launchd PATH/HOME inheritance (35) | critical (watchdog silently non-functional after install) |
| Symlink chain resolution (36) | high (fleet commands fail when invoked via symlink) |
| Worktree path doubling (37) | high (wrong worktree used, wrong code deployed) |
| Secrets in staged diff (39) | critical (credential exposure) |
| Import boundary violation (40) | high (runtime failure in prod) |
| MCP tool count drift (41) | medium (worker confusion, not crash) |
| Hook script @-path escape (42) | critical (arbitrary file read via LLM agent) |
| MCP tool reference staleness (43) | medium (worker confusion, not crash) |
| Hook event staleness (44) | medium (hooks may silently not fire) |
| Worker type drift (45) | low (cosmetic, no runtime impact) |
| Hook count drift (46) | low (documentation accuracy) |
| Handlebars partial drift (47) | high (silent empty render in seed context) |
| Idempotency regression (48) | high (watchdog amplifies the failure) |

---

## Maintainability & Explicit Contracts

These rules enforce explicit-over-implicit patterns. They are derived from 13 fix commits (ae73e13..87affa5) that share a common root cause: implicit assumptions that silently fail.

### M1. Single Field, Single Meaning

Every config/state field must have exactly one semantic. `sleep_duration` means "post-cycle sleep interval" — not "max runtime" or "watchdog timeout." If a field is being read with two different interpretations in different code paths, split it into two fields with explicit names.

**Regression source**: `d5cb403` — `sleep_duration` was used as both post-cycle sleep AND max-runtime trigger, causing active workers to be killed mid-work.

### M2. Explicit State Machine for Worker Lifecycle

Worker status transitions must follow a defined state machine. Valid states: `idle` → `active` → `sleeping` → `idle` (perpetual cycle), or `idle` → `active` → `standby` (stopped). The watchdog must only act on explicit states — never infer intent from the absence of a field.

**Regression source**: `594064e` — `fleet stop` set `status="idle"`, which watchdog interpreted as "ready to respawn" instead of "intentionally stopped." Fixed by adding `standby` state.

### M3. Environment Must Be Explicitly Provisioned

Any subprocess (daemon, hook script, bridge child) must receive its full execution context explicitly — PATH, HOME, CWD, env vars. Never rely on shell inheritance. Wrapper scripts must resolve their real location via `readlink -f "$0"`, not `dirname "$0"`.

**Regression sources**: `6ba218a` (launchd PATH), `e4e45fb` (symlink chain), `72b9604` (PROJECT_ROOT in bridge).

### M4. External API Contracts Must Be Verified

When calling external systems (Claude Code CLI, tmux, git, Fleet Mail), the exact command/method name must be verified against that system's documentation. Don't assume — test. Slash commands, flag names, and exit code semantics can change across versions.

**Regression source**: `eedebc9` — code sent `/stop` to Claude Code (doesn't exist), should have been `/exit`.

### M5. All Permission Gates Must Scan All User-Controlled Fields

When enforcing deny-lists or permission checks, every field that could contain user/agent input must be scanned — not just the primary field. If a hook has `content`, `check`, and `script` fields, all three must be validated against the deny-list.

**Regression sources**: `362d3a5` (check command bypass), `67be7b5` (ownership enforcement), `ae73e13` (@-path escape).

### M6. Lifecycle Operations Must Be Atomic

Multi-step lifecycle operations (stop, recycle, nuke) must use explicit state markers that prevent race conditions with the watchdog. A `fleet stop` must set status to a watchdog-immune state (`standby`) *before* killing the pane. A `fleet recycle` must prevent concurrent `fleet start` from creating duplicate panes.

**Regression sources**: `594064e` (stop → immediate respawn), `87affa5` (recycle race → duplicate panes).

### M7. No Speculative Features

Don't implement complex features without at least 2 concrete use cases. If a feature adds config fields, MCP tools, or state management but has no caller, it will be reverted. Complexity must earn its place.

**Regression source**: `0d1d172` — Erlang-style monitors feature added (100+ lines, config fields, debounce logic), then reverted because no use cases materialized.

---

## Critical Test Requirements

These tests cover gaps identified from analyzing the existing test suite and 13 fix commits. Tests marked **(missing)** don't exist yet and should be added. Tests marked **(exists)** are already covered.

### T1. Worker Status State Machine **(partial — needs expansion)**

The watchdog checker has good coverage (`extensions/watchdog/__tests__/worker-checker.test.ts`), but missing:
- `fleet stop` sets `status="standby"` and watchdog does NOT respawn
- `fleet recycle` sets `status="recycling"` and only ONE new pane is created (no race with manual `fleet start`)
- `sleep_duration` is NOT used as max-runtime while worker is active **(exists — line 279)**

### T2. Hook Ownership Enforcement **(missing)**

```
test: self-tier worker cannot remove system hook
test: self-tier worker cannot remove creator hook
test: worker A cannot remove worker B's self hook
test: complete_hook rejects system-tier hooks
test: manage_worker_hooks REMOVE validates caller authority
```

### T3. Hook Deny-List Scanning **(missing)**

```
test: deny-list scans content field
test: deny-list scans check field
test: deny-list scans script field
test: @-path in script resolves within allowed directory only
test: @-path with ../../ traversal is rejected
```

### T4. Path Safety **(missing)**

```
test: worker name with / is rejected
test: worker name with .. is rejected
test: worker name with spaces is rejected
test: worktree path with -w- in name extracts correctly (no doubling)
test: symlink resolution — dirname of symlink resolves to target, not link location
```

### T5. Daemon Environment **(missing)**

```
test: launchd plist contains PATH with /usr/local/bin and ~/.bun/bin
test: launchd plist contains HOME set to user home
test: watchdog can locate tmux binary from plist PATH
test: watchdog can locate fleet binary from plist PATH
```

### T6. Pipeline Integrity **(missing)**

```
test: back-edge without maxIterations is rejected at graph construction
test: dynamic generator with no fallback warns at compile time
test: session directory with existing pipeline-state.json is rejected (or renamed)
test: concurrent bridge calls on same session detect lock contention
test: deprecated field writes log warning (state.roleResult vs state.ext.roleResult)
```

### T7. External API Contracts **(missing)**

```
test: gracefulStop sends /exit (not /stop) to Claude Code pane
test: send-keys uses -H 0d for Enter (not literal "Enter" string)
test: fleet commands call addGlobalOpts (scan all cli/commands/*.ts)
```

### T8. Idempotency **(missing)**

```
test: fleet setup run twice → no errors, identical state
test: fleet setup --extensions run twice → no errors
test: setup-hooks.sh run twice → same hook count
test: extension install scripts run twice → no "already exists" errors
```

### T9. Import Boundary **(exists via review.sh, but no unit test)**

```
test: no file in mcp/ imports from cli/
test: no file in cli/ imports from mcp/
test: no file in engine/ imports from cli/ or mcp/
test: all cross-boundary imports go through shared/
```

---

## Known Regression Patterns

Patterns extracted from fix commits that have recurred or are likely to recur. Each entry names the original commit, the root cause, and what to watch for.

| ID | Pattern | Original Fix | What Regresses It |
|----|---------|-------------|-------------------|
| R1 | **Worktree path doubling** | `c23ba62` | Any code that constructs or parses worktree paths using `-w-` splitting without anchoring to repo name prefix |
| R2 | **launchd PATH starvation** | `6ba218a` | Any change to plist generation (`install.rs`) that drops or overwrites EnvironmentVariables |
| R3 | **Symlink dirname trap** | `e4e45fb` | New wrapper scripts using `dirname "$0"` without readlink resolution |
| R4 | **Stop → immediate respawn** | `594064e` | Any status change that maps to a watchdog-respawnable state (anything other than `standby`, `sleeping`) |
| R5 | **sleep_duration as runtime limit** | `d5cb403` | Watchdog code reading `sleep_duration` to determine if an *active* worker should be restarted |
| R6 | **Recycle race (duplicate panes)** | `87affa5` | Recycle implementations that rely on watchdog respawn instead of doing stop+start atomically |
| R7 | **Hook ownership bypass** | `67be7b5` | New MCP tools or CLI commands that modify hooks without checking ownership tier |
| R8 | **Check command unscanned** | `362d3a5` | New hook fields (timeout, retry, condition) that accept user strings without deny-list scan |
| R9 | **@-path directory escape** | `ae73e13` | New file-copy operations accepting user paths without `realpath` prefix validation |
| R10 | **Wrong slash command** | `eedebc9` | Any tmux send-keys call that sends Claude Code commands without verifying they exist |
| R11 | **Bash shim deletion** | `f2db425` | Refactoring that removes entry-point scripts referenced by hooks/settings without updating all callers |
| R12 | **Fork session lookup** | `c6469c0` | Session file lookups that assume `process.cwd()` matches the project slug in `~/.claude/projects/` |
| R13 | **Speculative feature creep** | `0d1d172` | Complex features merged without 2+ concrete use cases — creates maintenance surface for zero payoff |

---

## Pre-commit Verification

When the pre-commit hook fires (staged files match `cli/|engine/|CLAUDE.md|README.md|completions/`):

1. Get proof path: `bash scripts/verification-hash.sh`
2. Run `bash scripts/check-docs.sh` as a quick deterministic first pass
3. Verify items 1–5 above (Doc Sync section), including things the script can't catch (description accuracy, key files completeness)
4. Write proof XML:

```xml
<verification>
  <timestamp>ISO-8601</timestamp>
  <staged_hash>hash from verification-hash.sh</staged_hash>
  <checks>
    <check name="cli-claudemd" status="pass|fail|skip" note="optional" />
    <check name="cli-completions" status="pass|fail|skip" note="optional" />
    <check name="cli-tests" status="pass|fail|skip" note="optional" />
    <check name="key-files" status="pass|fail|skip" note="optional" />
    <check name="cross-refs" status="pass|fail|skip" note="optional" />
    <check name="version-consistency" status="pass|fail|skip" note="optional" />
    <check name="secrets-scan" status="pass|fail|skip" note="optional" />
    <check name="import-boundaries" status="pass|fail|skip" note="optional" />
    <check name="graph-cycle-safety" status="pass|fail|skip" note="optional" />
    <check name="bridge-state-compat" status="pass|fail|skip" note="optional" />
    <check name="extension-manifests" status="pass|fail|skip" note="optional" />
  </checks>
  <summary>1-2 sentence assessment</summary>
</verification>
```

All checks must be `pass` or `skip` (with justification). Proof is hash-tied to staged diff — any staging change invalidates it.

### Automated Review Script

Run `bash scripts/review.sh` for a deterministic scan of structural integrity rules (40–41, 45–46). `bash scripts/check-templates.sh` scans template & seed staleness (43–47). `bash scripts/check-docs.sh` covers documentation sync (1–5). All three run automatically in the **pre-push hook** — errors block the push, warnings are advisory. The pre-commit hook still requires AI-verified proof XML for anything the scripts can't catch.

---

## Pre-Push DX Feedback Gate

After the 3 deterministic check suites pass (`check-docs.sh`, `review.sh`, `check-templates.sh`), the pre-push hook runs an AI-powered DX feedback analysis via `fleet pipeline dx-feedback`. This is **blocking** — any findings must be addressed before the push proceeds.

### How It Works

1. Pre-push hook launches `fleet pipeline dx-feedback --scope HEAD` (Sonnet agent)
2. Agent analyzes diff against REVIEW.md, README-CONVENTIONS.md, hook-orchestration.md
3. Agent writes feedback with verdict: `CLEAN`, `HAS_SUGGESTIONS`, or `NEEDS_ATTENTION`
4. If findings exist, developer must write proof XML addressing each finding

### Cache

Feedback is cached at `.git/dx-feedback/{COMMIT_SHA}.md` — pushing the same SHA twice reuses cached results. Cache auto-cleans after 24 hours.

### Proof Format

```xml
<dx-feedback-proof commit="{SHA}" date="{ISO-DATE}">
  <finding id="H1" status="addressed" note="Added row to programs/CLAUDE.md" />
  <finding id="M1" status="wontfix" note="Legacy format is fine for single-phase" />
  <finding id="L1" status="skip" note="Will add changelog in release batch" />
</dx-feedback-proof>
```

Valid statuses: `addressed` (fixed), `wontfix` (intentional, with reason), `skip` (acknowledged, deferred). Every finding from the feedback must have a `<finding>` entry — incomplete proofs are rejected.

### Generating Proof

```bash
bash scripts/dx-feedback-proof.sh              # print template to stdout
bash scripts/dx-feedback-proof.sh --write      # write to .git/dx-feedback/{SHA}-proof.xml
bash scripts/dx-feedback-proof.sh --edit       # write + open in $EDITOR
```

### Bypass

- `DX_FEEDBACK_SKIP=1 git push` — env variable (emits warning)
- `git push --no-verify` — standard git bypass (skips entire pre-push hook)

### Timeout

The pipeline has a 5-minute hard timeout. At 4 minutes, a tmux warning is sent to the agent. If the timeout expires without feedback, the push proceeds (graceful degradation — don't brick pushes when fleet is unavailable).

### Validation Script

`scripts/dx-feedback-gate.ts` handles all parsing and validation (uses `fast-xml-parser`). Can also run standalone for CI: `bun run scripts/dx-feedback-gate.ts --validate-proof <path>`.

---

## Evolving This Checklist

This document is a living checklist. During any deep review, if Claude identifies a recurring failure mode, anti-pattern, or drift category not covered above, it should **propose a new Always Flag item** by appending to the relevant section (or creating a new subsection). Include:

1. **Numbered item** with a bold name and 1–2 sentence description of what to flag
2. **Severity override** row if the default `high` doesn't fit
3. **Proof XML check** name if the item is deterministically verifiable
4. **`scripts/review.sh` check** if it can be automated — add the implementation and bump the item range in the script header comment

Proposals are committed alongside the review that surfaced them. No separate approval process — if a pattern caused a real bug or near-miss, it belongs here.

---

## Installation & Setup

Fleet has two setup paths:

```bash
fleet setup                # Core bootstrap: symlinks, deps, Fleet Mail, MCP, hooks
fleet setup --extensions   # Core + build and install all extensions (watchdog, review, etc.)
fleet update               # Pull latest code, reinstall deps, re-run setup
fleet update --reload      # Pull + setup + recycle all running workers
```

**What `fleet setup` does** (always idempotent):
1. Check dependencies (bun, tmux, claude)
2. Create symlinks (`~/.claude-fleet`, `~/.local/bin/fleet`)
3. Create `~/.claude/fleet/defaults.json`
4. Connect or start Fleet Mail
5. Register MCP servers (`worker-fleet`, `claude-hooks`) in `~/.claude/settings.json`
6. Install hooks (4 events, preserves non-fleet hooks)
7. Detect extensions (watchdog, deep review, TUI) — prints install hints

**What `--extensions` adds** (installs everything):
- **Watchdog**: Builds Rust binary (`extensions/watchdog-rs/`) if cargo available, falls back to TypeScript. Installs launchd daemon for auto-restart.
- **Deep review**: Runs `extensions/review/install.sh` — symlinks REVIEW.md, installs pre-commit hook, links review scripts.
- **Fleet Mail TUI**: Detected if on PATH (separate build).

**What `fleet update --reload` does**:
- `git pull origin main` → `bun install` → `fleet setup` → recycle all running workers (sets status to `"recycling"`, kills panes, watchdog respawns with fresh config).

## Related Conventions

- [conventions/README-CONVENTIONS.md](conventions/README-CONVENTIONS.md) — 100 rules for writing READMEs. Applied to this project's README.
- [qbg-dev/conventions](https://github.com/qbg-dev/conventions) — shared conventions across qbg-dev projects.
