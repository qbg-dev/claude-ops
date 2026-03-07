#!/usr/bin/env bash
# lint-hooks.sh — Verify all hooks from manifest.json are correctly installed.
#
# Usage:
#   bash ~/.claude-ops/scripts/lint-hooks.sh          # Full lint
#   bash ~/.claude-ops/scripts/lint-hooks.sh --fix     # Auto-fix by running setup-hooks.sh
#   bash ~/.claude-ops/scripts/lint-hooks.sh --quiet    # Exit code only (0=ok, 1=issues)
#
# Checks:
#   1. All required hook scripts exist and are executable
#   2. settings.json has all required hooks registered
#   3. No stale hooks in settings.json (pointing to missing files)
#   4. Hook order matches manifest (important for gates that depend on prior hooks)
set -euo pipefail

CLAUDE_OPS_DIR="${CLAUDE_OPS_DIR:-$HOME/.claude-ops}"
MANIFEST="$CLAUDE_OPS_DIR/hooks/manifest.json"
SETTINGS="$HOME/.claude/settings.json"

QUIET=false
FIX=false

for arg in "$@"; do
  case "$arg" in
    --quiet|-q) QUIET=true ;;
    --fix)      FIX=true ;;
    --help|-h)
      echo "Usage: lint-hooks.sh [--quiet] [--fix]"
      exit 0
      ;;
  esac
done

# Colors
if [[ -t 1 ]] && [ "$QUIET" = false ]; then
  G='\033[0;32m'; Y='\033[1;33m'; R='\033[0;31m'; N='\033[0m'
else
  G=''; Y=''; R=''; N=''
fi
ok()   { [ "$QUIET" = false ] && echo -e "  ${G}OK${N}  $*" || true; }
warn() { [ "$QUIET" = false ] && echo -e "  ${Y}WARN${N} $*" || true; }
fail() { [ "$QUIET" = false ] && echo -e "  ${R}FAIL${N} $*" || true; }
info() { [ "$QUIET" = false ] && echo -e "$*" || true; }

_errors=0
_warnings=0
# Redirect for python output in quiet mode
_qr="/dev/stdout"
[ "$QUIET" = true ] && _qr="/dev/null"

# ── Check 1: Manifest exists ──
if [ ! -f "$MANIFEST" ]; then
  fail "Manifest not found: $MANIFEST"
  exit 1
fi

# ── Check 2: Settings exists ──
if [ ! -f "$SETTINGS" ]; then
  fail "Settings not found: $SETTINGS"
  (( _errors++ ))
fi

info ""
info "Hook Lint Report"
info "================"
info ""

# ── Check 3: Hook files exist and are executable ──
info "Hook Files:"
python3 -c "
import json, os, sys, stat

manifest = json.load(open('$MANIFEST'))
errors = 0
warnings = 0

for h in manifest['hooks']:
    path = h['path'].replace('~/', os.path.expanduser('~') + '/')
    # Skip project-specific (path contains {PROJECT_ROOT})
    if '{PROJECT_ROOT}' in path:
        print(f'  SKIP {h[\"id\"]:30s} (project-specific)')
        continue

    exists = os.path.isfile(path)
    executable = exists and os.access(path, os.X_OK)
    required = h.get('required', False)
    tag = 'REQ' if required else 'OPT'

    if not exists:
        if required:
            print(f'  FAIL {h[\"id\"]:30s} [{tag}] file missing: {path}')
            errors += 1
        else:
            print(f'  WARN {h[\"id\"]:30s} [{tag}] file missing: {path}')
            warnings += 1
    elif not executable and h['path'].endswith('.sh'):
        print(f'  WARN {h[\"id\"]:30s} [{tag}] not executable: {path}')
        warnings += 1
    else:
        print(f'  OK   {h[\"id\"]:30s} [{tag}]')

# Write counts to temp file for bash to read
with open('/tmp/lint-hooks-counts.txt', 'w') as f:
    f.write(f'{errors} {warnings}')
" > "$_qr" 2>&1
_file_counts=$(cat /tmp/lint-hooks-counts.txt 2>/dev/null || echo "0 0")
_errors=$(( _errors + $(echo "$_file_counts" | cut -d' ' -f1) ))
_warnings=$(( _warnings + $(echo "$_file_counts" | cut -d' ' -f2) ))

info ""

# ── Check 4: Hooks registered in settings.json ──
if [ -f "$SETTINGS" ]; then
  info "Settings Registration:"
  python3 -c "
import json, os, sys

manifest = json.load(open('$MANIFEST'))
settings = json.load(open('$SETTINGS'))
settings_hooks = settings.get('hooks', {})
errors = 0
warnings = 0

# Build lookup: command substring -> hook id
for h in manifest['hooks']:
    if h.get('category') == 'project':
        continue

    path = h['path'].replace('~/', os.path.expanduser('~') + '/')
    # Check if this hook appears in settings
    event = h['event']
    event_hooks = settings_hooks.get(event, [])

    found = False
    for entry in event_hooks:
        for hook_def in entry.get('hooks', []):
            cmd = hook_def.get('command', '')
            # Match by path substring (handles bash/python3 prefix + ~ expansion)
            basename = os.path.basename(path)
            if basename in cmd:
                found = True
                break
        if found:
            break

    required = h.get('required', False)
    tag = 'REQ' if required else 'OPT'

    if not found:
        if required:
            print(f'  FAIL {h[\"id\"]:30s} [{tag}] not in settings.json ({event})')
            errors += 1
        else:
            print(f'  WARN {h[\"id\"]:30s} [{tag}] not in settings.json ({event})')
            warnings += 1
    else:
        print(f'  OK   {h[\"id\"]:30s} [{tag}] registered in {event}')

