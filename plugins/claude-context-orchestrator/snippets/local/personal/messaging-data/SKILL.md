---
name: "Messaging Data Locations"
description: "Where Warren's messaging data is stored: WhatsApp exports, iMessage, Discord DMs, and database locations."
---

# Messaging Data

Consolidated at `~/.claude/messaging-data/`:
- `whatsapp-joshua.txt`, `whatsapp-leyi.txt`, `whatsapp-uzay.txt`
- `imessage-extract-2000-recent.txt`
- `discord-dms/` -- 54 files, ~16MB. Key: `mattk` (largest), `soccer fan, mattk` (group w/ Kevin)

## Full Databases

- iMessage full DB: `~/Library/Messages/chat.db`
- Discord (Denken bot): Production EC2 `/data/denken.db` (pull via `uv run denken deploy ssh -p ec2-prod`)

## Related Snippets

- Texting style snippet: `~/.claude/plugins/marketplaces/warren-claude-code-plugin-marketplace/claude-context-orchestrator/snippets/local/communication/texting-style/SKILL.md`
