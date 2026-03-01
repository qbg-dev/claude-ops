#!/usr/bin/env bash
# event-bus.sh — Unified event bus library for harness agent communication (v3).
#
# v3 changes: single stream.jsonl (no topics), pluggable side-effect scripts,
# named filters in schema.json, simplified query API.
#
# Usage: source ~/.boring/lib/event-bus.sh
#
# Functions:
#   bus_publish <event_type> <json_payload>       — Enrich with _seq, append to stream, run side-effects
#   bus_read <consumer_id> [--type TYPE] [--limit N] — Read from cursor, advance
#   bus_ack <consumer_id> <seq>                   — Manually advance cursor to _seq
#   bus_subscribe <consumer_id>                   — Initialize consumer cursor at current max
#   bus_query [type] [--type T] [--pattern P] [--after N] [--from A] [--since ISO] [--limit N] [--raw]
#   bus_git_checkpoint [message]                  — Auto-commit structural bus + harness files
#   bus_compact                                   — Compact stream keeping events after lowest cursor

set -euo pipefail

# ── Bus directory resolution ─────────────────────────────────────────
# Always resolve to the MAIN repo's bus, even from worktrees.
# In a git worktree, .git is a file: "gitdir: /path/to/main/.git/worktrees/<name>"
# We follow that back to the main repo so all agents share one bus.
_bus_resolve_main_repo() {
  local toplevel
  toplevel=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
  [ -z "$toplevel" ] && return
  local dotgit="$toplevel/.git"
  if [ -f "$dotgit" ]; then
    # Worktree: .git is a file pointing to main repo's .git/worktrees/<name>
    local gitdir
    gitdir=$(sed -n 's/^gitdir: //p' "$dotgit" 2>/dev/null)
    if [ -n "$gitdir" ]; then
      # Resolve relative paths
      [[ "$gitdir" != /* ]] && gitdir="$toplevel/$gitdir"
      # Strip /worktrees/<name> and /.git to get main repo root
      local main_git="${gitdir%/worktrees/*}"
      local main_repo="${main_git%/.git}"
      [ -d "$main_repo" ] && echo "$main_repo" && return
    fi
  fi
  # Not a worktree (or resolution failed) — use toplevel as-is
  echo "$toplevel"
}

_bus_follow_worktree() {
  # Given a directory, if it's a worktree, return the main repo root instead.
  local dir="$1"
  local dotgit="$dir/.git"
  if [ -f "$dotgit" ]; then
    local gitdir
    gitdir=$(sed -n 's/^gitdir: //p' "$dotgit" 2>/dev/null)
    if [ -n "$gitdir" ]; then
      [[ "$gitdir" != /* ]] && gitdir="$dir/$gitdir"
      local main_git="${gitdir%/worktrees/*}"
      local main_repo="${main_git%/.git}"
      [ -d "$main_repo" ] && echo "$main_repo" && return
    fi
  fi
  echo "$dir"
}

_bus_resolve_dir() {
  if [ -n "${BUS_DIR:-}" ]; then echo "$BUS_DIR"; return; fi
  local pr
  if [ -n "${PROJECT_ROOT:-}" ]; then
    pr=$(_bus_follow_worktree "$PROJECT_ROOT")
  else
    pr=$(_bus_resolve_main_repo)
  fi
  if [ -n "$pr" ]; then
    mkdir -p "$pr/.claude/bus" 2>/dev/null || true
    echo "$pr/.claude/bus"
  else
    echo "$HOME/.boring/bus"  # last resort only
  fi
}

BUS_DIR="${BUS_DIR:-$(_bus_resolve_dir)}"
BUS_STREAM="$BUS_DIR/stream.jsonl"
BUS_CURSORS_DIR="$BUS_DIR/cursors"
BUS_DLQ_DIR="$BUS_DIR/dlq"
BUS_SCHEMA="$BUS_DIR/schema.json"
BUS_SEQ_FILE="$BUS_DIR/seq.json"
BUS_SIDE_EFFECTS_DIR="$HOME/.boring/bus/side-effects"

EVENT_BUS_ENABLED="${EVENT_BUS_ENABLED:-true}"

# ── Internal helpers ─────────────────────────────────────────────────

_bus_ensure_dirs() {
  mkdir -p "$BUS_CURSORS_DIR" "$BUS_DLQ_DIR" 2>/dev/null || true
}

# mkdir-based spinlock: _bus_lock <lockfile>; ...; _bus_unlock <lockfile>
_bus_lock() {
  local lockfile="$1" max_wait=10 waited=0
  while ! mkdir "$lockfile" 2>/dev/null; do
    waited=$((waited + 1))
    [ "$waited" -ge "$max_wait" ] && { rm -rf "$lockfile" 2>/dev/null; mkdir "$lockfile" 2>/dev/null || true; break; }
    sleep 0.1
  done
}
_bus_unlock() { rm -rf "$1" 2>/dev/null || true; }

_bus_cursor_file() {
  echo "$BUS_CURSORS_DIR/${1}.json"
}

_bus_get_cursor() {
  # Returns the _seq value the consumer has read up to (0 = nothing read).
  # v3: single cursor value per consumer (not per-topic).
  local consumer_id="$1"
  local cursor_file
  cursor_file=$(_bus_cursor_file "$consumer_id")
  if [ -f "$cursor_file" ]; then
    jq -r '.seq // 0' "$cursor_file" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

_bus_set_cursor() {
  local consumer_id="$1" seq_val="$2"
  local cursor_file
  cursor_file=$(_bus_cursor_file "$consumer_id")
  echo "{\"seq\":$seq_val}" > "$cursor_file"
}

_bus_next_seq() {
  local lockfile="${BUS_SEQ_FILE}.lock"
  _bus_lock "$lockfile"
  local current=0
  [ -f "$BUS_SEQ_FILE" ] && current=$(jq -r '.global // 0' "$BUS_SEQ_FILE" 2>/dev/null || echo "0")
  local next=$((current + 1))
  echo "{\"global\": $next}" > "$BUS_SEQ_FILE"
  _bus_unlock "$lockfile"
  echo "$next"
}

# ── Pluggable side-effects ───────────────────────────────────────────
# Reads side_effects array from schema.json for the event type,
# then executes matching scripts from ~/.boring/bus/side-effects/.

_bus_run_side_effects() {
  local event_type="$1" payload="$2"

  # Read declared side effects from schema
  local effects
  effects=$(jq -r --arg et "$event_type" \
    '.event_types[$et].side_effects // [] | .[]' "$BUS_SCHEMA" 2>/dev/null || true)
  [ -z "$effects" ] && return 0

  local project_root="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

  while IFS= read -r effect; do
    [ -z "$effect" ] && continue
    local script="$BUS_SIDE_EFFECTS_DIR/${effect}.sh"
    if [ -x "$script" ]; then
      echo "$payload" | PROJECT_ROOT="$project_root" bash "$script" \
        2>> "$BUS_DLQ_DIR/side-effect-errors.log" || true
    fi
  done <<< "$effects"
}

# ── Public API ───────────────────────────────────────────────────────

bus_publish() {
  # bus_publish <event_type> <json_payload>
  local event_type="${1:?Usage: bus_publish <event_type> <json_payload>}"
  local payload="${2:?Usage: bus_publish <event_type> <json_payload>}"

  [ "$EVENT_BUS_ENABLED" != "true" ] && return 0
  _bus_ensure_dirs

  # Get next global sequence number
  local seq
  seq=$(_bus_next_seq)

  # Enrich payload with _seq, _event_type, _ts
  local enriched
  enriched=$(echo "$payload" | jq -c \
    --argjson seq "$seq" \
    --arg et "$event_type" \
    --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '. + {"_seq": $seq, "_event_type": $et, "_ts": $ts}' 2>/dev/null || echo "$payload")

  # Atomic append to single stream
  local lockfile="${BUS_STREAM}.lock"
  _bus_lock "$lockfile"
  echo "$enriched" >> "$BUS_STREAM"
  _bus_unlock "$lockfile"

  # Async side-effects (fire-and-forget, errors logged)
  (_bus_run_side_effects "$event_type" "$enriched") &
  disown 2>/dev/null || true

  return 0
}

bus_read() {
  # bus_read <consumer_id> [--type TYPE] [--limit N]
  # Reads events after cursor's _seq position, optionally filtered by type. Advances cursor.
  local consumer_id="${1:?Usage: bus_read <consumer_id> [--type TYPE] [--limit N]}"
  shift

  local type_filter="" limit=50
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type)  type_filter="$2"; shift 2 ;;
      --limit) limit="$2"; shift 2 ;;
      *) shift ;;
    esac
  done

  [ ! -f "$BUS_STREAM" ] && echo "[]" && return 0

  local cursor_seq
  cursor_seq=$(_bus_get_cursor "$consumer_id")

  # Build filter
  local jq_filter='select(._seq > $seq)'
  local jq_args=(--argjson seq "$cursor_seq")
  if [ -n "$type_filter" ]; then
    jq_filter="$jq_filter | select(._event_type == \$et)"
    jq_args+=(--arg et "$type_filter")
  fi

  local events
  events=$(jq -c "${jq_args[@]}" "$jq_filter" "$BUS_STREAM" 2>/dev/null | jq -cs --argjson lim "$limit" '.[0:$lim]' 2>/dev/null || echo "[]")

  # Find max _seq in returned events and advance cursor
  local max_seq
  max_seq=$(echo "$events" | jq '[.[]._seq // 0] | max // 0' 2>/dev/null || echo "0")
  if [ "$max_seq" -gt "$cursor_seq" ] 2>/dev/null; then
    _bus_set_cursor "$consumer_id" "$max_seq"
  fi

  echo "$events"
}

bus_ack() {
  # bus_ack <consumer_id> <seq>
  local consumer_id="${1:?Usage: bus_ack <consumer_id> <seq>}"
  local seq_val="${2:?Usage: bus_ack <consumer_id> <seq>}"
  _bus_set_cursor "$consumer_id" "$seq_val"
}

bus_subscribe() {
  # bus_subscribe <consumer_id>
  # Initialize consumer cursor at current max _seq (so they only see new events).
  local consumer_id="${1:?Usage: bus_subscribe <consumer_id>}"
  _bus_ensure_dirs

  local cursor_file
  cursor_file=$(_bus_cursor_file "$consumer_id")

  if [ ! -f "$cursor_file" ] || [ "$(jq -r '.seq // 0' "$cursor_file" 2>/dev/null)" = "0" ]; then
    local max_seq=0
    if [ -f "$BUS_STREAM" ]; then
      max_seq=$(tail -1 "$BUS_STREAM" 2>/dev/null | jq -r '._seq // 0' 2>/dev/null || echo "0")
    fi
    _bus_set_cursor "$consumer_id" "$max_seq"
  fi
}

bus_query() {
  # Unified query: supports both legacy positional args and flags.
  #   Legacy: bus_query <event_type> [after_seq]
  #   Flags:  bus_query --type <type> [--pattern <regex>] [--after <seq>] [--from <agent>] [--since <ISO>] [--limit <N>] [--raw]
  local type="" pattern="" after_seq=0 from="" since="" limit=50 raw=false

  # Parse: detect legacy positional vs flag mode
  if [[ $# -gt 0 ]] && [[ "$1" != --* ]]; then
    # Legacy: bus_query <event_type> [after_seq] — returns raw NDJSON for pipe compatibility
    type="$1"; after_seq="${2:-0}"; raw=true; shift $#
  fi

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --type)    type="$2"; shift 2 ;;
      --pattern) pattern="$2"; shift 2 ;;
      --after|--after-seq) after_seq="$2"; shift 2 ;;
      --from)    from="$2"; shift 2 ;;
      --since)   since="$2"; shift 2 ;;
      --limit)   limit="$2"; shift 2 ;;
      --raw)     raw=true; shift ;;
      *) shift ;;
    esac
  done

  [ ! -f "$BUS_STREAM" ] && { $raw || echo "[]"; return 0; }

  # If pattern given but no type, use pattern directly as regex
  # (no early return for empty filters — callers may query all events by seq/limit alone)

  local jq_args=(--argjson after "$after_seq")
  local jq_filter='select(._seq > $after)'

  if [ -n "$type" ]; then
    jq_args+=(--arg et "$type")
    jq_filter="$jq_filter | select(._event_type == \$et)"
  fi
  if [ -n "$pattern" ]; then
    jq_args+=(--arg pat "$pattern")
    jq_filter="$jq_filter | select(._event_type | test(\$pat))"
  fi
  if [ -n "$from" ]; then
    jq_args+=(--arg from_val "$from")
    jq_filter="$jq_filter | select(.from == \$from_val or .agent == \$from_val)"
  fi
  if [ -n "$since" ]; then
    jq_args+=(--arg since "$since")
    jq_filter="$jq_filter | select(._ts >= \$since or .ts >= \$since)"
  fi

  if $raw; then
    jq -c "${jq_args[@]}" "$jq_filter" "$BUS_STREAM" 2>/dev/null
  else
    jq -c "${jq_args[@]}" "$jq_filter" "$BUS_STREAM" 2>/dev/null | tail -n "$limit" | jq -cs '.' 2>/dev/null || echo "[]"
  fi
}

# Legacy aliases (thin wrappers, kept for backward compat)
bus_query_filter() { bus_query --pattern "$(jq -r --arg f "$1" '.filters[$f] // ""' "$BUS_SCHEMA" 2>/dev/null)" --after "${2:-0}" --raw; }
bus_query_advanced() { bus_query "$@"; }

# ── Git backing ──────────────────────────────────────────────────────

bus_git_checkpoint() {
  local msg="${1:-auto: bus checkpoint}"
  local project_root="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

  cd "$project_root" || return 1

  # Stage structural files (not stream.jsonl or dlq)
  git add .claude/bus/schema.json .claude/bus/seq.json .claude/bus/cursors/ 2>/dev/null || true
  git add .claude/harness/*/tasks.json .claude/harness/*/proposals.jsonl 2>/dev/null || true
  git add .claude/harness/*/agents/sidecar/config.json .claude/harness/*/agents/sidecar/state.json 2>/dev/null || true
  git add .claude/harness/*/agents/sidecar/mission.md .claude/harness/*/agents/sidecar/MEMORY.md 2>/dev/null || true
  git add .claude/harness/*/acceptance.md 2>/dev/null || true

  if ! git diff --cached --quiet 2>/dev/null; then
    git commit -m "$msg" --no-gpg-sign 2>/dev/null || true
  fi
}

bus_compact() {
  # Compact stream: keep only events after lowest consumer cursor.
  # Safety margin: 100 events before lowest cursor.
  [ ! -f "$BUS_STREAM" ] && return 0

  local min_seq=999999999 found_consumer="false"
  for cursor_file in "$BUS_CURSORS_DIR"/*.json; do
    [ -f "$cursor_file" ] || continue
    local seq
    seq=$(jq -r '.seq // 0' "$cursor_file" 2>/dev/null || echo "0")
    [ "$seq" = "0" ] && continue
    found_consumer="true"
    [ "$seq" -lt "$min_seq" ] 2>/dev/null && min_seq="$seq"
  done

  [ "$found_consumer" = "false" ] && return 0

  local keep_after=$((min_seq - 100))
  [ "$keep_after" -lt 0 ] && keep_after=0

  local tmp="${BUS_STREAM}.compact.$$"
  jq -c --argjson seq "$keep_after" 'select(._seq > $seq)' "$BUS_STREAM" > "$tmp" 2>/dev/null
  mv "$tmp" "$BUS_STREAM"
}

# ── Convenience aliases (thin wrappers) ──────────────────────────────
bus_publish_deploy() { bus_publish "deploy" "{\"agent\":\"$1\",\"service\":\"$2\",\"target\":\"$3\"}"; }
bus_publish_announcement() { bus_publish "announcement" "{\"from\":\"$1\",\"body\":$(echo "$2" | jq -Rs '.'),\"priority\":\"${3:-normal}\"}"; }
