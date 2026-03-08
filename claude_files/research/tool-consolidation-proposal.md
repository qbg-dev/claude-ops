# Worker Fleet MCP — Tool Consolidation Proposal

## Current State: 22 Tools

| # | Tool | Frequency | Category |
|---|------|-----------|----------|
| 1 | `mail_send` | HIGH | Mail |
| 2 | `mail_inbox` | HIGH | Mail |
| 3 | `mail_read` | HIGH | Mail |
| 4 | `mail_search` | LOW | Mail |
| 5 | `mail_thread` | LOW | Mail |
| 6 | `mail_help` | LOW | Mail |
| 7 | `create_task` | MED | Tasks |
| 8 | `update_task` | MED | Tasks |
| 9 | `list_tasks` | HIGH | Tasks |
| 10 | `get_worker_state` | HIGH | State |
| 11 | `update_state` | MED | State |
| 12 | `add_stop_check` | HIGH | Verification |
| 13 | `complete_stop_check` | HIGH | Verification |
| 14 | `list_stop_checks` | LOW | Verification |
| 15 | `recycle` | HIGH | Lifecycle |
| 16 | `create_worker` | LOW | Fleet mgmt |
| 17 | `get_worker_template` | LOW | Fleet mgmt |
| 18 | `move_window` | LOW | Fleet mgmt |
| 19 | `standby` | LOW | Fleet mgmt |
| 20 | `register` | LOW | Fleet mgmt |
| 21 | `deregister` | LOW | Fleet mgmt |
| 22 | `deep_review` | LOW | Review |

## Problem

22 tools is a lot of context for the LLM to hold. Most workers use 6-8 tools per cycle. The rest are rare operations that bloat the tool list and confuse the model about what to call when.

## Design: The `mail_help()` Pattern

`mail_help()` is the model: a single tool that returns CLI documentation. Workers use the docs to construct raw API calls for uncommon operations, instead of needing a dedicated tool per operation.

Apply this pattern to reduce tools from **22 → ~10**.

## Proposed: 10 Core Tools

### Keep as standalone (high-frequency, critical path)

| Tool | Why standalone |
|------|---------------|
| `mail_send` | Every cycle, core communication |
| `mail_inbox` | Every cycle, drain messages first |
| `mail_read` | Read full message bodies |
| `recycle` | Critical lifecycle, stop-check gated |
| `get_worker_state` | Fleet awareness, every cycle |
| `update_state` | Persist state across recycles |
| `add_stop_check` | Gate recycle with verification |
| `complete_stop_check` | Clear verification gates |
| `deep_review` | Complex enough to be standalone |

### Consolidate into help+subcommand tools

**`task(action, ...params)`** — replaces `create_task`, `update_task`, `list_tasks`
```
action: "create" | "update" | "list"
# create: subject, priority, blocked_by
# update: task_id, status
# list: filter, worker
```

**`fleet(action, ...params)`** — replaces `create_worker`, `register`, `deregister`, `move_window`, `standby`, `get_worker_template`
```
action: "create" | "register" | "deregister" | "move" | "standby" | "template" | "help"
# help: returns full CLI docs for all fleet operations
```

### Absorbed into existing tools

| Removed | Absorbed into |
|---------|---------------|
| `list_stop_checks` | Output included in `recycle()` response when blocked |
| `mail_search` | Documented in `mail_help()` with curl examples |
| `mail_thread` | Documented in `mail_help()` with curl examples |
| `mail_help` | Stays (it IS the help pattern) |

## Result: 22 → 12 tools

| Category | Before | After |
|----------|--------|-------|
| Mail | 6 | 4 (send, inbox, read, help) |
| Tasks | 3 | 1 (task) |
| State | 2 | 2 (get_worker_state, update_state) |
| Verification | 3 | 2 (add_stop_check, complete_stop_check) |
| Lifecycle | 1 | 1 (recycle) |
| Fleet mgmt | 6 | 1 (fleet) |
| Review | 1 | 1 (deep_review) |
| **Total** | **22** | **12** |

## Alternative: Aggressive consolidation (22 → 7)

Could go further by merging state into fleet, and stop_checks into recycle:

1. `mail_send` — send
2. `mail_inbox` — read
3. `mail_read` — full message
4. `mail_help` — docs
5. `task` — create/update/list
6. `fleet` — state/create/register/deregister/move/standby/template/stop_check/help
7. `recycle` — restart (with stop_check info in response)

But this risks making `fleet` too overloaded. The 12-tool version is a better balance.

## Seed Template Update

After consolidation, update `seed-context.md` to show only the final tool list. The `fleet(action="help")` and `mail_help()` calls replace the big tool tables.
