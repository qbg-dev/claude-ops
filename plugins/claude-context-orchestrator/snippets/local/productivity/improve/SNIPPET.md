---
name: Improve the Harness
description: After a work session, identify what was learned and upgrade the harness — CLAUDE.md, hooks, test infrastructure, snippets, agent configs, anything that makes future sessions better. Trigger with "IMPROVE" or "what should we improve?".
keywords:
  - IMPROVE
  - REFLECT
---

# IMPROVE: Upgrade the Harness from Session Learnings

## Triggers

- User says "IMPROVE" or "what should we improve?"
- End of a substantial work session where patterns were discovered
- After hitting friction that better tooling could have prevented
- After a multi-session project milestone

## Core Principle

**Every session teaches something. Capture it where it matters.** Don't just note learnings — change the infrastructure so the next session starts smarter.

## What's in the Harness

The "harness" is everything that shapes how Claude works in a project:

| Layer | Files | What It Controls |
|-------|-------|-----------------|
| **Project instructions** | `.claude/CLAUDE.md` | Conventions, patterns, skip lists, framework notes, phase definitions |
| **Hooks** | `~/.claude/hooks/*.sh` | Auto-prompts, session naming, implementation checks, echo loops |
| **Agent definitions** | `.claude/agents/*.md` | Specialized agent roles, tool permissions, workflows |
| **Test infrastructure** | `docker-compose.test.yml`, `Dockerfile.test`, `bootstrap.php`, `phpunit.xml` | How tests build, run, bootstrap |
| **Tracking files** | `feature-list.json`, `claude-progress.txt` | Cross-session state, what's done, what's next |
| **Skills** | `skills/*/SKILL.md` | Reusable workflows invoked by keyword |
| **Snippets** | `snippets/local/*/*/SNIPPET.md` | Context injected by keyword |
| **Plan files** | `~/.claude/plans/*.md` | Approved implementation strategies |

## Workflow

### 1. Identify What Was Learned

Ask yourself:

- **Patterns discovered**: Did you find a recurring code pattern that every future test/agent should know about? (e.g., "all PMS models use the same invoice 3-state permission pattern")
- **Friction hit**: Did you waste time on something that better docs would have prevented? (e.g., "`assertSame` fails on int/float accumulations — use `assertEquals`")
- **Infrastructure gaps**: Is there a missing stub, mock, or bootstrap step that blocked testing? (e.g., "PaymentMethod_Model mock needed for pay_type branches")
- **Convention drift**: Did you invent a convention that isn't written down? (e.g., "testable subclass pattern with empty constructor")
- **Bug patterns**: Did you find the same bug type in multiple files? (e.g., "foreach by-value in handleList")
- **Skip criteria**: Did you learn what NOT to test and why? (e.g., "Admin_model looks pure but every method internally hits DB")

### 2. Decide Where Each Learning Goes

| Learning Type | Target | Example |
|--------------|--------|---------|
| Project convention / pattern | `.claude/CLAUDE.md` | "All PMS handleRow methods follow: date format + field derivation + accumulation" |
| Test writing rule | `.claude/CLAUDE.md` (test section) | "Use assertEquals not assertSame for numeric accumulations" |
| Infrastructure fix | `bootstrap.php`, `Dockerfile.test`, etc. | "Add PaymentMethod_Model stub to bootstrap" |
| Cross-session state | `claude-progress.txt` | "Pure method surface exhausted. Next: DB fixtures" |
| Reusable workflow | `skills/*/SKILL.md` | "New skill for PHP characterization test writing" |
| Quick-reference context | `snippets/local/*/SNIPPET.md` | "PMS model archetypes cheat sheet" |
| Auto-prompt behavior | `~/.claude/hooks/*.sh` | "Add hook that reminds about test density standards" |
| Agent role refinement | `.claude/agents/*.md` | "Test Writer agent should check for by-value foreach bugs" |

### 3. Propose Changes

Present a concise report:

```
# Improve: [Session Topic]

## Learnings

1. **[Pattern/Friction/Gap]**: [What was discovered]
   -> [Where it should go] + [Exact change]

2. **[Pattern/Friction/Gap]**: [What was discovered]
   -> [Where it should go] + [Exact change]

## Proposed Changes

### CLAUDE.md
- Add section: [name] with [content summary]
- Update section: [name] — add [what]

### Infrastructure
- [File]: [Change description]

### Skills/Snippets
- [Create/Update]: [name] — [purpose]

Proceed? (yes/no)
```

### 4. Apply (After Approval)

- Make all changes in one pass
- Verify nothing breaks (run tests if test infra was changed)
- Commit if the changes are substantial

## Anti-Patterns

- **Don't over-document.** If a pattern appears once, it's an observation. If it appears 3+ times, it's worth codifying.
- **Don't add noise to CLAUDE.md.** Every line in CLAUDE.md costs context tokens on every future session. Only add what saves more time than it costs to read.
- **Don't create a snippet for something that fits in CLAUDE.md.** Snippets are for optional, keyword-triggered context. Project-wide conventions belong in CLAUDE.md.
- **Don't log without acting.** The old REFLECT workflow created eval files that nobody read. If a learning isn't worth changing infrastructure for, it's not worth writing down.

## Works With

- `managing-skills` (MANAGESKILL) — for creating/updating skills
- `managing-snippets` (MANAGESNIP) — for creating/updating snippets
- `writing-scripts` (SCRIPT) — if the improvement involves a new hook script
