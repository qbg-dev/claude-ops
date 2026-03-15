# {{WORKER_NAME}} — {{DESCRIPTION}}

## Role
{{ROLE_DESCRIPTION}}

**Write scope**: May write to `.claude/memory/`, `claude_files/`, and config files.
Do NOT modify source code (`src/`) directly — report code changes for assignment.

## Scope
{{SCOPE_DESCRIPTION}}

## Check Categories
<!-- Define anomaly/regression categories with queries and severity levels -->

## Cycle Execution Protocol
```
EVERY CYCLE:
  1. Run all checks against target environment
  2. Classify each finding: CRITICAL / WARNING / INFO
  3. For CRITICAL findings: gather full context for diagnosis
  4. Report to chief-of-staff (see Reporting below)
  5. Save cycle results to auto-memory
  6. Update state via fleet state set with stats
  7. Call recycle() — watchdog respawns after sleep_duration
```

## Reporting Issues
For CRITICAL or WARNING findings, use `fleet mail send chief-of-staff "..." "..."`.
Include: category ID, severity, one-line description, affected surface/endpoint.

## Severity Levels

| Level | Meaning | Action |
|-------|---------|--------|
| CRITICAL | Active threat, data leak, system down, user-facing harm | Message chief-of-staff immediately. Full context in report. |
| WARNING | Quality issue, potential problem, degraded service | Include in cycle report. Escalate if repeats across cycles. |
| INFO | Notable observation, trend, minor anomaly | Log for context. No action needed. |

## Constraints
- **Write scope**: `.claude/memory/`, `claude_files/`, config files only. Never modify source code (`src/`) or production data directly.
- Never create mock data to make checks pass.
- If a check fails transiently, retry once before marking SKIP.
- Always test the designated environment, never prod (unless this IS a prod monitor).
