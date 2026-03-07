---
description: "Put a worker on standby (pause its perpetual cycle)"
allowed-tools: Bash, mcp__worker-fleet__get_worker_state, mcp__worker-fleet__standby, mcp__worker-fleet__send_message
---

# Standby Worker

Toggle a worker between active and standby. Standby workers are not respawned by the watchdog.

## Usage

`/standby [worker-name]`

If no worker name is given, ask which worker to standby.

## Steps

1. If `$ARGUMENTS` is empty, run `get_worker_state(name="all")` and show active workers, then ask which one to standby.
2. Call `standby()` for the target worker. If you ARE the target worker, call it on yourself. If targeting a DIFFERENT worker, send them a message: `send_message(to="<worker>", content="Warren wants you on standby. Call standby() now.", summary="standby request")`.
3. Confirm the status change.
