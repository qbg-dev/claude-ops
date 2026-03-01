# {{WORKER_NAME}} — {{DESCRIPTION}}

## Mission
{{MISSION_DETAIL}}

## Issue Backlog
<!-- List issues this worker should fix, with severity and root cause analysis -->

## Perpetual Loop Protocol

```
LOOP FOREVER:
  1. Test each issue above
  2. For PARTIAL/FAIL items: investigate root cause -> fix -> deploy -> verify
  3. Update state.json + MEMORY.md with results
  4. Graceful stop — watchdog respawns after sleep_duration seconds
```

**NEVER set status="done".** This worker runs until killed.

## Respawn Configuration

Set in `state.json` before first cycle. The watchdog reads these on every check:

| Field | Type | Description |
|-------|------|-------------|
| `perpetual` | bool | `true` = watchdog respawns after sleep; `false` = one-shot, never respawned |
| `sleep_duration` | int | Seconds to wait before respawn (only when `perpetual: true`) |

Suggested cadences:
- Urgent/monitoring workers: `1800` (30 min)
- Active development workers: `3600`–`7200` (1–2h)
- Optimization/review workers: `10800`–`14400` (3–4h)
- One-shot workers: `"perpetual": false` (no `sleep_duration` needed)

## Credentials
<!-- Add project-specific credentials here -->

## Key Source Files
<!-- Map the files this worker needs to understand -->

## Deploy Protocol

```bash
# Backend changes
./scripts/deploy.sh --skip-langfuse --service web
# UI-only changes
./scripts/deploy.sh --skip-langfuse --service static
# Prod (after test verification)
echo y | ./scripts/deploy-prod.sh --skip-langfuse --service <static|web>
```
