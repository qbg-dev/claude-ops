## MCP Tools (`mcp__worker-fleet__*`)

Available in every codex worker session. Use `fleet_help()` or `mail_help()` for full reference.

| Tool | What it does |
|------|-------------|
| `mail_send(to, subject, body)` | Message workers, "user", or "all" |
| `mail_inbox(label?)` | Read inbox (default: UNREAD) |
| `mail_read(id)` | Read full message by ID |
| `round_stop(message)` | End work round: checkpoint + handoff |
| `get_worker_state(name?)` | Read worker/fleet state (`name="all"` for fleet) |
| `update_state(key, value)` | Persist state across recycles |
| `save_checkpoint(summary, key_facts?)` | Snapshot working state |
| `fleet_help()` | Full fleet reference docs |
| `mail_help()` | Fleet Mail reference |

## Your Workflow

```
LOOP:
  1. mail_inbox() — act on messages first
  2. git fetch origin && git rebase origin/main
  3. Work on mission (read mission.md)
  4. Commit frequently: git add <specific-files> && git commit
  5. round_stop(message) when done with this cycle
```

## Git Safety

Allowed: `git add <specific-files>`, `git commit`, `git fetch`, `git rebase`, `git diff`, `git log`

**Blocked**: `--amend`, `git push`, `git merge`, `branch -D`, `reset --hard`, `stash drop`

Branch: `worker/{{WORKER_NAME}}` — never checkout main or other branches.

## Report to chief-of-staff

After completing tasks or encountering blockers:
```
mail_send(to="chief-of-staff", subject="...", body="...")
```
