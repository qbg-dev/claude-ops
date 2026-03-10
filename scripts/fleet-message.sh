#!/usr/bin/env bash
# fleet-message.sh — Send a message via Fleet Mail (fleet-server API)
#
# Used by deep-review coordinators and other standalone processes that don't
# have the worker-fleet MCP server available.
#
# Usage:
#   bash fleet-message.sh --to merger --from deep-review --summary "review done" --content "..."
#   bash fleet-message.sh --to user --from deep-review --summary "review done" --content "..."
#   bash fleet-message.sh --to merger --from deep-review --fyi --content "..."
set -euo pipefail

# ── Defaults ─────────────────────────────────────────────────
TO=""
FROM="deep-review"
CONTENT=""
SUMMARY=""
FYI=false
URGENCY="normal"
REPLY_TYPE=""
CONTEXT=""

# ── Parse args ───────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --to)       TO="$2"; shift 2 ;;
    --from)     FROM="$2"; shift 2 ;;
    --content)  CONTENT="$2"; shift 2 ;;
    --summary)  SUMMARY="$2"; shift 2 ;;
    --fyi)      FYI=true; shift ;;
    --urgency)  URGENCY="$2"; shift 2 ;;
    --reply-type) REPLY_TYPE="$2"; shift 2 ;;
    --context)  CONTEXT="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: fleet-message.sh --to <worker|user> --content <text> [--from <name>] [--summary <text>] [--fyi] [--urgency high|normal|low]"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$TO" ] || [ -z "$CONTENT" ]; then
  echo "ERROR: --to and --content are required" >&2
  exit 1
fi

if [ -z "$SUMMARY" ]; then
  SUMMARY="${CONTENT:0:60}"
fi

# ── Find project root ───────────────────────────────────────
PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# ── Route: user escalation → desktop notification ────────────
if [ "$TO" = "user" ]; then
  CLAUDE_OPS="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
  NOTIFY="$CLAUDE_OPS/bin/notify"
  if [ -x "$NOTIFY" ]; then
    "$NOTIFY" --no-triage "[$FROM] $SUMMARY" "Deep Review" 2>/dev/null || true
  fi
  echo "Notified user — [$FROM] $SUMMARY"
  exit 0
fi

# ── Fleet Mail config ────────────────────────────────────────
FLEET_MAIL_URL="${FLEET_MAIL_URL:-http://127.0.0.1:8025}"

# Resolve project namespace from directory
PROJECT_NAME=$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]/-/g')
case "$PROJECT_NAME" in
  wechat*) PROJECT_NAME="wechat" ;;
esac

# ── Ensure sender account exists ─────────────────────────────
SENDER_ACCOUNT="${FROM}@${PROJECT_NAME}"
TOKEN_FILE="$HOME/.fleet-server/${SENDER_ACCOUNT}.token"

if [ ! -f "$TOKEN_FILE" ]; then
  mkdir -p "$HOME/.fleet-server"
  # Try creating the account (public endpoint, no admin needed)
  RESP=$(curl -sf -X POST "${FLEET_MAIL_URL}/api/accounts" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$SENDER_ACCOUNT\"}" 2>/dev/null || echo "")
  if [ -n "$RESP" ]; then
    NEW_TOKEN=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('bearerToken',''))" 2>/dev/null || echo "")
    if [ -n "$NEW_TOKEN" ]; then
      echo "$NEW_TOKEN" > "$TOKEN_FILE"
    fi
  fi
  # Account exists — reset token via admin API
  if [ ! -f "$TOKEN_FILE" ] && [ -f "$HOME/.fleet-server/admin-token" ]; then
    ADMIN_TOKEN=$(cat "$HOME/.fleet-server/admin-token")
    RESP=$(curl -sf -X POST "${FLEET_MAIL_URL}/api/admin/accounts/${SENDER_ACCOUNT}/reset-token" \
      -H "Authorization: Bearer $ADMIN_TOKEN" 2>/dev/null || echo "")
    if [ -n "$RESP" ]; then
      NEW_TOKEN=$(echo "$RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('bearerToken',''))" 2>/dev/null || echo "")
      if [ -n "$NEW_TOKEN" ]; then
        echo "$NEW_TOKEN" > "$TOKEN_FILE"
      fi
    fi
  fi
fi

if [ ! -f "$TOKEN_FILE" ]; then
  echo "ERROR: Could not get Fleet Mail token for $SENDER_ACCOUNT" >&2
  exit 1
fi

MAIL_TOKEN=$(cat "$TOKEN_FILE")

# ── Resolve recipient → UUID ─────────────────────────────────
RECIPIENT_NAME="${TO}@${PROJECT_NAME}"
RECIPIENT_ID=$(curl -sf "${FLEET_MAIL_URL}/api/directory" \
  -H "Authorization: Bearer $MAIL_TOKEN" 2>/dev/null | \
  python3 -c "
import json, sys
data = json.load(sys.stdin)
for a in data.get('directory', []):
    if a.get('name') == '$RECIPIENT_NAME':
        print(a['id'])
        break
" 2>/dev/null || echo "")

if [ -z "$RECIPIENT_ID" ]; then
  echo "ERROR: Recipient '$RECIPIENT_NAME' not found in Fleet Mail directory" >&2
  exit 1
fi

# ── Send ─────────────────────────────────────────────────────
MAIL_BODY=$(python3 -c "
import json, sys
body = {
    'to': ['$RECIPIENT_ID'],
    'subject': '[$FROM] $SUMMARY',
    'body': sys.stdin.read(),
    'labels': ['DEEP-REVIEW']
}
print(json.dumps(body))
" <<< "$CONTENT")

MAIL_RESP=$(curl -sf -X POST "${FLEET_MAIL_URL}/api/messages/send" \
  -H "Authorization: Bearer $MAIL_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$MAIL_BODY" 2>/dev/null || echo "")

if [ -n "$MAIL_RESP" ]; then
  MAIL_ID=$(echo "$MAIL_RESP" | python3 -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null || echo "?")
  echo "Sent to $TO [$MAIL_ID]"
else
  echo "ERROR: Fleet Mail send failed (fleet-server unreachable or auth error)" >&2
  exit 1
fi
