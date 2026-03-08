#!/usr/bin/env bash
# stop-inbox-drain.sh — Block stopping if unread inbox messages or pending ACKs.
#
# Checks the worker's inbox.jsonl against its cursor. If there are:
#   1. Unread messages → block with instruction to read_inbox()
#   2. Messages requiring ACK (ack_required=true) without a reply → block
#
# Only applies to flat workers (worker/* in registry). Non-worker sessions pass through.
set -euo pipefail

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "$HOME/.claude-ops/lib/fleet-jq.sh" 2>/dev/null || { echo '{}'; exit 0; }
source "$HOME/.claude-ops/lib/event-bus.sh" 2>/dev/null || true

INPUT=$(cat)
hook_parse_input "$INPUT"
# Subagents don't have inboxes — let them stop freely
_is_subagent && { hook_pass; exit 0; }

# Find own pane + resolve worker identity
OWN_PANE_ID=$(hook_find_own_pane 2>/dev/null || echo "")
hook_resolve_harness "$OWN_PANE_ID" "$_HOOK_SESSION_ID" 2>/dev/null || true

# Only handle flat workers
if [[ "${CANONICAL:-$HARNESS}" != worker/* ]]; then
  hook_pass
  exit 0
fi

_wname="${CANONICAL#worker/}"
_wname="${_wname:-${HARNESS#worker/}}"

# Resolve worker directory (handle worktree)
_wdir="$PROJECT_ROOT/.claude/workers/$_wname"
if [ ! -d "$_wdir" ]; then
  _main_root=$(git -C "$PROJECT_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null | sed 's|/\.git$||')
  [ -n "$_main_root" ] && [ "$_main_root" != "$PROJECT_ROOT" ] && _wdir="$_main_root/.claude/workers/$_wname"
fi

INBOX_FILE="$_wdir/inbox.jsonl"
CURSOR_FILE="$_wdir/inbox-cursor.json"

# No inbox file = nothing to check
[ ! -f "$INBOX_FILE" ] && { hook_pass; exit 0; }

# ── Check 1: Unread messages (compare file size to byte-offset cursor) ──
_file_size=$(wc -c < "$INBOX_FILE" 2>/dev/null | tr -d ' ')
_cursor_offset=0
if [ -f "$CURSOR_FILE" ]; then
  _cursor_offset=$(jq -r '.offset // 0' "$CURSOR_FILE" 2>/dev/null || echo "0")
fi
_has_unread=0
[ "$_file_size" -gt "$_cursor_offset" ] && _has_unread=1

if [ "$_has_unread" -gt 0 ]; then
  # Count unread lines from cursor offset forward
  _unread=$(tail -c +"$((_cursor_offset + 1))" "$INBOX_FILE" 2>/dev/null | wc -l | tr -d ' ')
  # Extract summaries of unread messages for context
  _summaries=$(tail -c +"$((_cursor_offset + 1))" "$INBOX_FILE" \
    | jq -r 'select(.from_name) | "  - [\(.from_name)]: \(.summary // .content[:80])"' 2>/dev/null \
    | head -5)
  _block_msg="## Unread inbox messages ($_unread)

You have $_unread unread message(s). Read and process them before stopping.

$_summaries

Action: Call read_inbox() to read these messages. Reply to any marked [NEEDS REPLY] with send_message(in_reply_to=\"msg_id\")."
  hook_block "$_block_msg"
  exit 0
fi

# ── Check 2: Pending ACKs ──
# Find messages in inbox with ack_required=true that haven't been replied to.
# A message is "replied to" if there's a later message in inbox with in_reply_to matching its msg_id
# (sent back to us as confirmation), OR if we sent a reply (checked via outbox pattern).
#
# Simple heuristic: check all ack_required messages, see if msg_id appears as
# in_reply_to in any OUTGOING message (by checking all worker inboxes for our replies).

_pending_acks=$(jq -r '
  select(.ack_required == true) |
  select(.in_reply_to == null or .in_reply_to == "") |
  .msg_id
' "$INBOX_FILE" 2>/dev/null | sort -u)

if [ -n "$_pending_acks" ]; then
  # Check if we've replied to any of these by scanning other workers' inboxes
  _workers_dir="$(dirname "$_wdir")"
  _still_pending=""

  for _mid in $_pending_acks; do
    _replied=false
    # Check all worker inboxes for a message from us with in_reply_to matching this msg_id
    for _other_inbox in "$_workers_dir"/*/inbox.jsonl; do
      [ ! -f "$_other_inbox" ] && continue
      if grep -q "\"in_reply_to\":\"$_mid\"" "$_other_inbox" 2>/dev/null; then
        _replied=true
        break
      fi
    done
    if [ "$_replied" = "false" ]; then
      _still_pending="$_still_pending $_mid"
    fi
  done

  _still_pending=$(echo "$_still_pending" | xargs)
  _count=$(echo "$_still_pending" | wc -w | tr -d ' ')

  if [ "$_count" -gt 0 ]; then
    # Get details of pending messages
    _details=""
    for _mid in $_still_pending; do
      _info=$(grep "\"msg_id\":\"$_mid\"" "$INBOX_FILE" \
        | jq -r '"  - [\(.from_name)] \(.summary // .content[:60]) (msg_id: \(.msg_id))"' 2>/dev/null)
      _details="$_details
$_info"
    done

    _block_msg="## Pending acknowledgements ($_count)

You received $_count message(s) that require a reply but haven't been acknowledged yet:
$_details

Action: Reply to each with send_message(to=\"<sender>\", in_reply_to=\"<msg_id>\", content=\"...\", summary=\"ACK: ...\")."
    hook_block "$_block_msg"
    exit 0
  fi
fi

# All clear
hook_pass
exit 0
