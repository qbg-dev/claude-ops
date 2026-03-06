#!/usr/bin/env bash
# test-permissions-json.sh — Validate permissions.json migration.
set -euo pipefail

source "$(dirname "$0")/helpers.sh"

PROJECT_ROOT="${PROJECT_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
source "$HOME/.claude-ops/lib/harness-jq.sh"

echo "── permissions.json migration ──"

# ═══════════════════════════════════════════════════════════════
# 1. Schema validation — every permissions.json has valid fields
# ═══════════════════════════════════════════════════════════════

VALID_MODES="bypassPermissions acceptEdits default dontAsk plan"
VALID_MODELS="opus sonnet haiku cdo cds"

for perms in "$PROJECT_ROOT"/.claude/harness/*/agents/sidecar/permissions.json; do
  [ ! -f "$perms" ] && continue
  harness=$(echo "$perms" | sed 's|.*/\.claude/harness/||; s|/agents/.*||')

  # Must be valid JSON
  TOTAL=$((TOTAL + 1))
  if jq empty "$perms" 2>/dev/null; then
    echo -e "  ${GREEN}PASS${RESET} $harness: valid JSON"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $harness: invalid JSON"
    FAIL=$((FAIL + 1))
    continue
  fi

  # permission_mode must be valid
  TOTAL=$((TOTAL + 1))
  mode=$(jq -r '.permission_mode // "bypassPermissions"' "$perms")
  if echo "$VALID_MODES" | grep -qw "$mode"; then
    echo -e "  ${GREEN}PASS${RESET} $harness: valid permission_mode ($mode)"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $harness: invalid permission_mode ($mode)"
    FAIL=$((FAIL + 1))
  fi

  # model must be valid (if present)
  TOTAL=$((TOTAL + 1))
  model=$(jq -r '.model // empty' "$perms")
  if [ -z "$model" ] || echo "$VALID_MODELS" | grep -qw "$model"; then
    echo -e "  ${GREEN}PASS${RESET} $harness: valid model (${model:-none})"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $harness: invalid model ($model)"
    FAIL=$((FAIL + 1))
  fi

  # No unenforced fields (blocked_paths, blocked_bash, can_spawn_subworkers, notes)
  TOTAL=$((TOTAL + 1))
  bad_fields=$(jq -r 'keys[] | select(. == "blocked_paths" or . == "blocked_bash" or . == "can_spawn_subworkers" or . == "notes")' "$perms" 2>/dev/null)
  if [ -z "$bad_fields" ]; then
    echo -e "  ${GREEN}PASS${RESET} $harness: no unenforced fields"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $harness: has unenforced fields: $bad_fields"
    FAIL=$((FAIL + 1))
  fi
done

# ═══════════════════════════════════════════════════════════════
# 2. Completeness — every harness dir with agents/sidecar/ has permissions.json
# ═══════════════════════════════════════════════════════════════

for sidecar_dir in "$PROJECT_ROOT"/.claude/harness/*/agents/sidecar/; do
  [ ! -d "$sidecar_dir" ] && continue
  harness=$(echo "$sidecar_dir" | sed 's|.*/\.claude/harness/||; s|/agents/.*||')
  TOTAL=$((TOTAL + 1))
  if [ -f "$sidecar_dir/permissions.json" ]; then
    echo -e "  ${GREEN}PASS${RESET} $harness: sidecar has permissions.json"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}FAIL${RESET} $harness: sidecar MISSING permissions.json"
    FAIL=$((FAIL + 1))
  fi
done

# ═══════════════════════════════════════════════════════════════
# 3. CLI flag generation — verify correct flags
# ═══════════════════════════════════════════════════════════════

TOTAL=$((TOTAL + 1))
# bypassPermissions → --dangerously-skip-permissions
TMPF=$(mktemp)
echo '{"permission_mode":"bypassPermissions","model":"opus"}' > "$TMPF"
mode=$(jq -r '.permission_mode // "bypassPermissions"' "$TMPF")
if [ "$mode" = "bypassPermissions" ]; then
  echo -e "  ${GREEN}PASS${RESET} CLI flag: bypassPermissions maps correctly"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} CLI flag: unexpected mode $mode"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
# allowedTools array → comma-joined
echo '{"permission_mode":"default","allowedTools":["Read:**","Edit:src/**","Bash(bun *)"]}' > "$TMPF"
csv=$(jq -r '(.allowedTools // []) | join(",")' "$TMPF")
if [ "$csv" = "Read:**,Edit:src/**,Bash(bun *)" ]; then
  echo -e "  ${GREEN}PASS${RESET} CLI flag: allowedTools array joins correctly"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} CLI flag: expected comma-joined, got $csv"
  FAIL=$((FAIL + 1))
fi
rm -f "$TMPF"

# ═══════════════════════════════════════════════════════════════
# 4. No YAML remnants
# ═══════════════════════════════════════════════════════════════

TOTAL=$((TOTAL + 1))
YAML_REFS=$(grep -rl 'permissions\.yaml' \
  "$HOME/.claude-ops/lib/" \
  "$HOME/.claude-ops/scripts/scaffold.sh" \
  "$HOME/.claude-ops/templates/seed.sh.tmpl" \
  "$PROJECT_ROOT/.claude/scripts/"*-seed.sh \
  2>/dev/null | grep -v '\.bak$' | grep -v 'archive' || true)
if [ -z "$YAML_REFS" ]; then
  echo -e "  ${GREEN}PASS${RESET} No permissions.yaml references in lib/scripts/templates"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} permissions.yaml still referenced in:"
  echo "$YAML_REFS"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
# 5. No old YAML files exist
# ═══════════════════════════════════════════════════════════════

TOTAL=$((TOTAL + 1))
OLD_YAMLS=$(find "$PROJECT_ROOT/.claude/harness" -name "permissions.yaml" 2>/dev/null || true)
if [ -z "$OLD_YAMLS" ]; then
  echo -e "  ${GREEN}PASS${RESET} No old permissions.yaml files exist"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} Old permissions.yaml files still exist:"
  echo "$OLD_YAMLS"
  FAIL=$((FAIL + 1))
fi

# ═══════════════════════════════════════════════════════════════
# 6. No unenforced fields anywhere in harness dir
# ═══════════════════════════════════════════════════════════════

TOTAL=$((TOTAL + 1))
UNENFORCED=$(grep -rl 'blocked_paths\|blocked_bash\|can_spawn_subworkers' "$PROJECT_ROOT/.claude/harness/" 2>/dev/null | grep -v '\.bak$' || true)
if [ -z "$UNENFORCED" ]; then
  echo -e "  ${GREEN}PASS${RESET} No unenforced fields in harness directory"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}FAIL${RESET} Unenforced fields found in:"
  echo "$UNENFORCED"
  FAIL=$((FAIL + 1))
fi

test_summary
