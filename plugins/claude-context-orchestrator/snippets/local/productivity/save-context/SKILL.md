---
name: "Save Context to CLAUDE.md"
description: "When user says SAVE, extract key learnings from the current conversation and persist them to the appropriate CLAUDE.md file. Use for credentials, API behaviors, gotchas, config patterns, or any reusable knowledge."
---

# SAVE — Persist Context to CLAUDE.md

When triggered, immediately:

1. **Identify what to save**: Scan the current conversation for new knowledge — credentials discovered, API behaviors learned, config gotchas, architectural decisions, workflow patterns, debugging insights.

2. **Choose the right file**:
   - Project-specific knowledge → `./CLAUDE.md` (in the project root)
   - Project credentials/infra → `./.claude/CLAUDE.md` (gitignored)
   - Global tool knowledge → `~/.claude/CLAUDE.md`
   - Per-tool reference → Create/update a snippet instead

3. **Find the right section**: Read the target CLAUDE.md first. Place the new info in the most logical existing section. If no section fits, create a minimal new one.

4. **Write concisely**: Use tables, bullet points, or code blocks. No prose. Max 5-10 lines per addition. If it's longer, it should be a snippet, not CLAUDE.md content.

5. **Don't duplicate**: Check if the info already exists. Update rather than append if it does.

6. **Confirm**: Tell Warren what was saved and where (file + section).
