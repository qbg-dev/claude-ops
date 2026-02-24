---
name: "cx Codex Session Manager"
description: "Full reference for cx CLI: all commands, permission presets, granular permissions, launch options, slug matching, and output behavior."
---

# cx -- Codex Session Manager

Repo: `~/Desktop/zPersonalProjects/cx/`
Wraps `codex exec --json` as background processes. Data: `~/.cx/tasks/`, `~/.cx/logs/`

## Commands

- `cx launch "prompt" [options]` -- spawn async codex, returns slug instantly
- `cx list [-a] [--json]` -- table of tasks (default: running only)
- `cx status <slug> [--json]` -- detailed single-task view
- `cx logs <slug> [-f] [--raw]` -- formatted event log, optionally follow
- `cx diff <slug> [--stat]` -- git diff from launch baseline
- `cx kill <slug>` -- SIGTERM -> 3s -> SIGKILL

## Launch Options

`-C dir` -- working directory
`-m model` -- model override
Plus permission flags below.

## Permission Presets

- (default) `--full-auto` -- sandbox=workspace-write, approval=on-request
- `--yolo` -- no sandbox, no approvals (DANGEROUS)

## Granular Permissions

- `-s <mode>` -- sandbox: read-only | workspace-write | danger-full-access
- `-a <mode>` -- approval: untrusted | on-failure | on-request | never
- `--add-dir <dir>` -- extra writable dirs (repeatable)
- `-c <k=v>` -- raw codex config override (repeatable)

## Tips

- Partial slug matching: `cx logs bold` resolves to `bold-falcon-a3f2`.
- Auto-detects non-TTY: ANSI colors stripped when piped (clean output for Claude).
- Use `--json` on list/status for machine-readable output.
