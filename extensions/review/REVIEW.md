# REVIEW.md — Deep Review Rules for claude-fleet

Project context: CLI orchestration tool for Claude Code agents (Bun + TypeScript), tmux-based lifecycle, Fleet Mail messaging, MCP server, zsh completions.

---

## Always Flag (default-high severity, see Severity Overrides for exceptions)

### Doc Sync (pre-commit gate)

These are checked by the pre-commit hook whenever CLI, doc, completion, or test files are staged. Claude must verify each and write proof XML before committing.

1. **CLI ↔ CLAUDE.md drift**: Every command registered in `cli/commands/*.ts` (via `.command("name")`) must appear in the `## CLI` code block of `CLAUDE.md`. Aliases (`.alias()`) satisfy the check. No stale commands in CLAUDE.md that were removed from CLI.

2. **CLI ↔ completions drift**: Every registered command must have a `'name:Description'` entry in `completions/fleet.zsh`. Aliases need their own entries. Commands with subcommands need completion handlers in the `case` block.

3. **CLI ↔ tests drift**: Every registered command must appear in `cli/tests/help-format.test.ts` `ALL_COMMANDS` array. The "contains all N commands" test description must match actual count. `commands-smoke.test.ts` should have `--help` tests for write commands.

4. **Key files table stale**: New command files or scripts introducing significant functionality must be reflected in the `## Key files` table in CLAUDE.md.

5. **Cross-reference breakage**: `~/.claude/fleet.md` symlink must resolve to the same CLAUDE.md. If MCP tools changed, the MCP tools table must be current.

### MCP Server

6. **Tool schema mismatch**: MCP tool definitions in `mcp/worker-fleet/tools/*.ts` must match the tool table in CLAUDE.md and the `fleet_help()` output in `mcp/worker-fleet/helpers.ts`.

7. **Missing input validation**: MCP tool handlers accepting worker names, project names, or paths without sanitization. These are called by LLM agents — never trust input.

8. **State mutation without locking**: Writing to `config.json` or `state.json` without the `mkdir`-based atomic lock pattern. Concurrent workers can corrupt JSON.

### CLI Commands

9. **Missing `addGlobalOpts()`**: New commands that don't call `addGlobalOpts(sub)`, breaking `--project` and `--json` passthrough.

10. **Hardcoded tmux session names**: Using literal session names instead of reading from `fleetConfig.tmux_session` or `DEFAULT_SESSION`.

11. **Missing error handling on tmux calls**: `Bun.spawnSync()` for tmux commands without checking `exitCode` — tmux may not be running.

### Hooks

12. **Hook ownership violation**: Worker-created hooks (`self` tier) that bypass the ownership model — e.g., removing `system` or `creator` hooks, or hooks that disable safety gates.

13. **Hook event mismatch**: Hook registered for wrong event (e.g., `PreToolUse` handler in a `Stop` event). The `manifest.json` event names must match Claude Code's actual event names.

### Worker Lifecycle

14. **Worktree path injection**: Worker names used in `git worktree add` or file paths without sanitization. Names come from user input or Fleet Mail.

15. **Missing cleanup on nuke/stop**: Worker teardown that leaves orphaned tmux panes, stale worktrees, or dangling Fleet Mail accounts.

16. **Crash loop bypass**: Changes to watchdog or recycle logic that weaken crash-loop protection (3/hr max).

### Release & Version Integrity

17. **Version string drift**: `cli/index.ts` `.version()`, `CHANGELOG.md` latest version header, and `package.json` `version` (if present) must all agree. Any version bump must update all locations.

18. **Changelog freshness**: If `cli/` or `mcp/` source files are in the staged diff, `CHANGELOG.md` `[Unreleased]` section should have a corresponding entry. Warn-only — can be `skip` with justification in proof XML.

### Security Hygiene

19. **Secrets in staged diff**: Staged changes must not contain Fleet Mail tokens, API keys, passwords, or high-entropy strings matching `token`, `password`, `secret`, `Bearer`. Allowlist: type definitions, doc examples, test fixtures.

### Structural Integrity

20. **Import boundary violation**: `mcp/worker-fleet/` must not import from `cli/`. `cli/` must not import from `mcp/`. Both may import from `shared/`. Cross-boundary imports cause runtime failures (MCP server and CLI are separate processes).

21. **MCP tool count drift**: CLAUDE.md "MCP tools (N)" header must match actual tool count in `mcp/worker-fleet/index.ts`. Tool table rows in CLAUDE.md must match tool registrations.

### Template & Seed Integrity

23. **MCP tool reference staleness**: `templates/seed-context.md` must reference only MCP tools that are actually registered in `mcp/worker-fleet/tools/*.ts`. Newly registered tools must be documented in the seed context.

