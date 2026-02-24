# Beads: Cross-Harness Coordination

Multiple autonomous harnesses (overnight, tianding, optimize, uifix) can run concurrently on the same codebase. They share no memory, but they share files. Beads solves the coordination problem with three primitives stored in a single JSON file.

## State File

`claude_files/harness-beads.json`:

```json
{
  "wisps": [],
  "claims": {},
  "gates": {}
}
```

Auto-initialized by the CLI if missing. All commands use atomic read-modify-write via `jq` + `mktemp` + `mv`.

## The Three Primitives

### 1. Wisps -- Ephemeral Messages

Short-lived messages between harnesses. Auto-expire after 24 hours. Tracked as read/unread.

```json
{
  "id": "w-a3f1",
  "from": "optimize",
  "to": "tianding",
  "msg": "I refactored helpers.ts -- your import paths may need updating",
  "ts": "2026-02-21T03:45:00Z",
  "expires": 1740200700,
  "read": false
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | `w-xxxx` | 4 hex chars from `/dev/urandom` |
| `from` | string | Sending harness name |
| `to` | string | Target harness or `"all"` |
| `expires` | epoch int | `now + 86400` (24h TTL) |
| `read` | bool | Flipped by `ack` command |

### 2. Claims -- File-Level Locks

Advisory locks on file paths. Prevents two harnesses from editing the same file. 24-hour TTL.

```json
{
  "src/admin/routes/miniapp-routes.ts": {
    "by": "tianding",
    "reason": "adding billing endpoint",
    "ts": "2026-02-21T03:45:00Z",
    "expires": 1740200700
  }
}
```

Key is the file path. If a second harness tries to claim an already-claimed file, the CLI prints a `WARNING` and overrides (last-write-wins). The stop hook surfaces foreign claims as "do NOT edit" warnings.

### 3. Gates -- Named Blockers

Named barriers that block operations until explicitly removed. No TTL -- must be manually ungated.

```json
{
  "deploy-prod": {
    "by": "optimize",
    "reason": "running perf benchmark, don't deploy mid-test",
    "ts": "2026-02-21T03:45:00Z"
  }
}
```

Gates are the strongest primitive. Unlike wisps (informational) and claims (advisory), gates signal "stop what you're doing until I clear this."

## CLI Reference

All commands: `bash .claude/scripts/harness-bead.sh <command> [args]`

### Wisps

```bash
# Send a wisp to a specific harness
bash .claude/scripts/harness-bead.sh wisp optimize "refactored helpers.ts imports" tianding

# Broadcast to all harnesses
bash .claude/scripts/harness-bead.sh wisp optimize "deploying to prod in 2 min"

# List unread wisps (all)
bash .claude/scripts/harness-bead.sh wisps

# List unread wisps for a specific harness
bash .claude/scripts/harness-bead.sh wisps tianding

# Acknowledge one wisp
bash .claude/scripts/harness-bead.sh ack w-a3f1

# Acknowledge all wisps
bash .claude/scripts/harness-bead.sh ack all
```

### Claims

```bash
# Claim a file (reason defaults to "editing" if omitted)
bash .claude/scripts/harness-bead.sh claim src/server.ts tianding "adding route registration"

# Check if a file is claimed
bash .claude/scripts/harness-bead.sh check src/server.ts
# Output: "CLAIMED by tianding: adding route registration" or "FREE"

# List all active claims
bash .claude/scripts/harness-bead.sh claims

# Release a claim
bash .claude/scripts/harness-bead.sh release src/server.ts
```

### Gates

```bash
# Set a gate
bash .claude/scripts/harness-bead.sh gate deploy-prod optimize "running perf benchmark"

# List active gates
bash .claude/scripts/harness-bead.sh gates

# Remove a gate
bash .claude/scripts/harness-bead.sh ungate deploy-prod
```

### Utility

```bash
# Full status (wisps + claims + gates)
bash .claude/scripts/harness-bead.sh status

