# claude-fleet

Persistent, parallel AI agents on Claude Code.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/qbg-dev/claude-fleet/main/install.sh | bash
```

This runs `fleet onboard` — an interactive agent that sets up your infrastructure, designs your fleet, writes worker missions, configures safety hooks, and verifies everything works. It's the only entry point you need.

Everything you need to know about the fleet, ask the onboard agent.

## After onboarding

```bash
fleet create my-worker "Fix the login bug"
fleet ls
fleet stop my-worker
fleet start my-worker
fleet log my-worker
fleet mail my-worker
```

## Requirements

Claude Code, Bun, tmux, git.

## License

Apache 2.0
