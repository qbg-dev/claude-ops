#!/usr/bin/env bash
# test-spawn-sweep.sh — Tests for spawn-sweep-agent.sh allowedTools enforcement
set -uo pipefail
source "$(dirname "$0")/helpers.sh"

echo "── spawn-sweep-agent allowedTools tests ──"

TMPDIR_TEST=$(mktemp -d)
trap 'rm -rf "$TMPDIR_TEST"' EXIT

# Source the script to get access to the functions
export SPAWN_SWEEP_PERMISSIONS_DIR="$TMPDIR_TEST/permissions"
mkdir -p "$SPAWN_SWEEP_PERMISSIONS_DIR"

# ── Test: reads manifest model ──
cat > "$SPAWN_SWEEP_PERMISSIONS_DIR/test-sweep.json" <<'EOF'
{
  "model": "haiku",
  "tools": ["Read", "Grep"],
  "allowedTools": ["Read", "Grep(**/*.ts)"]
}
EOF

MODEL=$(jq -r '.model // "sonnet"' "$SPAWN_SWEEP_PERMISSIONS_DIR/test-sweep.json")
assert_equals "reads model from manifest" "haiku" "$MODEL"

# ── Test: builds comma-separated allowedTools ──
ALLOWED_CSV=$(jq -r '.allowedTools // [] | join(",")' "$SPAWN_SWEEP_PERMISSIONS_DIR/test-sweep.json")
assert_equals "builds comma-separated allowedTools" "Read,Grep(**/*.ts)" "$ALLOWED_CSV"

# ── Test: tools are comma-separated ──
TOOLS_CSV=$(jq -r '.tools // [] | join(",")' "$SPAWN_SWEEP_PERMISSIONS_DIR/test-sweep.json")
assert_equals "tools are comma-separated" "Read,Grep" "$TOOLS_CSV"

# ── Test: empty allowedTools produces empty string ──
cat > "$SPAWN_SWEEP_PERMISSIONS_DIR/no-allowed.json" <<'EOF'
{
  "model": "sonnet",
  "tools": ["Read"],
  "allowedTools": []
}
EOF
EMPTY_ALLOWED=$(jq -r '.allowedTools // [] | join(",")' "$SPAWN_SWEEP_PERMISSIONS_DIR/no-allowed.json")
assert_equals "empty allowedTools produces empty" "" "$EMPTY_ALLOWED"

# ── Test: missing allowedTools produces empty string ──
cat > "$SPAWN_SWEEP_PERMISSIONS_DIR/missing-allowed.json" <<'EOF'
{
  "model": "sonnet",
  "tools": ["Read"]
}
EOF
MISSING_ALLOWED=$(jq -r '.allowedTools // [] | join(",")' "$SPAWN_SWEEP_PERMISSIONS_DIR/missing-allowed.json")
assert_equals "missing allowedTools produces empty" "" "$MISSING_ALLOWED"

# ── Test: permission mode defaults to "default" (no bypassPermissions) ──
SPAWN_SWEEP_PERMISSION_MODE=default
allowed_csv="Read,Edit(**/CLAUDE.md)"
permission_mode="$SPAWN_SWEEP_PERMISSION_MODE"
assert_equals "permission mode is default" "default" "$permission_mode"

# ── Test: missing manifest returns error (no fallback to bypassPermissions) ──
# Simulate spawn_sweep_agent refusing to start without manifest
MISS_ERR=$(source "$HOME/.claude-ops/lib/spawn-sweep-agent.sh" 2>/dev/null; SPAWN_SWEEP_PERMISSIONS_DIR="$TMPDIR_TEST/permissions"; spawn_sweep_agent "nonexistent-sweep" "/tmp" "/dev/null" 2>&1 || true)
assert "missing manifest returns error" "ERROR" "$MISS_ERR"

# ── Test: config no longer has bypassPermissions as default ──
BYPASS_COUNT=$(grep -c "SPAWN_SWEEP_PERMISSION_MODE=bypassPermissions" "$HOME/.claude-ops/control-plane.conf" || true)
assert_equals "no bypassPermissions in config" "0" "$BYPASS_COUNT"

# ── Test: config has METRICS_MAX_SIZE_BYTES ──
assert_file_contains "config has METRICS_MAX_SIZE_BYTES" \
  "$HOME/.claude-ops/control-plane.conf" "METRICS_MAX_SIZE_BYTES"

# ── Test: config has SWEEP_LOG_MAX_SIZE_BYTES ──
assert_file_contains "config has SWEEP_LOG_MAX_SIZE_BYTES" \
  "$HOME/.claude-ops/control-plane.conf" "SWEEP_LOG_MAX_SIZE_BYTES"

test_summary
