---
description: "Sync harness learnings from current project back to claude-ops (upstream)"
allowed-tools: Bash, Read, Write, Edit, Glob, Grep
---

# Sync Harness Learnings to Upstream (claude-ops)

You are syncing improvements made in the current project's harness back to the upstream `claude-ops` repo at `~/.claude-ops`.

## Context

The claude-ops repo is the **upstream template** for all Claude agent infrastructure — watchdog, worker scripts, hooks, bus, templates. Individual projects (like Wechat) evolve these files through daily use. This command syncs those learnings back upstream so future projects benefit.

## Steps

### 1. Discover what's changed

Run these in parallel:

```bash
# Modified files in claude-ops repo (direct edits via symlinks)
git -C /Users/wz/.claude-ops diff --stat

# Project-specific scripts that diverged from claude-ops copies
for f in .claude/scripts/*.sh; do
  [ -L "$f" ] && continue  # skip symlinks (already in claude-ops)
  base=$(basename "$f")
  ops="/Users/wz/.claude-ops/scripts/$base"
  [ -f "$ops" ] && ! diff -q "$f" "$ops" >/dev/null 2>&1 && echo "DIVERGED: $base"
done

# New files in claude-ops not yet tracked
git -C /Users/wz/.claude-ops status --short | grep '^??'
```

### 2. Categorize changes

For each changed file, determine:

| Category | Action |
|----------|--------|
| **Bug fix** (watchdog, detection logic, zsh compat) | Sync to claude-ops immediately |
| **New feature** (register-pane.sh, border indicators) | Copy to claude-ops/scripts or claude-ops/templates |
| **Project-specific** (seed scripts, mission files) | Do NOT sync — these are Wechat-specific |
| **Template improvement** (worker state.json, permissions patterns) | Update claude-ops/templates/ |
| **New reusable pattern** (PERPETUAL-PROTOCOL.md) | Copy to claude-ops/templates/flat-worker/ |

### 3. Sync files

For each file to sync:
- If it's a symlinked file (already in claude-ops): changes are already there, just needs commit
- If it diverged from claude-ops copy: diff the two, merge improvements
- If it's new and reusable: copy to appropriate claude-ops directory

### 4. Review and present

Show Warren a summary table:

| File | Change | Category | Synced? |
|------|--------|----------|---------|
| scripts/harness-watchdog.sh | TUI detection fix, full seed injection | Bug fix | ✓ already in claude-ops |
| scripts/register-pane.sh | New self-registration | New feature | → claude-ops/scripts/ |
| ... | ... | ... | ... |

### 5. Commit to claude-ops

```bash
cd /Users/wz/.claude-ops
git add -A  # or specific files
git commit -m "sync(harness): learnings from Wechat project

- [list key improvements]

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

## Key files to check

**Scripts (claude-ops/scripts/):**
- `harness-watchdog.sh` — watchdog detection, respawn logic, seed injection
- `fleet-health.sh` — fleet status + health check
- `launch-flat-worker.sh` — worker launch with registration
- `worker-commit.sh` — worker git commit helper
- `pre-compact.sh` — context compaction

**Hooks (claude-ops/hooks/):**
- `gates/stop-session.sh` — stop hook checklist
- `gates/tool-policy-gate.sh` — tool permission enforcement
- `publishers/post-tool-publisher.sh` — bus event publishing
- `interceptors/pre-tool-context-injector.sh` — context injection

**Templates (claude-ops/templates/flat-worker/):**
- `state.json` — worker state template
- New: `PERPETUAL-PROTOCOL.md` if it should be a default template

**Bus (claude-ops/bus/):**
- `schema.json` — event bus schema
- `side-effects/` — bus event handlers

## Rules

- NEVER sync project-specific content (mission files, seed scripts with project names, credentials)
- ALWAYS preserve backward compatibility — other projects use claude-ops too
- If a claude-ops file was modified for project-specific reasons, extract the reusable part
- Present the diff summary to Warren before committing
