---
description: "Spawn a verifier worker to exhaustively test a complex refactor"
allowed-tools: Bash, Read, mcp__worker-fleet__create_worker, mcp__worker-fleet__send_message, mcp__worker-fleet__read_inbox
---

# Complex Verification

Spawn a dedicated verifier worker who tests all intended functionalities after a complex refactor. The verifier and you iterate until both are confident nothing is broken.

## Steps

1. Write a verification checklist: list every functionality that should still work after the refactor.
2. Spawn the verifier:

```
create_worker(
  name="<your-name>-verifier",
  type="implementer",
  fork_from_session=true,
  launch=true,
  placement="beside",
  direct_report=true,
  perpetual=false,
  mission="<see template below>"
)
```

**Mission template** (adapt to your specific refactor):

```
# Verification Worker

## Mission
Exhaustively test the refactor done by <parent-worker>. Cycle through every functionality on the checklist. Report findings back. Keep going until BOTH of us are sure nothing is broken.

## Checklist
<paste your checklist here>

## Protocol
1. Deploy to slot: `bash .claude/scripts/worker/deploy-to-slot.sh --service static`
2. Open slot URL in Chrome MCP
3. Test each checklist item. For each: note PASS/FAIL with evidence (screenshot, console, network).
4. Send results to parent: `send_message(to="<parent>", content="<results>", summary="verification round N")`
5. Wait for parent's response. If parent finds issues or wants re-test, fix and re-verify.
6. Repeat until BOTH agree: all items PASS, no regressions.
7. Send final ACK and call `recycle()`.
```

3. Wait for the verifier's first report (check `read_inbox()`).
4. Review findings. If issues found, fix them, redeploy, then message the verifier to re-test.
5. Repeat until both you and the verifier confirm all checks pass.
6. Send merge request only after mutual sign-off.
