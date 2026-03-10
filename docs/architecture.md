# Architecture

Four components: CLI, MCP server, watchdog, hooks. All TypeScript/shell + JSON.

```
fleet CLI (commander + Bun)
    │
    ├── MCP Server (20 tools) ─── loaded into every Claude session via .mcp.json
    │
    ├── Watchdog (launchd, 30s) ── respawns dead/stuck workers
    │
    └── Hooks (settings.json) ──── PreToolUse, PostToolUse, Stop, PromptSubmit
```

Each worker = Claude Code session + git worktree + tmux pane + persistent config.

## MCP Server

`mcp/worker-fleet/index.ts` + extracted modules (`config.ts`, `state.ts`, `hooks.ts`, `mail-client.ts`, `seed.ts`, `tmux.ts`, `helpers.ts`, `diagnostics.ts`).

20 tools in 6 categories: mail (4), state (2), hooks (4), lifecycle (2), fleet (7), review (1).

Identity auto-detected from `WORKER_NAME` env or git branch (`worker/*` → name).

Workers are isolated Claude sessions. The MCP server is the only way they see each other.

## Watchdog

`scripts/harness-watchdog.sh` — launchd daemon (`com.claude-fleet.harness-watchdog`), checks every 30s.

**Stuck detection** (three layers):
1. `(running)` guard — if statusline shows running, skip (long bash command)
2. Scrollback hash — MD5 of last 30 lines, compared to previous
3. Time threshold — idle >10min → kill + respawn

**Crash-loop protection**: >3 crashes/hour → stop, alert human.

**Perpetual workers**: read `sleep_duration` from config, wait, then respawn.

## Hooks

Registered in `~/.claude/settings.json` by `fleet setup` (via `scripts/setup-hooks.sh`).

| Hook | Script | Purpose |
|------|--------|---------|
| PreToolUse | `hooks/interceptors/pre-tool-context-injector.sh` | Inject inbox, policy context, dynamic hooks |
| PostToolUse | `hooks/publishers/post-tool-publisher.sh` | Publish events, liveness heartbeat |
| Stop | `hooks/gates/stop-worker-dispatch.sh` | Gate exit until checks pass, write graceful-stop |
| PromptSubmit | `hooks/publishers/prompt-publisher.sh` | Publish prompt events, liveness heartbeat |

**Safety gates** (`hooks/gates/tool-policy-gate.sh`): 12 system hooks block rm -rf, force push, reset --hard, kill-session, checkout main, merge, config edits.

**Dynamic hooks**: workers register their own at runtime via `add_hook()`. Three tiers: system (irremovable) > creator (worker can't remove) > self (worker manages).

## Storage

```
~/.claude/fleet/
├── defaults.json              # global defaults
└── {project}/
    ├── fleet.json             # fleet-wide config (authorities, tmux session)
    └── {worker}/
        ├── config.json        # model, hooks, permissions
        ├── state.json         # status, pane, cycles
        ├── mission.md         # purpose
        ├── launch.sh          # auto-generated
        └── token              # Fleet Mail auth

~/.claude-fleet/               # infrastructure (this repo)
├── cli/                       # TypeScript CLI
├── mcp/worker-fleet/          # MCP server
├── hooks/                     # gates, interceptors, publishers
├── scripts/                   # watchdog, launch, deep-review
├── templates/                 # worker archetypes, seed templates
├── tools/dr-context/          # Rust binary (deep review analysis)
├── shared/                    # canonical types (WorkerConfig, WorkerState, etc.)
└── lib/                       # shared bash libraries
```

## Data Flow

```
fleet create → worktree + config + pane + seed prompt
    ↓
Worker runs autonomously:
    PreToolUse → inject inbox/context on each tool call
    Worker commits → post-commit hook notifies merger
    Worker calls recycle() → Stop hook writes graceful-stop
    ↓
Watchdog sees graceful-stop:
    Wait sleep_duration → fresh seed → respawn in same pane → cycle repeats
```
