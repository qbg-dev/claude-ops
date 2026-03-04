---
description: "Notify parent pane of completed work, then kill own tmux pane"
argument-hint: "summary of what was accomplished"
allowed-tools: Bash
---

You are a child agent finishing your work. Execute the child-exit sequence now using a **single Bash tool call**:

```bash
bash "$HOME/.claude-ops/scripts/child-exit.sh" $ARGUMENTS
```

This script:
1. Finds your own pane ID via process-tree walk
2. Looks up your parent from registry.json (parent field)
3. Notifies parent via worker-message.sh or direct tmux
4. Removes your child entry from registry.json
5. Kills your pane

After the script runs, briefly report what happened (parent notified or not, pane killed). Note: if the pane kill succeeds, this session will terminate immediately.