# Garbage collect expired wisps and claims
bash .claude/scripts/harness-bead.sh gc
```

## Integration with Stop Hooks

The dispatch hook (`harness-dispatch.sh`) calls `beads_section()` for each harness. This function reads `harness-beads.json` and formats three sections into the stop hook message:

```bash
beads_section() {
  local my_harness="$1"
  # 1. Unread wisps addressed to this harness (or "all")
  #    Filtered: .read == false, not expired, .to matches
  #    Output: "**Wisps (unread):**\n  w-a3f1 [optimize] refactored helpers.ts"

  # 2. Active claims by OTHER harnesses (warn: don't touch)
  #    Filtered: not expired, .by != my_harness
  #    Output: "**Claimed files (do NOT edit):**\n  src/server.ts -- by tianding: adding route"

  # 3. Active gates set by OTHER harnesses
  #    Filtered: .by != my_harness
  #    Output: "**Gates (blocked):**\n  deploy-prod -- by optimize: running benchmark"
}
```

The stop hook also appends a one-liner cheat sheet:

```
**Beads commands:** bash .claude/scripts/harness-bead.sh wisp tianding "msg" | claim <file> tianding | gate <name> tianding "reason"
```

This means Claude sees beads state every time it tries to stop, and can react -- acknowledge wisps, avoid claimed files, or wait for gates to clear.

## Garbage Collection

GC runs automatically on every stop hook invocation (in `harness-dispatch.sh`):

```bash
jq --argjson now "$NOW" '
  .wisps |= [.[] | select(.expires > $now and .read == false)] |
  .claims |= with_entries(select(.value.expires > $now))
' "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"
```

This removes:
- **Wisps**: expired OR already read
- **Claims**: expired (past 24h TTL)
- **Gates**: never auto-removed (no TTL by design)

Manual GC: `bash .claude/scripts/harness-bead.sh gc` -- same logic, but also prints before/after counts.

## When to Use Each Primitive

| Scenario | Primitive | Example |
|---|---|---|
| FYI about a change | Wisp | "I renamed `getUser` to `resolveUser` in helpers.ts" |
| Working on a shared file | Claim | `claim src/server.ts tianding "adding route"` |
| Don't deploy right now | Gate | `gate deploy-prod optimize "benchmark running"` |
| Dependency not ready yet | Gate | `gate miniapp-billing tianding "endpoint not deployed"` |
| Heads-up before deploy | Wisp (broadcast) | `wisp optimize "deploying to prod in 2 min"` |
| Need another harness to do something | Wisp (targeted) | `wisp tianding "please add billing tool to tools.json" optimize` |

**Rule of thumb:**
- Wisp = "you should know this" (informational, no enforcement)
- Claim = "I'm editing this file" (advisory, shown as warning)
- Gate = "don't do this yet" (blocking, must be explicitly cleared)

## Example: Two Harnesses Coordinating

The `tianding` harness is building a billing feature. The `optimize` harness is running perf benchmarks.

```bash
# tianding claims the route file it's modifying
bash .claude/scripts/harness-bead.sh claim src/admin/routes/miniapp-routes.ts tianding "adding billing endpoint"

# tianding gates deploy so optimize doesn't deploy mid-feature
bash .claude/scripts/harness-bead.sh gate deploy-prod tianding "billing endpoint incomplete"

# optimize tries to stop -- stop hook shows:
#   **Claimed files (do NOT edit):**
#     src/admin/routes/miniapp-routes.ts -- by tianding: adding billing endpoint
#   **Gates (blocked):**
#     deploy-prod -- by tianding: billing endpoint incomplete

# optimize sends a wisp asking about timeline
bash .claude/scripts/harness-bead.sh wisp optimize "when will billing endpoint be done? I need to deploy" tianding

# tianding's next stop hook shows:
#   **Wisps (unread):**
#     w-b2c4 [optimize] when will billing endpoint be done? I need to deploy

# tianding finishes, cleans up
bash .claude/scripts/harness-bead.sh release src/admin/routes/miniapp-routes.ts
bash .claude/scripts/harness-bead.sh ungate deploy-prod
bash .claude/scripts/harness-bead.sh wisp tianding "billing endpoint done, deploy is clear" optimize
bash .claude/scripts/harness-bead.sh ack all

# optimize's next stop hook shows:
#   **Wisps (unread):**
#     w-c3d5 [tianding] billing endpoint done, deploy is clear
# No more claims or gates -- optimize proceeds with deploy
```
