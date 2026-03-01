# conv-monitor Memory

## Prod Access
- SSH: `sshpass -p '{{PROD_SSH_PASS}}' ssh root@{{PROD_HOST}}`
- DB: `sqlite3 {{DB_PATH}}`
- Always use `timeout 30` on SSH commands to prevent hangs
- STRICTLY READ-ONLY. Never modify prod data.

## Cycle Log
(append after each cycle)
