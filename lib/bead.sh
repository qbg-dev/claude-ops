#!/usr/bin/env bash
# harness-bead.sh — Beads-inspired cross-harness coordination.
#
# Three primitives:
#   wisps  — ephemeral messages between harnesses (auto-expire 24h)
#   claims — file-level locks ("I'm editing this, don't touch")
#   gates  — named blockers ("don't proceed until I'm done with X")
#
# Usage:
#   harness-bead.sh wisp <from> <msg> [to]        Send ephemeral message
#   harness-bead.sh wisps [harness]                List unread wisps (optionally for a specific harness)
#   harness-bead.sh ack <wisp-id|all>              Acknowledge (clear) wisps
#   harness-bead.sh claim <file> <harness> [reason] Claim a file
#   harness-bead.sh release <file>                 Release a file claim
#   harness-bead.sh claims                         List active claims
#   harness-bead.sh check <file>                   Check if file is claimed
#   harness-bead.sh gate <name> <harness> <reason> Set a gate (blocker)
#   harness-bead.sh ungate <name>                  Remove a gate
#   harness-bead.sh gates                          List active gates
#   harness-bead.sh status                         Full status (wisps + claims + gates)
#   harness-bead.sh gc                             Garbage collect expired entries
set -euo pipefail

PROJECT_ROOT="/Users/wz/Desktop/zPersonalProjects/Wechat"
BEADS="$PROJECT_ROOT/claude_files/harness-beads.json"
TTL_SECONDS=86400  # 24h for wisps and claims

# Initialize if missing
if [ ! -f "$BEADS" ]; then
  echo '{"wisps":[],"claims":{},"gates":{}}' > "$BEADS"
fi

