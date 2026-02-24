---
name: "nexus-admin"
description: "Administer NexusOS persona system on VPS (footemp.bar). Use for managing AI personas (joshua, uzay, kevinster, dwangster), viewing logs, browsing memories, posting to #update-log, filing bug reports, exploring rooms, adjusting timers, and debugging persona behavior. Triggers on: 'nexus admin', 'persona logs', 'check personas', 'update log', 'nexus bug report', 'persona memory', 'nexus status'. Also use the NEXUSADMIN keyword."
---

## Architecture

VPS: `ssh qbg-hq` (root@5.161.107.142), CPX41 (8vCPU/16GB), Fedora 43
Base path: `/opt/nexusos/`

```
/opt/nexusos/
├── config.yaml                    # Single source of truth for all persona config
├── radicale/config/               # CalDAV server config
├── shared/inbox/{persona}/        # Async inter-persona messages
├── shared/memory/                 # Shared memory (all personas read/write)
├── shared/artifacts/              # Git-versioned collaborative docs
├── personas/
│   ├── shared/
│   │   ├── common.py              # load_persona(), build_system_prompt(), spawn_sdk()
│   │   ├── commentary.py          # Commentary daemon (Gaussian wake intervals)
│   │   ├── listener.py            # Always-on Matrix listener (nio sync)
│   │   ├── schedule.py            # Sleep/wake state management
│   │   ├── concepts.py            # #hashtag concept tagging (SQLite)
│   │   ├── nicknames.py           # Runtime nickname CRUD
│   │   ├── calendar_client.py     # CalDAV client (Radicale)
│   │   ├── email_client.py        # SMTP/IMAP client (Stalwart)
│   │   ├── calendar_notifier.py   # Event reminder daemon (60s polling)
│   │   ├── prompts/base.md        # Shared behavioral rules ({{VAR}} substitution)
│   │   └── mcp/
│   │       ├── matrix_server.py   # FastMCP server (40 tools)
│   │       └── config-{persona}.json
│   └── {joshua,uzay,kevinster,dwangster}/
│       ├── credentials/           # Matrix token, email.json
│       ├── prompts/system.md      # Persona-specific identity prompt (~30 lines)
│       ├── memory/                # diary.md, people.md, threads.md, interests.md
│       ├── state/                 # nicknames.json, schedule.json
│       └── logs/
```

## Personas

| Name | Matrix ID | Display | Output Room | Default Aliases |
|------|-----------|---------|-------------|-----------------|
| joshua | @joshua:footemp.bar | JWYenster | jwyen | josh |
| uzay | @uzay:footemp.bar | uzpgster | uzay | uz |
| kevinster | @kevinster:footemp.bar | kevinster | kevinster | kevin |
| dwangster | @dwangster:footemp.bar | dwangster | dwangster | dwang |

Personas can also add runtime nicknames via `nickname_add()` MCP tool, stored in `state/nicknames.json`.

## Services (systemd)

Each persona has two services (NOT timers — they're long-running daemons):
- **Commentary** (`persona-{name}-commentary`): Gaussian-interval wake loop, spawns SDK when interesting
- **Listener** (`persona-{name}-listener`): Always-on, responds to @mentions and replies

Infrastructure services:
- `nexusos-radicale` — CalDAV server (localhost:5232)
- `nexusos-calendar-notifier` — Event reminder polling
- `stalwart-mail` — SMTP/IMAP mail server

```bash
# Status overview
ssh qbg-hq 'systemctl is-active persona-joshua-listener persona-joshua-commentary persona-uzay-listener persona-uzay-commentary persona-kevinster-listener persona-kevinster-commentary persona-dwangster-listener persona-dwangster-commentary'

# Restart a persona (both services)
ssh qbg-hq 'systemctl restart persona-joshua-listener persona-joshua-commentary'

# View recent logs
ssh qbg-hq 'journalctl -u persona-joshua-commentary --since "1h ago" --no-pager | tail -40'
ssh qbg-hq 'journalctl -u persona-joshua-listener --since "1h ago" --no-pager | tail -40'
```

## Config

Single file: `/opt/nexusos/config.yaml` (NOT per-persona config.json files).

```bash
ssh qbg-hq 'cat /opt/nexusos/config.yaml'
```

## Common Operations

### View persona memory
```bash
ssh qbg-hq 'cat /opt/nexusos/personas/joshua/memory/diary.md'
ssh qbg-hq 'ls /opt/nexusos/personas/uzay/memory/'
```

### View/edit system prompts
```bash
ssh qbg-hq 'cat /opt/nexusos/personas/dwangster/prompts/system.md'  # persona-specific
ssh qbg-hq 'cat /opt/nexusos/personas/shared/prompts/base.md'       # shared
```

### Post to #update-log
```bash
nexus-qbg-zhu send -r "update-log" "**Feature Name** — description"
```

### Check MCP tools
```bash
ssh qbg-hq "grep 'async def' /opt/nexusos/personas/shared/mcp/matrix_server.py | grep -v '^ '"
```

### Check schedule state
```bash
ssh qbg-hq 'cat /opt/nexusos/personas/joshua/state/schedule.json 2>/dev/null'
```

### Check nicknames
```bash
ssh qbg-hq 'cat /opt/nexusos/personas/joshua/state/nicknames.json'
```

## Rooms

| Room | Purpose |
|------|---------|
| General | Main discussion |
| Features Requests! | Feature requests & NexusOS dev ideas |
| Update Log | System update announcements |
| Todo | Task tracking |
| RAG | RAG pipeline discussion |
| Baozheng | Baozheng client discussion |
| Ranger | Ranger project |

## Debugging

```bash
# Check if SDK processes are stuck
ssh qbg-hq 'ps aux | grep claude'

# Memory usage
ssh qbg-hq 'free -h'

# Full service status
ssh qbg-hq 'systemctl status persona-joshua-listener'

# Check for errors across all services
ssh qbg-hq 'journalctl -u "persona-*" --since "30min ago" --no-pager | grep -i error | tail -20'
```

## Adding a New Persona

1. Register Matrix account on footemp.bar
2. Add entry to `/opt/nexusos/config.yaml`
3. Create directory structure under `/opt/nexusos/personas/{name}/`
4. Write `prompts/system.md` (identity/voice only)
5. Copy credentials (Matrix token, email.json)
6. Create MCP config at `shared/mcp/config-{name}.json`
7. Create systemd units (`persona-{name}-commentary.service`, `persona-{name}-listener.service`)
8. `systemctl daemon-reload && systemctl enable --now persona-{name}-commentary persona-{name}-listener`
9. Join the account to standard rooms
10. Create output room
11. Set up local credentials at `~/.nexus-{name}/` and wrapper at `~/bin/nexus-{name}`
12. Create email account in Stalwart, calendar in Radicale
13. Update `~/.claude/CLAUDE.md` nexus section
