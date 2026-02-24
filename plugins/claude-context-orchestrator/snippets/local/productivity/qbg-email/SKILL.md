---
name: "qbg.dev Email Configuration"
description: "Full reference for warren@qbg.dev email: Cloudflare inbound routing, Resend API outbound, SMTP settings, DNS records, and adding new addresses."
---

# qbg.dev Email (warren@qbg.dev)

## Inbound (receiving)

Cloudflare Email Routing forwards warren@qbg.dev -> wzhu@college.harvard.edu.
Emails arrive in Harvard inbox (visible via `gmail` CLI).

DNS:
- MX records on qbg.dev -> `route1/2/3.mx.cloudflare.net`
- DKIM: `cf2024-1._domainkey.qbg.dev` (Cloudflare-managed)
- SPF: `v=spf1 include:_spf.mx.cloudflare.net ~all` on qbg.dev
- Cloudflare zone ID: `2f8b88973faeb29c0fafa401099becdf`

## Outbound (sending as warren@qbg.dev)

Resend API sends on behalf of warren@qbg.dev.
- API key: `~/.resend/api_key`
- Domain ID: `e76cebf2-4179-40ed-8da7-8a518a4e8661`
- DNS: DKIM at `resend._domainkey.qbg.dev`, SPF at `send.qbg.dev`

**Send via Python SDK:**
```bash
uv run python3 -c "
import resend, os
resend.api_key = open(os.path.expanduser('~/.resend/api_key')).read().strip()
r = resend.Emails.send({
    'from': 'warren@qbg.dev',
    'to': 'RECIPIENT@example.com',
    'subject': 'Subject here',
    'html': '<p>Body here</p>'
})
print(r)
"
```

**SMTP settings (for mail clients):**
- Server: `smtp.resend.com`
- Port: `465` (SSL)
- Username: `resend`
- Password: API key from `~/.resend/api_key`

## Adding new qbg.dev addresses (e.g., matt@qbg.dev)

1. Add Cloudflare Email Routing rule: `matt` -> destination email
2. Verify destination email (click Cloudflare confirmation link)
3. Resend domain is already verified--any `@qbg.dev` address can send via the same API key