now_epoch() { date +%s; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# Generate short hash ID (w-xxxx for wisps)
short_id() {
  local prefix="$1"
  echo "${prefix}-$(head -c 4 /dev/urandom | xxd -p | cut -c1-4)"
}

cmd="${1:-help}"
shift || true

case "$cmd" in

  # ═══════════════════════════════════════
  # WISPS — ephemeral messages
  # ═══════════════════════════════════════
  wisp)
    FROM="${1:?Usage: harness-bead.sh wisp <from> <msg> [to]}"
    MSG="${2:?Usage: harness-bead.sh wisp <from> <msg> [to]}"
    TO="${3:-all}"
    ID=$(short_id "w")
    TS=$(now_iso)
    EXPIRES=$(( $(now_epoch) + TTL_SECONDS ))

    TMP=$(mktemp)
    jq --arg id "$ID" --arg from "$FROM" --arg to "$TO" --arg msg "$MSG" \
       --arg ts "$TS" --argjson exp "$EXPIRES" \
      '.wisps += [{"id":$id,"from":$from,"to":$to,"msg":$msg,"ts":$ts,"expires":$exp,"read":false}]' \
      "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"

    echo "Wisp $ID sent: [$FROM → $TO] $MSG"
    ;;

  wisps)
    FILTER="${1:-}"
    NOW=$(now_epoch)

    if [ -n "$FILTER" ]; then
      # Show wisps for a specific harness (to=harness or to=all), unread only, not expired
      jq -r --arg h "$FILTER" --argjson now "$NOW" \
        '.wisps[] | select(.read == false and .expires > $now and (.to == $h or .to == "all")) |
         "  \(.id) [\(.from)→\(.to)] \(.msg) (\(.ts))"' "$BEADS"
    else
      # Show all unread, not expired
      jq -r --argjson now "$NOW" \
        '.wisps[] | select(.read == false and .expires > $now) |
         "  \(.id) [\(.from)→\(.to)] \(.msg) (\(.ts))"' "$BEADS"
    fi
    ;;

  ack)
    TARGET="${1:?Usage: harness-bead.sh ack <wisp-id|all>}"
    TMP=$(mktemp)
    if [ "$TARGET" = "all" ]; then
      jq '.wisps |= map(.read = true)' "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"
      echo "All wisps acknowledged."
    else
      jq --arg id "$TARGET" '.wisps |= map(if .id == $id then .read = true else . end)' \
        "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"
      echo "Wisp $TARGET acknowledged."
    fi
    ;;

  # ═══════════════════════════════════════
  # CLAIMS — file-level locks
  # ═══════════════════════════════════════
  claim)
    FILE="${1:?Usage: harness-bead.sh claim <file> <harness> [reason]}"
    HARNESS="${2:?Usage: harness-bead.sh claim <file> <harness> [reason]}"
    REASON="${3:-editing}"
    TS=$(now_iso)
    EXPIRES=$(( $(now_epoch) + TTL_SECONDS ))

    # Check if already claimed by someone else
    EXISTING=$(jq -r --arg f "$FILE" '.claims[$f].by // ""' "$BEADS")
    if [ -n "$EXISTING" ] && [ "$EXISTING" != "$HARNESS" ]; then
      echo "WARNING: $FILE already claimed by $EXISTING. Overriding."
    fi

    TMP=$(mktemp)
    jq --arg f "$FILE" --arg h "$HARNESS" --arg r "$REASON" \
       --arg ts "$TS" --argjson exp "$EXPIRES" \
      '.claims[$f] = {"by":$h,"reason":$r,"ts":$ts,"expires":$exp}' \
      "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"

    echo "Claimed: $FILE by $HARNESS ($REASON)"
    ;;

  release)
    FILE="${1:?Usage: harness-bead.sh release <file>}"
    TMP=$(mktemp)
    jq --arg f "$FILE" 'del(.claims[$f])' "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"
    echo "Released: $FILE"
    ;;

  claims)
    NOW=$(now_epoch)
    jq -r --argjson now "$NOW" \
      '.claims | to_entries[] | select(.value.expires > $now) |
       "  \(.key) — claimed by \(.value.by) (\(.value.reason)) since \(.value.ts)"' "$BEADS"
    ;;

  check)
    FILE="${1:?Usage: harness-bead.sh check <file>}"
    NOW=$(now_epoch)
    RESULT=$(jq -r --arg f "$FILE" --argjson now "$NOW" \
      'if .claims[$f] and .claims[$f].expires > $now then
         "CLAIMED by \(.claims[$f].by): \(.claims[$f].reason)"
       else "FREE" end' "$BEADS")
    echo "$RESULT"
    ;;

  # ═══════════════════════════════════════
  # GATES — named blockers
  # ═══════════════════════════════════════
  gate)
    NAME="${1:?Usage: harness-bead.sh gate <name> <harness> <reason>}"
    HARNESS="${2:?Usage: harness-bead.sh gate <name> <harness> <reason>}"
    REASON="${3:?Usage: harness-bead.sh gate <name> <harness> <reason>}"
    TS=$(now_iso)

    TMP=$(mktemp)
    jq --arg n "$NAME" --arg h "$HARNESS" --arg r "$REASON" --arg ts "$TS" \
      '.gates[$n] = {"by":$h,"reason":$r,"ts":$ts}' \
      "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"

    echo "Gate set: $NAME by $HARNESS ($REASON)"
    ;;

  ungate)
    NAME="${1:?Usage: harness-bead.sh ungate <name>}"
    TMP=$(mktemp)
    jq --arg n "$NAME" 'del(.gates[$n])' "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"
    echo "Gate removed: $NAME"
    ;;

  gates)
    jq -r '.gates | to_entries[] |
       "  \(.key) — set by \(.value.by): \(.value.reason) (\(.value.ts))"' "$BEADS"
    ;;

  # ═══════════════════════════════════════
  # STATUS + GC
  # ═══════════════════════════════════════
  status)
    NOW=$(now_epoch)
    echo "=== Wisps (unread) ==="
    jq -r --argjson now "$NOW" \
      '.wisps[] | select(.read == false and .expires > $now) |
       "  \(.id) [\(.from)→\(.to)] \(.msg)"' "$BEADS" || echo "  (none)"
    echo ""
    echo "=== Claims (active) ==="
    jq -r --argjson now "$NOW" \
      '.claims | to_entries[] | select(.value.expires > $now) |
       "  \(.key) — \(.value.by) (\(.value.reason))"' "$BEADS" || echo "  (none)"
    echo ""
    echo "=== Gates (active) ==="
    jq -r '.gates | to_entries[] |
       "  \(.key) — \(.value.by): \(.value.reason)"' "$BEADS" || echo "  (none)"
    ;;

  gc)
    NOW=$(now_epoch)
    TMP=$(mktemp)
    BEFORE_WISPS=$(jq '.wisps | length' "$BEADS")
    BEFORE_CLAIMS=$(jq '.claims | length' "$BEADS")

    jq --argjson now "$NOW" '
      .wisps |= [.[] | select(.expires > $now and .read == false)] |
      .claims |= with_entries(select(.value.expires > $now))
    ' "$BEADS" > "$TMP" && mv "$TMP" "$BEADS"

    AFTER_WISPS=$(jq '.wisps | length' "$BEADS")
    AFTER_CLAIMS=$(jq '.claims | length' "$BEADS")
    echo "GC: wisps $BEFORE_WISPS→$AFTER_WISPS, claims $BEFORE_CLAIMS→$AFTER_CLAIMS"
    ;;

  help|*)
    cat <<'HELP'
harness-bead.sh — Cross-harness coordination (Beads-inspired)

Wisps (ephemeral messages, 24h TTL):
  wisp <from> <msg> [to]    Send message (to=all if omitted)
  wisps [harness]            List unread wisps
  ack <id|all>               Mark wisps as read

Claims (file locks, 24h TTL):
  claim <file> <harness> [reason]   Lock a file
  release <file>                    Unlock a file
  claims                            List active claims
  check <file>                      Check if file is claimed

Gates (named blockers, no TTL):
  gate <name> <harness> <reason>    Set a blocker
  ungate <name>                     Remove a blocker
  gates                             List active gates

Other:
  status                            Full overview
  gc                                Remove expired entries
HELP
    ;;
esac
