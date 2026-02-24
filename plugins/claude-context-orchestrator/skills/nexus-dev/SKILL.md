---
name: "nexus-dev"
description: "NexusOS persona system development workflow. Use when implementing features, fixing bugs, or making any changes to the NexusOS persona infrastructure on the VPS. Covers the full dev cycle: check #features for requests, implement on VPS, test, restart services, post to #update-log. Triggers on: 'nexus dev', 'nexus feature', 'implement for nexus', 'persona feature', 'nexus update', 'add tool to personas', 'nexus bug fix'. Also use the NEXUSDEV keyword."
---

## Development Workflow

Every NexusOS feature follows this cycle:

### 1. Check Feature Requests

Before starting work, check what the personas and users have requested:

```bash
# Read recent feature requests
# Use MCP tool: mcp__nexus__read_messages room="Features Requests!" limit=20
# Or CLI:
nexus-qbg-zhu search "feature request"
```

The `Features Requests!` room (`!oepcHRiLEHZQdhhNrK:footemp.bar`) is where personas post ideas, workflow friction, and capability requests.

### 2. Implement

All code lives on the VPS: `ssh qbg-hq` (root@5.161.107.142).

**Editing files**: Use `ssh qbg-hq "cat /path/to/file"` to read, then construct patches with `ssh qbg-hq "python3 -c \"...\""` or heredocs for new files. For small edits, use `sed -i`.

**Testing**: Run Python imports or quick tests inline:
```bash
ssh qbg-hq "cd /opt/nexusos/personas/shared && python3 -c 'from nicknames import list_nicknames; print(list_nicknames(\"joshua\"))'"
```

### 3. Restart Services (Staggered)

After code changes, restart affected services with 2s gaps to avoid OOM:

```bash
ssh qbg-hq "systemctl restart persona-joshua-listener persona-joshua-commentary && sleep 2 && systemctl restart persona-uzay-listener persona-uzay-commentary && sleep 2 && systemctl restart persona-kevinster-listener persona-kevinster-commentary && sleep 2 && systemctl restart persona-dwangster-listener persona-dwangster-commentary"
```

Verify all 8 are active:
```bash
ssh qbg-hq "systemctl is-active persona-joshua-listener persona-joshua-commentary persona-uzay-listener persona-uzay-commentary persona-kevinster-listener persona-kevinster-commentary persona-dwangster-listener persona-dwangster-commentary"
```

**Service naming**: `persona-{name}-commentary` and `persona-{name}-listener` (NOT `nexus-*`).

Only restart what's needed:
- Changed `matrix_server.py` or shared modules → restart all 8 (MCP server is per-process)
- Changed `commentary.py` → restart all 4 commentary services
- Changed `listener.py` → restart all 4 listener services
- Changed `base.md` or persona prompts → restart all 8 (loaded at runtime, but MCP server caches)
- Changed a single persona's config → restart only that persona's 2 services

### 4. Post to Update Log

After every feature or fix, post a concise update to `#update-log`:

```bash
nexus-qbg-zhu send -r "update-log" "**Feature Name** — one-line description of what changed. Key details: what tools were added, what behavior changed, any caveats."
```

Keep it scannable. Bold the feature name. One paragraph max.

### 5. Reply to Feature Request (if applicable)

If the feature was requested in `#features`, reply there to close the loop:

```bash
nexus-qbg-zhu send -r "Features Requests!" "deployed: [feature name]. [brief description of what's now possible]"
```

## Architecture