with open('/tmp/lint-hooks-counts.txt', 'w') as f:
    f.write(f'{errors} {warnings}')
" > "$_qr" 2>&1
  _reg_counts=$(cat /tmp/lint-hooks-counts.txt 2>/dev/null || echo "0 0")
  _errors=$(( _errors + $(echo "$_reg_counts" | cut -d' ' -f1) ))
  _warnings=$(( _warnings + $(echo "$_reg_counts" | cut -d' ' -f2) ))

  info ""

  # ── Check 5: Stale hooks in settings (pointing to missing files) ──
  info "Stale Hook Check:"
  python3 -c "
import json, os, sys, re

settings = json.load(open('$SETTINGS'))
hooks = settings.get('hooks', {})
stale = 0

for event, entries in hooks.items():
    for entry in entries:
        for hook_def in entry.get('hooks', []):
            cmd = hook_def.get('command', '')
            # Extract path from command (after bash/python3 prefix)
            parts = cmd.split(None, 1)
            if len(parts) < 2:
                continue
            path = parts[-1].strip()
            path = path.replace('~/', os.path.expanduser('~') + '/')
            if not os.path.isfile(path):
                print(f'  WARN stale hook in {event}: {cmd}')
                stale += 1

if stale == 0:
    print(f'  OK   No stale hooks found')
with open('/tmp/lint-hooks-stale.txt', 'w') as f:
    f.write(str(stale))
" > "$_qr" 2>&1
  _stale=$(cat /tmp/lint-hooks-stale.txt 2>/dev/null || echo "0")
  _warnings=$(( _warnings + _stale ))
fi

info ""

# ── Check 6: Runtime dependencies ──
info "Runtime Dependencies:"
_dep_warnings=0
for cmd in jq python3 git tmux; do
  if command -v "$cmd" &>/dev/null; then
    ok "  $cmd available"
  else
    fail "  $cmd MISSING — required by multiple hooks"
    (( _errors++ ))
  fi
done
for cmd in bun node; do
  if command -v "$cmd" &>/dev/null; then
    ok "  $cmd available"
  else
    warn "  $cmd not found — needed for MCP servers"
    (( _warnings++ ))
  fi
done

info ""

# ── Check 7: Source chain (libraries referenced by hooks) ──
info "Library Dependencies:"
_lib_files=(
  "$CLAUDE_OPS_DIR/lib/fleet-jq.sh"
  "$CLAUDE_OPS_DIR/lib/event-bus.sh"
  "$CLAUDE_OPS_DIR/lib/pane-resolve.sh"
)
for f in "${_lib_files[@]}"; do
  if [ -f "$f" ]; then
    ok "  $(basename "$f")"
  else
    fail "  $(basename "$f") MISSING — hooks will fail at runtime"
    (( _errors++ ))
  fi
done

info ""

# ── Check 8: MCP server registration ──
if [ -f "$SETTINGS" ]; then
  info "MCP Server Registration:"
  for srv in worker-fleet check-your-work; do
    if jq -e ".mcpServers.\"$srv\"" "$SETTINGS" &>/dev/null; then
      ok "  $srv registered"
    else
      warn "  $srv not registered in settings.json"
      (( _warnings++ ))
    fi
  done
  info ""
fi

# ── Check 9: Stop-check integration ──
info "Stop-Check Integration:"
_sc_hook="$CLAUDE_OPS_DIR/hooks/gates/stop-worker-dispatch.sh"
if [ -f "$_sc_hook" ] && grep -q 'stop-checks' "$_sc_hook"; then
  ok "  stop-worker-dispatch.sh reads stop-check files"
else
  warn "  stop-worker-dispatch.sh missing stop-check gate"
  (( _warnings++ ))
fi
_sc_mcp="$CLAUDE_OPS_DIR/mcp/worker-fleet/index.ts"
if [ -f "$_sc_mcp" ] && grep -q 'add_stop_check' "$_sc_mcp"; then
  ok "  worker-fleet MCP defines add_stop_check"
else
  warn "  worker-fleet MCP missing add_stop_check tool"
  (( _warnings++ ))
fi
if [ -f "$_sc_mcp" ] && grep -q '_persistStopChecks' "$_sc_mcp"; then
  ok "  stop checks persist to file for hook enforcement"
else
  warn "  stop checks not persisted — hook enforcement won't work"
  (( _warnings++ ))
fi

info ""

# ── Summary ──
if [ "$_errors" -eq 0 ] && [ "$_warnings" -eq 0 ]; then
  info "${G}All hooks OK${N}"
elif [ "$_errors" -eq 0 ]; then
  info "${Y}$_warnings warning(s), 0 errors${N}"
else
  info "${R}$_errors error(s), $_warnings warning(s)${N}"
  info ""
  if [ "$FIX" = true ]; then
    info "Running setup-hooks.sh to fix..."
    bash "$CLAUDE_OPS_DIR/scripts/setup-hooks.sh"
  else
    info "Run with --fix to auto-install, or:"
    info "  bash ~/.claude-ops/scripts/setup-hooks.sh"
  fi
fi

# Cleanup
rm -f /tmp/lint-hooks-counts.txt /tmp/lint-hooks-stale.txt

[ "$_errors" -gt 0 ] && exit 1
exit 0
