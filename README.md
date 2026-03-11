# claude-fleet

Persistent, parallel AI agents on Claude Code.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/qbg-dev/claude-fleet/main/install.sh | bash
fleet setup
fleet onboard
```

`fleet onboard` launches an interactive agent that walks you through everything: project setup, worker design, safety hooks, mail, watchdog, and verification. Ask it anything about the fleet.

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
