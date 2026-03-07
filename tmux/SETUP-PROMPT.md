# tmux Setup — Claude Walkthrough Prompt

When a user runs `bash ~/.claude-ops/tmux/setup-tmux.sh` interactively
(no flags), or when Claude detects they're not in tmux, use this guide.

## Detection Flow

1. Run `bash ~/.claude-ops/tmux/setup-tmux.sh --check` to get the environment
   and merge plan.

2. Based on the output:

   **Not in tmux + no tmux installed:**
   - Help install tmux (`brew install tmux` on macOS, `apt install tmux` on Linux)
   - Run `--guide` to walk them through basics
   - Then proceed with setup

   **Not in tmux + tmux installed:**
   - Explain: "You're not in a tmux session. claude-ops works best inside tmux
     because agents run in separate panes that persist across disconnections."
   - Offer: "Want me to walk you through tmux basics? Or if you're familiar,
     just run `tmux new -s dev` and we'll set up the bindings."
   - Apply setup with `--auto`

   **In tmux + no existing config:**
   - Apply with `--auto` (creates a new config)
   - Show key bindings summary

   **In tmux + existing config + no conflicts:**
   - Show the merge plan
   - Apply with `--auto`
   - Reload with `tmux source-file ~/.tmux.conf`

   **In tmux + existing config + conflicts:**
   - Show the merge plan, explain each conflict
   - Explain: "Your existing bindings take priority. The claude-ops bindings
     are loaded after yours, so if both define prefix+h, yours wins."
   - Explain which claude-ops features might be missing due to conflicts
   - Suggest alternative keys for conflicting ops bindings
   - Apply with `--auto` (source-file at end = user wins)

## Key Binding Explanations (for conflicts)

When explaining why a binding exists:

| Key | Why |
|-----|-----|
| y/Y | Resume/fork Claude sessions — fundamental to agent workflow |
| X | One-keypress fork — the fastest way to spin up a sibling agent |
| a | Cycle active workers — skip idle panes when monitoring agents |
| i | Harness popup — at-a-glance fleet status |
| P | Copy pane target — used by monitor-agent and fleet tools |
| b | Move to background — declutter your workspace |
| S | Sync panes — type in all panes at once for fleet ops |
| h/j/k/l | Vim pane nav — essential with 5-10 agent panes |
| n/N | Zoom-preserving cycle — monitor agents without leaving zoom |
| v/s | Splits preserving cwd — new panes start in project dir |
| T | Tiled layout — evenly arrange all agent panes |
| K | Kill with re-zoom — clean pane removal without layout disruption |

## Merge Strategy

- **User bindings always win** for the key they occupy
- **All functionality must be present** — if a conflict removes an ops feature,
  suggest an alternative key
- The source-file line goes at the END of .tmux.conf so user bindings
  (loaded first) override ops bindings (loaded second)
- Settings (non-bindings like mouse, history-limit) are applied by claude-ops
  and override user settings — these are required for the system to work
