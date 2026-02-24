#!/usr/bin/env bash
# ══════════════════════════════════════════════════════════════════
# sweep-config.sh — Read sweep configuration from JSON config files
# ══════════════════════════════════════════════════════════════════
# Each sweep has a config at ~/.claude-ops/sweeps.d/permissions/{name}.json
# that defines: interval, scope, model, description, tools, allowedTools.
#
# Usage (source in sweep scripts):
#   source "$HOME/.claude-ops/lib/sweep-config.sh"
#   load_sweep_config "dead-agent-detector"
#   # Now SWEEP_INTERVAL, SWEEP_SCOPE, SWEEP_MODEL, SWEEP_DESCRIPTION are set
# ══════════════════════════════════════════════════════════════════

SWEEP_CONFIG_DIR="${HOME}/.claude-ops/sweeps.d/permissions"

# load_sweep_config <sweep-name>
# Sets: SWEEP_INTERVAL, SWEEP_SCOPE, SWEEP_MODEL, SWEEP_DESCRIPTION
load_sweep_config() {
  local name="$1"
  local config_file="${SWEEP_CONFIG_DIR}/${name}.json"

  if [ ! -f "$config_file" ]; then
    echo "WARN: No config at $config_file — using defaults" >&2
    SWEEP_INTERVAL=3600
    SWEEP_SCOPE="global"
    SWEEP_MODEL="sonnet"
    SWEEP_DESCRIPTION=""
    return 1
  fi

  SWEEP_INTERVAL=$(jq -r '.interval // 3600' "$config_file")
  SWEEP_SCOPE=$(jq -r '.scope // "global"' "$config_file")
  SWEEP_MODEL=$(jq -r '.model // "sonnet"' "$config_file")
  SWEEP_DESCRIPTION=$(jq -r '.description // ""' "$config_file")
  return 0
}
