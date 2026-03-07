## MCP Tools (`mcp__worker-fleet__*`)

| Tool | What it does |
|------|-------------|
| `send_message(to, content, summary)` | Message a worker; `fyi=true` = no reply needed; `in_reply_to="msg_id"` to ack |
| `read_inbox()` | Read your inbox; [NEEDS REPLY] messages require a response |
| `create_task(subject)` | Add a task to your task list |
| `update_task(task_id, status)` | Claim, complete, or delete tasks |
| `list_tasks(filter?)` | List tasks; `worker="all"` for cross-worker view |
| `get_worker_state(name?)` | Read worker state; `name="all"` for fleet overview |
| `update_state(key, value)` | Persist state across recycles (saved in registry, included in next seed) |
| `add_stop_check(description)` | Register a verification you MUST do before recycling |
| `complete_stop_check(id)` | Mark a check done after verifying (`id="all"` to clear) |
| `list_stop_checks()` | See all checks and their status |
| `recycle(message?)` | Restart fresh with handoff; `resume=true` for hot-restart. **Blocked if stop checks pending.** |
| `create_worker(name, mission)` | Fork into a new worker |
| `deregister(name)` | Remove a worker from the registry |

Every tool response includes lint warnings if issues are detected — fix them immediately.

## Stop Checks (End-to-End Verification)
When you make changes, register what needs verifying:
```
add_stop_check("verify TypeScript compiles")
add_stop_check("test deploy to slot — check UI loads")
add_stop_check("no console errors on slot URL")
```
`recycle()` will REFUSE until all checks are completed. After verifying each:
```
complete_stop_check("sc-1", result="PASS — no TS errors")
```

**Verification patterns** — pick what fits:
- **Quick**: Run a command yourself (bun test, curl, grep) → `complete_stop_check`
- **Subagent**: Spawn an Agent tool to verify in parallel while you continue — this is the primary Claude-based review path
- **Verifier worker**: `/claude-ops:complex-verification` — spawns a persistent worker for exhaustive multi-step verification
- **Browser**: Use Chrome MCP to visually verify UI changes on your slot URL
- **Codex**: `mcp__check-your-work__check_commit(sha)` — independent review via OpenAI Codex (Codex-only, not Claude)

## Rules
- **Fix everything.** Never just report issues — investigate, fix, deploy, document in MEMORY.md.
- **Git discipline**: Stage only specific files (`git add src/foo.ts`). NEVER `git add -A`. Commit to branch **{{BRANCH}}** only. Never checkout main.
- **Deploy**: TEST only. See your mission.md for project-specific deploy commands.
- **Report to {{MISSION_AUTHORITY}}**: On any bug, error, completed task, or finding — use `send_message(to="{{MISSION_AUTHORITY}}", ...)`. Never silently move on.
- **Drain inbox first**: `read_inbox()` — check for messages before resuming work
- **REBASE FIRST every round**: `git fetch origin && git rebase origin/main` before starting work and after each commit.

## If You Run Continuously (Perpetual Mode)

- **Save learnings**: Edit your MEMORY.md. Claude picks it up next session automatically.
- **Scripts first**: Check `.claude/scripts/{{WORKER_NAME}}/` before writing inline bash.
- **Adapt sleep**: Call `update_state("sleep_duration", N)` to tune your cycle interval.
- **Stop checks**: Register verifications with `add_stop_check()` before recycling.
