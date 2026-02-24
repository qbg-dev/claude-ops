---
name: "Cleanup"
description: "Audit and clean up a project directory and Claude's own memory/CLAUDE.md files. Use when the user says CLEANUP or asks to tidy up, reduce bloat, or reorganize project context."
pattern: "\\b(CLEANUP)\\b[.,;:!?]?"
---

# Cleanup Protocol

When triggered, perform TWO parallel audits: **directory cleanup** and **memory cleanup**.

## 1. Directory Cleanup

Audit the current working directory for bloat, stale files, and disorganization.

### Checklist

1. **Stale artifacts**: temp files, build outputs committed by accident, `.DS_Store`, `*.log`, empty dirs
2. **Orphaned files**: files referenced nowhere in the codebase (dead imports, unused configs, abandoned scripts)
3. **Oversized tracked files**: binaries, large datasets, or media that should be in `.gitignore` or external storage
4. **Duplicate content**: copy-pasted files, `foo (copy).ts`, `file-backup.ts`, `old-*` prefixed files
5. **Gitignore gaps**: patterns that should be in `.gitignore` but aren't (node_modules checked in, .env variants, etc.)
6. **Untracked sprawl**: run `git status` and assess which untracked files should be committed, gitignored, or deleted

### Process

- Use `git status`, `Glob`, and `Grep` to identify candidates
- Present findings as a table: `| File/Pattern | Issue | Recommendation |`
- **Never delete without confirmation**—list and ask
- For large cleanups, group by category (stale, orphaned, oversized, etc.)

## 2. Memory & Context Cleanup

Audit Claude's own persistent context files for the current project.

### Files to audit

1. **MEMORY.md** (`~/.claude/projects/{project-hash}/memory/MEMORY.md`)
   - Is always loaded in system prompt (200-line cap). Every line costs context window.
   - Should contain ONLY: cross-session debugging lessons, environment quirks, user preferences
   - Should NOT contain: project architecture docs (belongs in CLAUDE.md), duplicated info, feature implementation diaries, infrastructure credentials
   - Check for duplication against CLAUDE.md—anything already documented there should be removed from memory

2. **CLAUDE.md** (project root)
   - Is always loaded. Should be comprehensive but not verbose.
   - Check for: outdated sections, overly long tutorials/examples that could be condensed, stale file paths or component names that no longer exist in the codebase
   - Verify referenced files/paths still exist (spot-check, not exhaustive)

3. **.claude/CLAUDE.md** (private project instructions)
   - Credentials and infrastructure that shouldn't be in the public CLAUDE.md
   - Check for duplication with main CLAUDE.md

### Process

- Read all three files
- Cross-reference for duplication
- Check MEMORY.md line count (warn if approaching 200)
- Verify a sample of referenced file paths still exist
- Present findings as: `| File | Section | Issue | Recommendation |`
- **Never rewrite without confirmation**

## Output Format

Present both audits, then ask:

```
## Directory Cleanup
| File/Pattern | Issue | Recommendation |
|---|---|---|

## Memory Cleanup
| File | Section | Issue | Recommendation |
|---|---|---|---|

Which items should I proceed with? (Reply with numbers, or "all")
```
