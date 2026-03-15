# claude-fleet

Every Claude Code session is automatically part of the fleet. Your identity is your Fleet Mail name, derived from your session ID.

## Identity

On first prompt, a global hook auto-registers you with Fleet Mail:
- **Mail name**: `{custom-name}-{dir-slug}-{session-id}` (e.g., `merger-zPersonalProjects-a3f1b2c8-...`)
- **Three-part identity**: mail-name + session + tmux-pane. Without a pane = assumed dead.
- **Session file** is the primary object. Transcripts sync to Fleet Mail every 5 minutes.
- Check yours: `fleet session info`

Multiple agents in the same directory each get unique mail names (different session IDs). Register a custom name: `fleet register --name <name>`.

## Communication

All fleet communication is via CLI (run with Bash tool). No MCP tools for fleet ops.

```
fleet mail send <to> "<subject>" "<body>"   # send message
fleet mail inbox [--label UNREAD]           # read inbox
fleet mail read <id>                        # read message by ID
fleet mail help                             # API reference + curl examples
```

Recipient resolution: substring match (e.g., `merger` finds the first account containing "merger"), full mail name, or `list:<name>` for mailing lists.

## State & Lifecycle

```
fleet state get [key]                       # read state
fleet state set <key> <value>               # persist across recycles
fleet checkpoint "<summary>"                # save crash-recovery snapshot
fleet register [--name <n>]                 # re-register with custom name
fleet session ls                            # list all live sessions
fleet session sync                          # force transcript sync
```

## Hooks

Dynamic hooks via `mcp__claude-hooks__*` MCP tools:
- `mcp__claude-hooks__add_hook(event, description, ...)` — register gate, inject, or script
- `mcp__claude-hooks__complete_hook(id)` — unblock a gate
- `mcp__claude-hooks__list_hooks()` — see active hooks
- `mcp__claude-hooks__remove_hook(id)` — archive a hook

Static hooks fire automatically (47 hooks across 18 events). Key ones:
- **UserPromptSubmit**: auto-registration, session sync, liveness heartbeat
- **PreCompact**: re-injects seed template + mission to survive context compaction
- **Stop**: inbox drain, unpushed commits check, task verification

## Orchestration

For managed workers (created via `fleet create`):

```
fleet create <name> "<mission>"             # create + launch in tmux
fleet start <name>                          # restart worker
fleet stop <name> [--all]                   # graceful stop
fleet ls [--json]                           # list workers with liveness
fleet status                                # fleet overview dashboard
fleet get <name>                            # show worker mission + info
fleet attach <name>                         # focus worker's tmux pane
fleet recycle [name]                        # restart with fresh context
fleet log <name>                            # tail worker output
fleet fork <parent> <child> "<mission>"     # fork from existing
fleet nuke <name>                           # destroy worker
```

## Mission

Every session has a `mission.md` (starts empty). Fill it in as you understand your task. The template + mission are re-injected on context compaction so you never lose track.

## Watchdog

launchd daemon (`com.tmux-agents.watchdog`), 30s poll. Respawns dead workers, kills stuck (10min timeout), crash-loop protection (3/hr max). Perpetual workers call `round_stop()` — watchdog respawns after `sleep_duration`.

Install: `bash extensions/watchdog/install.sh`

## Conventions

- Workers never push or merge—merger handles main
- tmux: never literal Enter (`send-keys -H 0d`), never `display-message -p '#{pane_id}'`
- Use Fleet Mail for all coordination (tasks = mail threads with TASK label)
- Run `fleet --help` for the full CLI reference

## Infrastructure

```
fleet setup [--extensions]                  # bootstrap (installs hooks, MCP)
fleet onboard                               # guided setup + fleet architect
fleet mail-server [connect|start]           # Fleet Mail server management
fleet mcp [register|status]                 # MCP server management
fleet doctor                                # verify health
fleet update [--reload]                     # pull + reinstall
fleet deploy <host> <repo-url>              # deploy to remote
fleet completion                            # output shell completions
```

## Agent Specs & `fleet run`

AgentSpec is the universal unit—YAML/JSON files that fully describe an agent. Every way to create an agent (CLI, program file, MCP tool, architect) consumes the same format.

```
# From spec file (YAML/JSON — all fields optional except name)
fleet run --spec solver.agent.yaml

# From flags (builds spec inline)
fleet run --prompt "Solve it" --model sonnet[1m] --name solver

# Chaining agents
fleet run --prompt "Do X" --on-stop "fleet run --spec next.agent.yaml"

# With event tools
fleet run --spec agent.yaml --tool "submit:Submit results:cmd=echo done:score=number"

# Interactive (original behavior)
fleet run [name]
```

Key `fleet run` flags: `--spec`, `--prompt`, `--model`, `--runtime` (claude|sdk|codex|custom), `--effort`, `--permission`, `--hook "EVENT:CMD"`, `--on-stop`, `--tool`, `--env KEY=VALUE`, `--allowed-tools`, `--disallowed-tools`, `--system-prompt`, `--add-dir`, `--window`, `--dir`, `--json-schema`, `--max-budget`.

### Runtimes

| Runtime | Launcher | Best for |
|---------|----------|----------|
| `claude` (default) | `claude` CLI in tmux | Interactive, general agents |
| `sdk` | `@anthropic-ai/claude-agent-sdk` `query()` via bun | Programmatic, CI/CD, structured output, subagents |
| `codex` | `codex exec` CLI | OpenAI models |
| `custom` | Your command string | Anything else |

Default models: `opus[1m]` (workers), `sonnet[1m]` (pipelines). The `[1m]` suffix selects the 1M context variant.

### Event Tools (Druids-style)

Custom MCP tools per agent. Defined in spec `tools:` or `--tool` flag. Two modes:
- `mode: inline` — calls exported TS function from program file
- `mode: command` — runs bash with `INPUT_*` env vars

Handler context provides: `sendMail()`, `updateState()`, `spawnWorker()`, `writeResult()`, `readResult()`.

## Advanced

```
fleet config <name> [key] [value]           # get/set worker config
fleet defaults [key] [value]                # global defaults
fleet run --spec <file> [--flags]           # launch agent from spec
fleet tui [--account <name>]                # Fleet Mail TUI client
fleet layout <save|restore|list|delete>     # tmux layout persistence
fleet deep-review <scope>                   # adversarial code review
fleet pipeline <program> [opts]             # launch a program-API pipeline
fleet hook <add|rm|ls|complete>             # manage dynamic hooks (CLI)
fleet launch                                # launch fleet from manifest
```
