#!/usr/bin/env bash
# harness-jq.sh — Compatibility shim.
# All functions (harness_session_dir, pane_registry_update, locked_jq_write, etc.)
# now live in fleet-jq.sh. This file simply sources it for backwards compatibility.
source "$(dirname "${BASH_SOURCE[0]}")/fleet-jq.sh"
