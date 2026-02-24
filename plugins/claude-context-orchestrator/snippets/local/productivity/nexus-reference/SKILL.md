---
name: "NexusOS Full Reference"
description: "Complete NexusOS/Matrix CLI reference: messaging commands, knowledge pipeline, API endpoints, server operations, CLI maintenance, database, Google Drive mount, disk checks."
---

# NexusOS Full Reference

NexusOS messaging (Matrix-based, footemp.bar). Matt's team chat server.
User: `@warren:footemp.bar` | Also on server: `@matt`, `@mattk`, `@nexus` (bot)
Credentials: `~/.nexus/credentials` (JSON) + `~/.nexus-token` (bare token for CLI)

## CLI -- Messaging

Commands:
  - `nexus send "msg"` -- send to #general (default)
  - `nexus send -r features "msg"` -- send to specific room
  - `nexus send -e` -- compose in editor (server version only)
  - `nexus fetch [-r room] [-n count]` -- read recent messages (server version only)
  - `nexus upload [-r room] file.pdf` -- upload file + post link
  - `nexus rooms` -- list joined rooms
  - `echo "piped" | nexus send` -- pipe stdin

Rooms: `general`, `features`, `yc-application`, `ranger`, `rag`, `Random`, `Baozheng` + DM with Matt
**Ranger room rule**: When sending to `-r ranger`, always append `\n\n-- Sent from Joshua` to the message.

## CLI -- Knowledge Pipeline

Indexes all Matrix rooms + DingTalk chats into searchable, structured summaries. Two-worker pipeline: light (polls every 2 min) -> `knowledge_queue`, heavy (every 6 hrs) -> Claude Haiku summarization -> `knowledge_docs` + FTS5 index.

Commands:
  - `nexus index` -- list all indexed sources with message count, size, last update
  - `nexus search "query"` -- full-text search across all knowledge (`-n limit`)
  - `nexus digest -r General` -- on-demand LLM summary of a Matrix room
  - `nexus digest -d "2026 AI大管家"` -- on-demand LLM summary of a DingTalk chat
  - `nexus digest -r General --since 2d` -- summary of last N days only

12 sources indexed: Matrix (General, Features, RAG, Baozheng) + DingTalk (AI大管家, 保臻社区, Notice, AI财务助手, AI助理, Email Assistant, Matt DM, org Invitation)

**For agents:** search indexed knowledge first (`nexus search`) before fetching raw messages--avoids pulling thousands of messages.

## API (for curl/scripts)

```bash
# Send
curl -s https://footemp.bar/api/send -H "Authorization: Bearer $(cat ~/.nexus-token)" -H "Content-Type: application/json" -d '{"room":"ROOM","text":"MSG"}'

# List rooms
curl -s https://footemp.bar/api/rooms/joined -H "Authorization: Bearer $(cat ~/.nexus-token)"

# Read messages (Matrix sync API)
curl -s "https://footemp.bar/_matrix/client/v3/sync?timeout=0" -H "Authorization: Bearer $(cat ~/.nexus-token)"

# Cross-channel search
curl -s https://footemp.bar/_matrix/client/v3/search -X POST -H "Authorization: Bearer $(cat ~/.nexus-token)" -H "Content-Type: application/json" -d '{"search_categories":{"room_events":{"search_term":"QUERY","limit":20}}}'

# Knowledge search
# GET /api/knowledge/search?q=QUERY&limit=10

# Knowledge index
# GET /api/knowledge/index

# Knowledge digest (existing)
# GET /api/knowledge/digest?source=NAME

# Knowledge digest (generate)
# POST /api/knowledge/digest body: {"source":"NAME","source_type":"room|dingtalk","since":"2d"}
```

All knowledge API endpoints require auth (Matrix token or `DASHBOARD_TOKEN`).

Room resolution: short name ("general") -> alias (#general:footemp.bar) -> room ID.
Env vars: `NEXUS_TOKEN`, `NEXUS_ROOM` (default: general), `NEXUS_HOST` (default: https://footemp.bar)

## CLI Update & Maintenance

Local CLI: `~/bin/nexus` (bash script, 268 lines)
Server CLI: `/usr/local/bin/nexus` on `footemp.bar` (canonical, maintained by Matt)
TS source: `/opt/nexusos/packages/bot/src/cli.ts` (interactive TUI version, not the bash CLI)

The local and server bash CLIs have **diverged**. Server has features local doesn't, and vice versa.

**Server-only features** (not in local): `fetch` command (read recent messages), `-e`/`--editor` flag for `send`, `fzf` room/file pickers (interactive mode), HTML-formatted upload links.
**Local-only features** (not on server): `search -n`/`--limit` flag, nicer `index` formatting.

**To update local from server:**
```bash
cp ~/bin/nexus ~/bin/nexus.bak
scp root@footemp.bar:/usr/local/bin/nexus ~/bin/nexus
```

**To push local to server:**
```bash
scp ~/bin/nexus root@footemp.bar:/usr/local/bin/nexus
```

**To check diff:**
```bash
diff <(cat ~/bin/nexus) <(ssh root@footemp.bar "cat /usr/local/bin/nexus")
```

## Server Operations

**Service management:**
```bash
ssh root@footemp.bar "systemctl status nexusos-bot"       # status
ssh root@footemp.bar "systemctl restart nexusos-bot"       # restart bot
ssh root@footemp.bar "journalctl -u nexusos-bot -n 50"    # recent logs
ssh root@footemp.bar "journalctl -u nexusos-bot -f"       # follow logs
ssh root@footemp.bar "systemctl status caddy"              # reverse proxy
```

**Bot source (deploy changes):**
```bash
ssh root@footemp.bar "cd /opt/nexusos && git pull"         # pull latest
ssh root@footemp.bar "cd /opt/nexusos && bun install"      # install deps
ssh root@footemp.bar "systemctl restart nexusos-bot"       # apply
```

**Knowledge pipeline operations:**
```bash
# Trigger light worker (polls new messages into knowledge_queue)
curl -s -X POST https://footemp.bar/api/knowledge/poll -H "Authorization: Bearer $(cat ~/.nexus-token)"
# Trigger heavy worker (summarizes queued messages via Claude Haiku)
curl -s -X POST https://footemp.bar/api/knowledge/compact -H "Authorization: Bearer $(cat ~/.nexus-token)"
```

**Database (SQLite on server):**
```bash
ssh root@footemp.bar "sqlite3 /opt/nexusos/data/nexus.db '.tables'"
ssh root@footemp.bar "sqlite3 /opt/nexusos/data/nexus.db 'SELECT source, message_count FROM knowledge_docs'"
```

**Google Drive mount:**
```bash
ssh root@footemp.bar "ls /root/drive/"                     # browse shared files
ssh root@footemp.bar "systemctl status drive-fuse"         # check mount
ssh root@footemp.bar "systemctl restart drive-fuse"        # remount if stale
```

**Disk/memory check** (server is 2GB RAM, 38GB disk--can be tight):
```bash
ssh root@footemp.bar "df -h / && free -h"
```
