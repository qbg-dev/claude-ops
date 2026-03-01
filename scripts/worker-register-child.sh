#!/usr/bin/env bash
# worker-register-child.sh — Register a child pane with its parent in pane-registry.
#
# Usage: worker-register-child.sh <child_pane_id> <parent_pane_id>
#
# The child pane inherits the parent's harness identifier, so tool-policy-gate.sh
# enforces the same disallowedTools without needing its own permissions.json.
# The watchdog skips crash recovery for child panes (they are ephemeral).
#
# Example:
#   bash worker-register-child.sh %650 %612
#   Registered %650 as child of %612 (harness: worker/chatbot-tools)
set -uo pipefail

CHILD="${1:-}"
PARENT="${2:-}"

[ -z "$CHILD" ] || [ -z "$PARENT" ] && {
  echo "Usage: worker-register-child.sh <child_pane_id> <parent_pane_id>" >&2
  exit 1
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="$(dirname "$SCRIPT_DIR")/lib"
source "$LIB_DIR/harness-jq.sh"

# Read parent entry
PARENT_ENTRY=$(pane_registry_read "$PARENT")
PARENT_HARNESS=$(echo "$PARENT_ENTRY" | jq -r '.harness // empty')

[ -z "$PARENT_HARNESS" ] && {
  echo "ERROR: parent pane $PARENT not found in pane-registry" >&2
  exit 1
}

# Compute pane_target for child
PANE_TARGET=$(hook_pane_target "$CHILD" 2>/dev/null || echo "")

pane_registry_set_parent "$CHILD" "$PARENT" "$PARENT_HARNESS" "$PANE_TARGET"
echo "Registered $CHILD as child of $PARENT (harness: $PARENT_HARNESS)"
