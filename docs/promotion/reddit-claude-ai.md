# r/ClaudeAI Post Draft

**Title**: I built an agent harness on Claude Code's native hooks — persistent tasks, crash recovery, multi-agent coordination

---

I've been using Claude Code for long autonomous tasks and kept wanting something that would let agents keep working across sessions without me babysitting them. Built this: **claude-ops**.

The core idea is simple: Claude Code's **Stop hook** fires every time Claude tries to end a session. If you tell it "don't stop until these tasks are done," the agent just... doesn't stop. It reads the hook output as context and keeps working. That's the whole loop—no polling, no external scheduler.

**What it does:**

Four Claude Code hooks wire everything together:
- **Stop hook**: blocks the session if tasks remain in `tasks.json`; lets it end when done
- **PreToolUse hook**: injects context from other agents (inbox messages, policy rules) before each tool call
- **PostToolUse hook**: logs every tool call to an event bus
- **UserPromptSubmit hook**: triggers context sync when you type a message

Task graphs are plain JSON. You can edit them mid-session to reprioritize, add tasks, or mark things done manually. For multi-agent setups, a coordinator delegates to workers; workers publish completion events; the event bus propagates state back.

**Human steering is first-class:**
- Type in the tmux pane any time—the agent reads and adapts
- `hq_send` delivers messages to an agent's inbox; the PreToolUse hook injects them on the next tool call
- Override the stop gate with a single touch command

[Screenshot: agent working through a task graph, Stop hook blocking the session]

[Screenshot: multi-agent setup with coordinator + two workers on separate panes]

**Getting started:**
```bash
curl -fsSL https://raw.githubusercontent.com/qbg-dev/claude-ops/main/install.sh | bash
bash ~/.claude-ops/scripts/scaffold.sh my-feature /path/to/project
```

GitHub: https://github.com/qbg-dev/claude-ops
Full docs: https://github.com/qbg-dev/claude-ops/blob/main/docs/getting-started.md

Happy to answer questions about the hook design or how the multi-agent layer works.
