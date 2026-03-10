# Show HN: claude-fleet — agent harness infrastructure for Claude Code

**Title**: Show HN: claude-fleet — persistent agent harnesses built on Claude Code's native hooks

---

I've been running Claude Code agents on long tasks (multi-day coding projects, doc generation, audit pipelines) and kept running into the same problem: agents stop unexpectedly, lose context, and you have to manually restart them with a fresh prompt.

claude-fleet solves this by sitting on top of Claude Code's built-in hook system. Four hooks—PreToolUse, PostToolUse, Stop, UserPromptSubmit—become the control plane:

**The Stop hook is the core mechanism.** When Claude tries to stop, the hook fires. If there are tasks left, it blocks the stop and shows the agent its current task and what's next. The agent reads this and keeps working. This is why agents don't need polling loops or external orchestrators—the hook _is_ the loop.

**The PreToolUse hook is context-injection.** Before every tool call, it injects inbox messages from other agents, policy rules, and phase state. Agents always have the right context without bloating the conversation.

**The event bus is the backbone.** Every tool call publishes an event. Side-effect scripts react: inbox delivery, task state updates, tmux alerts, git checkpoints. It's a JSONL append log—no database, no server.

The design:
- Every agent is either a **coordinator** (manages task graph, delegates) or a **worker** (claims tasks, reports completion)
- Task graphs are plain JSON files—edit them mid-session to reprioritize
- Watchdog detects crashes vs. graceful stops and respawns agents
- You can interrupt at any time: send a message to the tmux pane and the agent adapts

Everything is bash + jq + tmux. The hooks are ~200 lines each. The install is a single curl command.

This repo's own docs are maintained by an oss-steward agent running on claude-fleet.

GitHub: https://github.com/qbg-dev/claude-fleet
Getting started: https://github.com/qbg-dev/claude-fleet/blob/main/docs/getting-started.md

---

**Questions I'm curious about:**
- How do others handle context loss across Claude Code sessions?
- Anyone else building on the Claude Code hook system?
