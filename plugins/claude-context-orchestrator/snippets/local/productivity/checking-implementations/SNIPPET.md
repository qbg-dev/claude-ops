---
name: "Paranoid Implementation Checker"
description: "Spawns verification subagents to exhaustively check implementations for bugs, logic errors, edge cases, correctness, testing, code reuse, and architectural quality. Use CHECK for 1 round, CHECK N for N rounds."
---

# Paranoid Implementation Checker

## Trigger Format

- `CHECK` — Run 1 verification round (default)
- `CHECK N` — Run N verification rounds (e.g., `CHECK 3` runs 3 rounds)

## Behavior

Parse the number after CHECK (default 1). For each round, spawn a **code-reviewer** subagent via the Task tool with instructions to paranoidly verify all recent implementations.

Each round should focus on different aspects to avoid redundant checks:

### Round Focus Rotation

| Round | Focus |
|-------|-------|
| 1 | Logic correctness, edge cases, off-by-one errors, null/undefined paths |
| 2 | Integration correctness—are all call sites wired correctly? Do types match across boundaries? |
| 3 | Security, data integrity, race conditions, error handling completeness |
| 4 | Testing—are tests written? Do they cover edge cases? Are mocks appropriate? |
| 5 | Code reuse—is existing code/abstractions reused? Is there duplication that should be extracted? |
| 6 | Architecture—does it follow project patterns? Proper separation of concerns? Dependency direction correct? |
| 7+ | Repeat from round 1 focus with fresh eyes |

### Subagent Prompt Template

For each round, spawn a Task with `subagent_type: "code-reviewer"` using this prompt structure:

```
Review all files created or modified in the current session. This is verification round {N} of {total}.

Focus area: {focus from rotation table}

For each file:
1. Read the complete file
2. Trace every logic path
3. Check every edge case
4. Verify integration with callers/callees
5. Check for timezone bugs, off-by-one, null handling, type mismatches

**Additional checks based on focus:**

For Testing rounds:
- Are there tests for the new/modified code?
- Do tests cover happy paths AND edge cases?
- Are tests isolated (no flaky dependencies)?
- Are mocks/stubs used appropriately?
- Do tests actually assert meaningful outcomes?

For Code Reuse rounds:
- Is there existing code that could have been reused?
- Is there copy-pasted logic that should be extracted?
- Are there helper functions/utilities being reinvented?
- Does the code leverage existing abstractions?

For Architecture rounds:
- Does the code follow established project patterns (check CLAUDE.md)?
- Is separation of concerns maintained (data/logic/presentation)?
- Are dependencies pointing in the right direction (no circular deps)?
- Is the abstraction level consistent?
- Are new files in the right locations per project conventions?

Report ONLY confirmed issues with:
- File path and line number
- What's wrong (be specific)
- Why it matters (what breaks)
- Suggested fix

Do NOT report style nits, naming preferences, or theoretical concerns.
Do NOT make any changes—report only.
```

### Specialized Check Types

Beyond the round rotation, you can launch domain-specific checks in parallel using specialized agents. Common check types:

| Check Type | Agent | Focus |
|------------|-------|-------|
| **Security** | `security-auditor` | Auth token handling, XSS/injection vectors, storage security, CORS, dependency CVEs, WebSocket auth |
| **Design/UI** | `feature-dev:code-reviewer` | CSS consistency, dark mode support, touch targets, responsive layout, animations, safe area, accessibility |
| **Architecture** | `feature-dev:code-reviewer` | PAL correctness, state management, memory leaks, API error handling, type safety, component structure, build config |
| **Logic/Correctness** | `code-reviewer` | Edge cases, race conditions, null paths, off-by-one, integration wiring |

When the user says `CHECK N` with N >= 3, or requests specific check types (e.g., "security check", "UI check"), launch the appropriate specialized agents **in parallel** for maximum coverage. These complement the standard round rotation—use them when the codebase has matured enough to warrant domain-specific scrutiny.

### After All Rounds

1. Collect all issues found across rounds
2. Deduplicate and prioritize by severity (CRITICAL > HIGH > MEDIUM > LOW > INFO)
3. Fix confirmed bugs
4. Re-run tests/builds to verify fixes
5. Report summary: rounds run, issues found, issues fixed