24. **Hook event staleness**: Hook event names in template seeds must match events in `hooks/manifest.json`. Adding or renaming events requires updating all seed templates.

25. **Worker type drift**: Every directory in `templates/flat-worker/types/` must have a corresponding row in the CLAUDE.md `## Worker types` table, and vice versa. Each type directory must contain a `mission.md`.

26. **Key files table staleness**: Every path in the CLAUDE.md `## Key files` table must resolve to an existing file. Adding significant new files requires updating the table.

27. **Hook count drift**: CLAUDE.md "N hooks across M events" must match the actual counts in `hooks/manifest.json`.

### Operational Safety

28. **Idempotency regression**: `fleet setup`, `scripts/setup-hooks.sh`, and `fleet doctor --fix` must be idempotent. Running twice produces identical results — no duplicate hooks, no duplicate configs, no errors.

---

## Never Flag (intentional design patterns)

1. **`sleep_duration: null` as one-shot signal**: Not a bug — `null` means one-shot worker, `N > 0` means perpetual. No separate `perpetual` field.

2. **`send-keys -H 0d` instead of literal Enter**: tmux `send-keys Enter` is unreliable in some terminal states. Hex 0d is the canonical pattern.

3. **`mkdir`-based locking instead of file locks**: Atomic on all filesystems, no cleanup needed on crash. Intentional simplicity over flock.

4. **Workers can't update other workers' config**: By design. Cross-worker config changes go through Fleet Mail suggestions.

5. **No `disallowed_tools` field**: Removed in v2. Tool restrictions use hooks (`PreToolUse` gate) instead.

6. **`report_to` removed**: Workers communicate via Fleet Mail, not hierarchical reporting.

7. **MCP server split into 15 modules**: Was a 4,656-line monolith. The module count is intentional, not over-engineering.

---

## Severity Overrides

| Pattern | Override |
|---------|----------|
| Doc sync drift (1–5) caught by `check-docs.sh` | medium (deterministic scan catches most) |
| Doc sync drift missed by deterministic scan (descriptions, key files) | high (only AI verification catches these) |
| MCP tool schema mismatch | high (workers rely on accurate tool docs) |
| Missing input validation in MCP handlers | critical (LLM agents are unpredictable callers) |
| State mutation without locking | critical (silent data corruption) |
| Missing `addGlobalOpts()` | low (easy to spot, easy to fix) |
| Worktree path injection | critical (shell command injection risk) |
| Crash loop bypass | high (runaway agents burn API credits) |
| Version string drift (17) | medium (causes confusion, not data loss) |
| Changelog freshness (18) | low (warn-only, not blocking) |
| Secrets in staged diff (19) | critical (credential exposure) |
| Import boundary violation (20) | high (runtime failure in prod) |
| MCP tool count drift (21) | medium (worker confusion, not crash) |
| MCP tool reference staleness (23) | medium (worker confusion, not crash) |
| Hook event staleness (24) | medium (hooks may silently not fire) |
| Worker type drift (25) | low (cosmetic, no runtime impact) |
| Key files table staleness (26) | low (documentation accuracy) |
| Hook count drift (27) | low (documentation accuracy) |
| Idempotency regression (28) | high (watchdog amplifies the failure) |

---

## Pre-commit Verification

When the pre-commit hook fires (staged files match `cli/|CLAUDE.md|README.md|completions/`):

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
  </checks>
  <summary>1-2 sentence assessment</summary>
</verification>
```

All checks must be `pass` or `skip` (with justification). Proof is hash-tied to staged diff — any staging change invalidates it.

### Automated Review Script

Run `bash scripts/review.sh` for a deterministic scan of items 17–22 (renumbered to 17–22→17–28 with template checks). `bash scripts/check-templates.sh` scans items 23–27 (template & seed staleness). `bash scripts/check-docs.sh` covers items 1–5. All three run automatically in the **pre-push hook** — errors block the push, warnings are advisory. The pre-commit hook still requires AI-verified proof XML for anything the scripts can't catch.

---

## Evolving This Checklist

This document is a living checklist. During any deep review, if Claude identifies a recurring failure mode, anti-pattern, or drift category not covered above, it should **propose a new Always Flag item** by appending to the relevant section (or creating a new subsection). Include:

1. **Numbered item** with a bold name and 1–2 sentence description of what to flag
2. **Severity override** row if the default `high` doesn't fit
3. **Proof XML check** name if the item is deterministically verifiable
4. **`scripts/review.sh` check** if it can be automated — add the implementation and bump the item range in the script header comment

Proposals are committed alongside the review that surfaced them. No separate approval process — if a pattern caused a real bug or near-miss, it belongs here.