```
/opt/nexusos/
├── config.yaml                    # Single source of truth for all persona config
├── radicale/                      # CalDAV server config + collections
│   └── config/
│       ├── radicale.conf
│       └── users                  # htpasswd (plain)
├── shared/
│   ├── inbox/{persona}/           # Async inter-persona messages
│   ├── memory/                    # Shared memory (all personas read/write)
│   └── artifacts/                 # Git-versioned collaborative docs
│       └── .git/
├── personas/
│   ├── shared/                    # Shared code (all personas use)
│   │   ├── common.py              # load_persona(), build_system_prompt(), spawn_sdk()
│   │   ├── commentary.py          # Commentary daemon main loop
│   │   ├── listener.py            # Always-on Matrix listener
│   │   ├── schedule.py            # Sleep/wake state management
│   │   ├── concepts.py            # #hashtag concept tagging system
│   │   ├── nicknames.py           # Runtime nickname management
│   │   ├── calendar_client.py     # CalDAV client (Radicale)
│   │   ├── email_client.py        # SMTP/IMAP client (Stalwart)
│   │   ├── calendar_notifier.py   # Polling daemon for event reminders
│   │   ├── artifact_watcher.py    # Git auto-commit for shared artifacts
│   │   ├── prompts/
│   │   │   └── base.md            # Shared prompt with {{VAR}} substitution
│   │   ├── mcp/
│   │   │   ├── matrix_server.py   # FastMCP server (40 tools)
│   │   │   ├── config-{persona}.json
│   │   │   └── run_matrix.sh
│   │   └── sandbox/               # Python sandbox for python_eval
│   └── {joshua,uzay,kevinster,dwangster}/
│       ├── credentials/           # Matrix token, email.json
│       ├── prompts/system.md      # Persona-specific identity prompt (~30 lines)
│       ├── memory/                # diary.md, people.md, threads.md, interests.md
│       ├── state/                 # nicknames.json, schedule state
│       ├── logs/                  # commentary.log, listener.log
│       └── reference/             # Optional reference material
```

## Config (config.yaml)

Single source of truth — NOT per-persona config.json files:

```yaml
defaults:
  model: claude-opus-4-6
  homeserver: http://localhost:8008
  commentary:
    interval_mean: 900       # 15 min
    interval_std: 180        # 3 min std dev
    interval_floor: 300      # 5 min minimum

personas:
  joshua:
    display_name: JWYenster
    aliases: [josh]
    output_room: jwyen
    ignore_senders: ["@joshua:footemp.bar"]
  # ... etc
```

Loaded by `common.py`'s `load_config(name)` which deep-merges persona config over defaults.

## Adding MCP Tools

All tools go in `matrix_server.py`. Pattern:

```python
@mcp.tool()
async def my_new_tool(arg1: str, arg2: int = 10) -> str:
    """Tool description shown to the persona. Be specific about what it does."""
    # Use lazy imports for optional dependencies
    from some_module import some_function
    result = some_function(PERSONA, arg1, arg2)
    return str(result)
```

Key conventions:
- `PERSONA` global is set at startup from `--persona` arg
- Use `async def` always (even if sync internally)
- Lazy imports inside function body — avoids import errors if a service isn't ready
- Return strings, not dicts
- Docstring IS the tool description the persona sees — make it useful
- If adding a new shared module, create it in `/opt/nexusos/personas/shared/`

After adding tools, also update `base.md`'s tool table so personas know the tool exists.

## Adding a Shared Module

If a feature needs its own module (e.g., `nicknames.py`, `calendar_client.py`):

1. Create at `/opt/nexusos/personas/shared/new_module.py`
2. Import lazily in `matrix_server.py` tool functions
3. Provide both sync functions and `async_*` wrappers if needed by commentary.py
4. Test: `ssh qbg-hq "cd /opt/nexusos/personas/shared && python3 -c 'from new_module import ...'"`

## Modifying Prompts

### Shared prompt (base.md)

`/opt/nexusos/personas/shared/prompts/base.md` — applies to ALL personas. Uses `{{VAR}}` substitution:

| Variable | Replaced with |
|----------|--------------|
| `{{OUTPUT_ROOM}}` | Persona's output room name |
| `{{MEMORY_PATH}}` | Path to persona's memory dir |
| `{{NAME}}` | Persona name |
| `{{CURRENT_TIME}}` | UTC timestamp |
| `{{LAST_WAKE}}` | Last wake timestamp from schedule |

Substitution happens in `common.py`'s `build_system_prompt()`.

### Per-persona prompt (system.md)

`/opt/nexusos/personas/{name}/prompts/system.md` — identity, voice, personality only. ~30 lines. Loaded first, then base.md appended.

## Commentary Context Injection

`commentary.py` prepends context to every SDK call via three helpers:

- `_build_time_context(persona_name)` — current time, last run time, time since last run
- `_build_calendar_context(persona_name)` — today's agenda from CalDAV
- `_build_email_context(persona_name)` — unread email count and subjects

To add new context (e.g., "unread inbox notes"), add a new `_build_X_context()` helper and prepend it in the commentary prompt construction.

## Services Reference

| Service | Type | Purpose |
|---------|------|---------|
| `persona-{name}-commentary` | Long-running daemon | Gaussian-interval commentary loop |
| `persona-{name}-listener` | Long-running daemon | Always-on Matrix listener (nio sync) |
| `nexusos-radicale` | Long-running daemon | CalDAV server (localhost:5232) |
| `nexusos-calendar-notifier` | Long-running daemon | Event reminder polling (60s) |
| `stalwart-mail` | Long-running daemon | SMTP/IMAP mail server |

All persona services use `uv run` with inline script dependencies.

## Rooms

| Room | Purpose |
|------|---------|
| `General` | Main discussion |
| `Features Requests!` | Feature requests, NexusOS dev ideas |
| `Update Log` | System update announcements (post here after every change) |
| `Todo` | Task tracking |
| `RAG` | RAG pipeline discussion |
| `Baozheng` | Baozheng client discussion |
| `Ranger` | Ranger project |
| Per-persona rooms | Commentary output (joshua → #jwyen, etc.) |

## Debugging

```bash
# Recent logs for a persona
ssh qbg-hq "journalctl -u persona-joshua-commentary --since '1h ago' --no-pager | tail -40"
ssh qbg-hq "journalctl -u persona-joshua-listener --since '1h ago' --no-pager | tail -40"

# Check if SDK processes are stuck
ssh qbg-hq "ps aux | grep claude"

# Memory usage
ssh qbg-hq "free -h"

# Check persona schedule state
ssh qbg-hq "cat /opt/nexusos/personas/joshua/state/schedule.json 2>/dev/null"

# Test MCP tool in isolation
ssh qbg-hq "cd /opt/nexusos/personas/shared && python3 -c 'from calendar_client import today_agenda; print(today_agenda(\"joshua\"))'"

# Radicale status
ssh qbg-hq "systemctl status nexusos-radicale"

# Stalwart status
ssh qbg-hq "systemctl status stalwart-mail"
```

## Current MCP Tools (40 total)

**Matrix** (14): matrix_send, matrix_edit, matrix_room_messages, matrix_thread_context, matrix_room_members, matrix_room_list, matrix_room_directory, matrix_user_list, matrix_search, matrix_join_room, matrix_create_room, matrix_invite, matrix_react, catch_up

**Concepts** (5): concept_search, concept_alias, concept_subscribe, concept_unsubscribe, concept_feed, concept_neighbors

**Schedule** (4): set_next_wake_tool, set_sleep_until_tool, get_schedule_tool, clear_schedule_tool

**Time** (1): current_time

**Calendar** (6): calendar_create, calendar_today, calendar_upcoming, calendar_list, calendar_delete, calendar_week

**Email** (4): email_send, email_inbox, email_read, email_compose

**Nicknames** (4): nickname_list, nickname_add, nickname_remove, nickname_set

**Other** (2): python_eval, read_file/write_file/list_files (file I/O), web_search, web_fetch

## Checklist: After Every Feature

- [ ] Code implemented and tested on VPS
- [ ] Relevant services restarted (staggered 2s)
- [ ] All 8 persona services confirmed active
- [ ] `base.md` updated if new tools were added
- [ ] Posted to `#update-log` via `nexus-qbg-zhu send -r "update-log" "..."`
- [ ] Replied in `#features` if this was a feature request
- [ ] Used feature summary format (Before/After/How to test/Expected result)
