#!/usr/bin/env bash
# fleet — Worker fleet management CLI
#
# Single CLI for managing worker agents. Replaces launch-flat-worker.sh,
# fork-worker.sh, and manual registry operations.
#
# Usage: fleet <command> [args] [flags]
#
# Commands:
#   create <name> "<mission>"       Create + launch worker (full lifecycle)
#   start  <name>                   Start/restart existing worker (runs launch.sh)
#   stop   <name>                   Graceful stop (send /stop, wait, update state)
#   ls                              List all workers (name, status, model, pane, window)
#   config <name> [key] [value]     Get/set worker config (regenerates launch.sh)
#   defaults [key] [value]          Get/set global defaults
#   log    <name>                   Tail worker's tmux pane output
#   mail   <name>                   Check worker's Fleet Mail inbox
#   fork   <parent> <child> "<mission>"  Fork from existing session
#   help                            Show this help

set -euo pipefail

VERSION="1.0.0"

# ─── Directories ───
# CLAUDE_FLEET_DIR = infrastructure (scripts, hooks, MCP, templates)
# FLEET_DATA_DIR   = data (per-project worker configs, states)
CLAUDE_FLEET_DIR="${CLAUDE_FLEET_DIR:-${CLAUDE_OPS_DIR:-$HOME/.claude-fleet}}"
FLEET_DATA_DIR="$HOME/.claude/fleet"
FLEET_MAIL_URL="${FLEET_MAIL_URL:-http://127.0.0.1:8025}"
DEFAULT_SESSION="w"

# ─── Dependencies ───
if [ -f "$CLAUDE_FLEET_DIR/lib/resolve-deps.sh" ]; then
  source "$CLAUDE_FLEET_DIR/lib/resolve-deps.sh"
else
  # Minimal fallback if resolve-deps.sh is missing (e.g., during setup)
  BUN=$(command -v bun 2>/dev/null || echo "")
  JQ=$(command -v jq 2>/dev/null || echo "")
  TMUX_BIN=$(command -v tmux 2>/dev/null || echo "")
fi

# ─── Colors (disabled if not a tty) ───
if [ -t 1 ]; then
  RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'
  CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; CYAN=''; BOLD=''; DIM=''; NC=''
fi

# ─── Helpers ───
die()     { echo -e "${RED}ERROR: $1${NC}" >&2; exit 1; }
info()    { echo -e "${CYAN}→${NC} $1"; }
success() { echo -e "${GREEN}✓${NC} $1"; }
warn()    { echo -e "${YELLOW}⚠${NC} $1"; }

validate_name() {
  local name="$1"
  [[ "$name" =~ ^[a-z][a-z0-9]*(-[a-z0-9]+)*$ ]] || \
    die "Name must be kebab-case (lowercase, hyphens, starts with letter): $name"
}

resolve_project() {
  # From cwd or given root, strip worktree suffix to get project name
  local root="${1:-}"
  if [ -z "$root" ]; then
    root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  fi
  basename "$root" | sed 's/-w-.*$//'
}

resolve_project_root() {
  local root
  root=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
  # If in a worktree, resolve to the main repo
  if [ -f "$root/.git" ]; then
    root=$(sed 's|gitdir: ||; s|/\.git/worktrees/.*||' "$root/.git" 2>/dev/null || echo "$root")
  fi
  echo "$root"
}

get_defaults() {
  local defaults_file="$FLEET_DATA_DIR/defaults.json"
  if [ -f "$defaults_file" ]; then
    cat "$defaults_file"
  else
    echo '{"model":"opus","effort":"high","permission_mode":"bypassPermissions","sleep_duration":null}'
  fi
}

get_system_hooks() {
  cat <<'HOOKS_JSON'
[
  {"id":"sys-1","owner":"system","event":"PreToolUse","tool":"Bash","condition":{"command_pattern":"rm\\s+-rf\\s+[/~.]"},"action":"block","message":"Catastrophic rm -rf blocked"},
  {"id":"sys-2","owner":"system","event":"PreToolUse","tool":"Bash","condition":{"command_pattern":"git\\s+reset\\s+--hard"},"action":"block","message":"git reset --hard blocked"},
  {"id":"sys-3","owner":"system","event":"PreToolUse","tool":"Bash","condition":{"command_pattern":"git\\s+clean\\s+-[fd]"},"action":"block","message":"git clean blocked"},
  {"id":"sys-4","owner":"system","event":"PreToolUse","tool":"Bash","condition":{"command_pattern":"git\\s+push.*--force"},"action":"block","message":"Force push blocked"},
  {"id":"sys-5","owner":"system","event":"PreToolUse","tool":"Bash","condition":{"command_pattern":"git\\s+checkout\\s+main\\b"},"action":"block","message":"Workers stay on their branch"},
  {"id":"sys-6","owner":"system","event":"PreToolUse","tool":"Bash","condition":{"command_pattern":"git\\s+merge\\b"},"action":"block","message":"Workers don't merge — use Fleet Mail"},
  {"id":"sys-7","owner":"system","event":"PreToolUse","tool":"Edit","condition":{"file_glob":"**/fleet/**/config.json"},"action":"block","message":"Use update_worker_config tool"},
  {"id":"sys-8","owner":"system","event":"PreToolUse","tool":"Write","condition":{"file_glob":"**/fleet/**/config.json"},"action":"block","message":"Use update_worker_config tool"},
  {"id":"sys-9","owner":"system","event":"PreToolUse","tool":"Edit","condition":{"file_glob":"**/fleet/**/state.json"},"action":"block","message":"Use update_state tool"},
  {"id":"sys-10","owner":"system","event":"PreToolUse","tool":"Write","condition":{"file_glob":"**/fleet/**/state.json"},"action":"block","message":"Use update_state tool"},
  {"id":"sys-11","owner":"system","event":"PreToolUse","tool":"Edit","condition":{"file_glob":"**/fleet/**/token"},"action":"block","message":"Token is auto-provisioned"},
  {"id":"sys-12","owner":"system","event":"PreToolUse","tool":"Write","condition":{"file_glob":"**/fleet/**/token"},"action":"block","message":"Token is auto-provisioned"}
]
HOOKS_JSON
}

generate_launch_sh() {
  local name="$1" project="$2"
  local dir="$FLEET_DATA_DIR/$project/$name"
  local config_file="$dir/config.json"

  [ ! -f "$config_file" ] && die "Config not found: $config_file"

  local model effort perm worktree
  model=$(jq -r '.model // "opus"' "$config_file")
  effort=$(jq -r '.reasoning_effort // "high"' "$config_file")
  perm=$(jq -r '.permission_mode // "bypassPermissions"' "$config_file")
  worktree=$(jq -r '.worktree // ""' "$config_file")

  local perm_flag
  if [ "$perm" = "bypassPermissions" ]; then
    perm_flag="--dangerously-skip-permissions"
  else
    perm_flag="--permission-mode $perm"
  fi

  cat > "$dir/launch.sh" <<EOF
#!/bin/bash
# Auto-generated by fleet — restart command for $name
# Regenerated on config changes. Do not edit manually.
cd "$worktree"
CLAUDE_CODE_SKIP_PROJECT_LOCK=1 \\
WORKER_NAME=$name \\
exec claude \\
  --model $model \\
  --effort $effort \\
  $perm_flag \\
  --add-dir $dir
EOF
  chmod +x "$dir/launch.sh"
}

# ─── _update_registry: backward-compat write to registry.json ───
_update_registry() {
  local name="$1" project="$2" pane_id="$3" pane_target="$4" session="$5"
  local registry="$FLEET_DATA_DIR/$project/registry.json"
  [ ! -f "$registry" ] && return 0

  local config="$FLEET_DATA_DIR/$project/$name/config.json"
  [ ! -f "$config" ] && return 0

  local model worktree branch perm window
  model=$(jq -r '.model // "opus"' "$config" 2>/dev/null)
  worktree=$(jq -r '.worktree // ""' "$config" 2>/dev/null)
  branch=$(jq -r '.branch // ""' "$config" 2>/dev/null)
  perm=$(jq -r '.permission_mode // ""' "$config" 2>/dev/null)
  window=$(jq -r '.window // ""' "$config" 2>/dev/null)

  local tmp="${registry}.fleet.$$"
  jq --arg name "$name" --arg pid "$pane_id" --arg target "$pane_target" \
    --arg sess "$session" --arg branch "$branch" \
    --arg wt "$worktree" --arg model "$model" --arg perm "$perm" \
    --arg win "$window" \
    '.[$name] = (.[$name] // {}) |
     .[$name].pane_id = $pid |
     .[$name].pane_target = $target |
     .[$name].tmux_session = $sess |
     .[$name].branch = $branch |
     .[$name].worktree = $wt |
     .[$name].window = $win |
     .[$name].model = $model |
     .[$name].permission_mode = $perm |
     .[$name].status = "active"' \
    "$registry" > "$tmp" 2>/dev/null && mv "$tmp" "$registry" || rm -f "$tmp"
}

# ═══════════════════════════════════════════════════════════════════════
# fleet create <name> "<mission>" [flags]
# ═══════════════════════════════════════════════════════════════════════
fleet_create() {
  local name="" mission=""
  local opt_model="" opt_effort="" opt_perm="" opt_window="" opt_window_index=""
  local opt_project="" opt_type="" opt_no_launch=false opt_json=false

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model)           opt_model="$2"; shift 2 ;;
      --effort)          opt_effort="$2"; shift 2 ;;
      --permission-mode) opt_perm="$2"; shift 2 ;;
      --window)          opt_window="$2"; shift 2 ;;
      --window-index)    opt_window_index="$2"; shift 2 ;;
      --project)         opt_project="$2"; shift 2 ;;
      --type)            opt_type="$2"; shift 2 ;;
      --no-launch)       opt_no_launch=true; shift ;;
      --json)            opt_json=true; shift ;;
      -*)                die "Unknown flag: $1" ;;
      *)
        if [ -z "$name" ]; then
          name="$1"
        elif [ -z "$mission" ]; then
          mission="$1"
        else
          die "Unexpected arg: $1"
        fi
        shift ;;
    esac
  done

  [ -z "$name" ] && die "Usage: fleet create <name> \"<mission>\" [flags]"
  [ -z "$mission" ] && die "Mission required: fleet create $name \"<mission>\""

  validate_name "$name"

  # Resolve project
  local project_root
  project_root=$(resolve_project_root)
  local project="${opt_project:-$(resolve_project "$project_root")}"
  local worker_dir="$FLEET_DATA_DIR/$project/$name"

  # Check uniqueness
  [ -d "$worker_dir" ] && die "Worker '$name' already exists in project '$project'"

  # Resolve config: CLI > type template > defaults > hardcoded
  local defaults
  defaults=$(get_defaults)

  local model="${opt_model:-$(echo "$defaults" | jq -r '.model // "opus"')}"
  local effort="${opt_effort:-$(echo "$defaults" | jq -r '.effort // "high"')}"
  local perm="${opt_perm:-$(echo "$defaults" | jq -r '.permission_mode // "bypassPermissions"')}"
  local sleep_dur="null"

  # Apply type template if specified
  if [ -n "$opt_type" ]; then
    local type_file="$CLAUDE_FLEET_DIR/templates/flat-worker/types/$opt_type/defaults.json"
    if [ -f "$type_file" ]; then
      local type_sleep
      type_sleep=$(jq -r '.sleep_duration // empty' "$type_file" 2>/dev/null)
      [ -n "$type_sleep" ] && sleep_dur="$type_sleep"
    else
      warn "Unknown type: $opt_type (using defaults)"
    fi
  fi

  local window="${opt_window:-$name}"
  local project_basename
  project_basename=$(basename "$project_root" | sed 's/-w-.*$//')
  local worktree_dir
  worktree_dir="$(dirname "$project_root")/${project_basename}-w-${name}"
  local branch="worker/$name"
  local fleet_json="$FLEET_DATA_DIR/$project/fleet.json"
  local tmux_session="$DEFAULT_SESSION"

  # Read tmux_session from fleet.json
  if [ -f "$fleet_json" ]; then
    local _fs
    _fs=$(jq -r '.tmux_session // empty' "$fleet_json" 2>/dev/null)
    [ -n "$_fs" ] && tmux_session="$_fs"
  fi

  info "Creating worker '$name' in project '$project'"

  # 4. Create directory
  mkdir -p "$worker_dir"

  # 5. Write config.json
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local hooks
  hooks=$(get_system_hooks)

  jq -n \
    --arg model "$model" \
    --arg effort "$effort" \
    --arg perm "$perm" \
    --argjson sleep "$sleep_dur" \
    --arg window "$window" \
    --arg worktree "$worktree_dir" \
    --arg branch "$branch" \
    --argjson hooks "$hooks" \
    --arg now "$now" \
    --arg project "$project" \
    '{
      model: $model,
      reasoning_effort: $effort,
      permission_mode: $perm,
      sleep_duration: $sleep,
      window: $window,
      worktree: $worktree,
      branch: $branch,
      mcp: {},
      hooks: $hooks,
      meta: {
        created_at: $now,
        created_by: "fleet-cli",
        forked_from: null,
        project: $project
      }
    }' > "$worker_dir/config.json"

  # 6. Write state.json
  echo '{"status":"idle"}' | jq '.' > "$worker_dir/state.json"

  # 7. Write mission.md
  echo "$mission" > "$worker_dir/mission.md"

  # Symlink mission to legacy missions/ dir
  mkdir -p "$FLEET_DATA_DIR/$project/missions"
  ln -sf "../$name/mission.md" "$FLEET_DATA_DIR/$project/missions/$name.md" 2>/dev/null || true

  success "Config written"

  # 8. Create git worktree
  if [ ! -d "$worktree_dir" ]; then
    info "Creating worktree at $worktree_dir (branch: $branch)"
    git -C "$project_root" worktree add "$worktree_dir" "$branch" 2>/dev/null || \
    git -C "$project_root" worktree add "$worktree_dir" -b "$branch" 2>/dev/null || \
      die "Failed to create worktree"
    success "Worktree created"
  else
    info "Worktree already exists: $worktree_dir"
  fi

  # 9. Symlink .mcp.json
  local mcp_src="$project_root/.mcp.json"
  if [ -f "$mcp_src" ] && [ "$project_root" != "$worktree_dir" ]; then
    rm -f "$worktree_dir/.mcp.json" 2>/dev/null || true
    ln -sf "$mcp_src" "$worktree_dir/.mcp.json"
  fi

  # 10. Symlink untracked files (.env, users.json, etc.)
  for f in .env data/users.json; do
    local src="$project_root/$f"
    local dst="$worktree_dir/$f"
    if [ -f "$src" ] && [ ! -e "$dst" ]; then
      mkdir -p "$(dirname "$dst")"
      ln -sf "$src" "$dst"
    fi
  done

  # Install git hooks in worktree
  local worktree_git_dir
  worktree_git_dir=$(git -C "$worktree_dir" rev-parse --absolute-git-dir 2>/dev/null || echo "")
  if [ -n "$worktree_git_dir" ]; then
    local hooks_dir="$worktree_git_dir/hooks"
    mkdir -p "$hooks_dir"

    local hook_src
    for hook_name in post-commit commit-msg; do
      hook_src="$project_root/.claude/scripts/worker-${hook_name}-hook.sh"
      [ ! -f "$hook_src" ] && hook_src="$CLAUDE_FLEET_DIR/scripts/worker-${hook_name}-hook.sh"
      if [ -f "$hook_src" ]; then
        cp "$hook_src" "$hooks_dir/$hook_name"
        chmod +x "$hooks_dir/$hook_name"
      fi
    done
  fi

  success "Worktree configured"

  # 11. Provision Fleet Mail
  local mail_token=""
  local mail_response
  mail_response=$(curl -sf -X POST "${FLEET_MAIL_URL}/api/accounts" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg n "$name" --arg p "$project" '{name: ($n + "@" + $p)}')" 2>/dev/null || echo "")

  if [ -n "$mail_response" ]; then
    mail_token=$(echo "$mail_response" | jq -r '.token // empty' 2>/dev/null)
  fi

  # 12. Save token
  if [ -n "$mail_token" ]; then
    echo "$mail_token" > "$worker_dir/token"
    success "Fleet Mail provisioned"
  else
    warn "Fleet Mail provisioning failed (worker will use MCP fallback)"
    touch "$worker_dir/token"
  fi

  # 13. Generate launch.sh
  generate_launch_sh "$name" "$project"
  success "launch.sh generated"

  if [ "$opt_no_launch" = true ]; then
    success "Worker '$name' created (--no-launch: skipping tmux launch)"
    echo ""
    echo "  Directory: $worker_dir"
    echo "  Worktree:  $worktree_dir"
    echo "  Branch:    $branch"
    echo ""
    echo "  To launch: fleet start $name"
    return
  fi

  # 14-18. Launch in tmux
  _launch_in_tmux "$name" "$project" "$tmux_session" "$window" "$opt_window_index"
}

# ═══════════════════════════════════════════════════════════════════════
# Internal: Launch worker in tmux pane
# ═══════════════════════════════════════════════════════════════════════
_launch_in_tmux() {
  local name="$1" project="$2" session="$3" window="$4" window_index="${5:-}"
  local dir="$FLEET_DATA_DIR/$project/$name"
  local config_file="$dir/config.json"
  local worktree
  worktree=$(jq -r '.worktree // ""' "$config_file")

  [ -z "$worktree" ] && die "No worktree configured for $name"
  [ ! -d "$worktree" ] && die "Worktree not found: $worktree"

  info "Launching in tmux (session: $session, window: $window)"

  # Ensure tmux session exists
  local created_session=0
  if ! tmux has-session -t "$session" 2>/dev/null; then
    tmux new-session -d -s "$session" -n "$window" -c "$worktree"
    created_session=1
  fi

  # Create or join tmux window
  local worker_pane
  if [ "$created_session" -eq 1 ]; then
    worker_pane=$(tmux list-panes -t "$session" -F '#{pane_id}' | head -1)
    tmux rename-window -t "$session" "$window"
    tmux send-keys -t "$worker_pane" "cd \"$worktree\""
    tmux send-keys -t "$worker_pane" -H 0d
  elif tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$window"; then
    # Window exists — split into it + re-tile
    worker_pane=$(tmux split-window -t "$session:$window" -c "$worktree" -d -P -F '#{pane_id}')
    tmux select-layout -t "$session:$window" tiled
  else
    # Create new window with this group name
    local win_target="$session"
    [ -n "$window_index" ] && win_target="${session}:${window_index}"
    worker_pane=$(tmux new-window -t "$win_target" -n "$window" -c "$worktree" -d -P -F '#{pane_id}')
  fi

  tmux select-pane -T "$name" -t "$worker_pane"

  # Build claude command
  local model effort perm
  model=$(jq -r '.model // "opus"' "$config_file")
  effort=$(jq -r '.reasoning_effort // "high"' "$config_file")
  perm=$(jq -r '.permission_mode // "bypassPermissions"' "$config_file")

  local cmd="CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME=$name claude --model $model --effort $effort"
  if [ "$perm" = "bypassPermissions" ]; then
    cmd="$cmd --dangerously-skip-permissions"
  else
    cmd="$cmd --permission-mode $perm"
  fi
  cmd="$cmd --add-dir $dir"

  tmux send-keys -t "$worker_pane" "$cmd"
  tmux send-keys -t "$worker_pane" -H 0d

  # Wait for TUI ready (poll for prompt, max 60s)
  info "Waiting for Claude TUI..."
  local wait=0
  until tmux capture-pane -t "$worker_pane" -p 2>/dev/null | grep -qE '❯|> $'; do
    sleep 2; wait=$((wait+2))
    [ "$wait" -ge 60 ] && { warn "TUI timeout after 60s, proceeding anyway"; break; }
  done
  sleep 2  # extra settle time

  # Generate + inject seed
  local seed_file="/tmp/worker-${name}-seed.txt"
  WORKER_NAME="$name" PROJECT_ROOT="$worktree" \
    "${BUN:-bun}" -e "
      const { generateSeedContent } = await import('${CLAUDE_FLEET_DIR}/mcp/worker-fleet/index.ts');
      process.stdout.write(generateSeedContent());
    " > "$seed_file" 2>/dev/null || {
    echo "You are worker $name. Read mission.md, then start your next cycle." > "$seed_file"
  }

  local buffer_name="launch-${name}-$$"
  tmux delete-buffer -b "$buffer_name" 2>/dev/null || true
  if ! tmux load-buffer -b "$buffer_name" "$seed_file"; then
    warn "Failed to load seed buffer — worker launched without seed"
    rm -f "$seed_file"
  else
    tmux paste-buffer -b "$buffer_name" -t "$worker_pane" -d
    sleep 4  # large seed pastes need settle time
    tmux send-keys -t "$worker_pane" -H 0d

    # Retry Enter if TUI absorbed it during paste
    sleep 3
    if tmux capture-pane -t "$worker_pane" -p 2>/dev/null | grep -qE '❯'; then
      tmux send-keys -t "$worker_pane" -H 0d
    fi
    rm -f "$seed_file"
  fi

  # Update state.json
  local pane_target
  pane_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
    | awk -v p="$worker_pane" '$1==p{print $2}' 2>/dev/null || echo "")
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Preserve past_sessions if state.json exists with session_id
  local old_session_id=""
  local old_past_sessions="[]"
  if [ -f "$dir/state.json" ]; then
    old_session_id=$(jq -r '.session_id // empty' "$dir/state.json" 2>/dev/null)
    old_past_sessions=$(jq '.past_sessions // []' "$dir/state.json" 2>/dev/null)
  fi

  # If there was a previous session, prepend it to past_sessions
  local new_past_sessions="$old_past_sessions"
  if [ -n "$old_session_id" ]; then
    new_past_sessions=$(echo "$old_past_sessions" | jq --arg s "$old_session_id" '. = [$s] + . | .[0:10]')
  fi

  jq -n \
    --arg status "active" \
    --arg pane_id "$worker_pane" \
    --arg pane_target "$pane_target" \
    --arg session "$session" \
    --arg now "$now" \
    --argjson past_sessions "$new_past_sessions" \
    '{
      status: $status,
      pane_id: $pane_id,
      pane_target: $pane_target,
      tmux_session: $session,
      session_id: "",
      past_sessions: $past_sessions,
      last_relaunch: {at: $now, reason: "fleet-start"},
      relaunch_count: 0,
      cycles_completed: 0,
      last_cycle_at: null,
      custom: {}
    }' > "$dir/state.json"

  # Update registry for backward compat
  _update_registry "$name" "$project" "$worker_pane" "$pane_target" "$session"

  success "Worker '$name' launched in pane $worker_pane (session: $session, window: $window)"
}

# ═══════════════════════════════════════════════════════════════════════
# fleet start <name> [flags]
# ═══════════════════════════════════════════════════════════════════════
fleet_start() {
  local name=""
  local opt_model="" opt_effort="" opt_perm="" opt_window="" opt_window_index=""
  local opt_save=false opt_project=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model)           opt_model="$2"; shift 2 ;;
      --effort)          opt_effort="$2"; shift 2 ;;
      --permission-mode) opt_perm="$2"; shift 2 ;;
      --window)          opt_window="$2"; shift 2 ;;
      --window-index)    opt_window_index="$2"; shift 2 ;;
      --project)         opt_project="$2"; shift 2 ;;
      --save)            opt_save=true; shift ;;
      -*)                die "Unknown flag: $1" ;;
      *)
        [ -z "$name" ] && name="$1" || die "Unexpected arg: $1"
        shift ;;
    esac
  done

  [ -z "$name" ] && die "Usage: fleet start <name> [flags]"

  local project="${opt_project:-$(resolve_project)}"
  local dir="$FLEET_DATA_DIR/$project/$name"

  [ ! -d "$dir" ] && die "Worker '$name' not found in project '$project'"
  [ ! -f "$dir/config.json" ] && die "No config.json for '$name'"

  # Apply overrides (save or temporary)
  local has_overrides=false
  { [ -n "$opt_model" ] || [ -n "$opt_effort" ] || [ -n "$opt_perm" ] || [ -n "$opt_window" ]; } && has_overrides=true

  if [ "$has_overrides" = true ]; then
    local tmp="${dir}/config.json.tmp"
    local updates=""
    [ -n "$opt_model" ]  && updates="$updates | .model = \"$opt_model\""
    [ -n "$opt_effort" ] && updates="$updates | .reasoning_effort = \"$opt_effort\""
    [ -n "$opt_perm" ]   && updates="$updates | .permission_mode = \"$opt_perm\""
    [ -n "$opt_window" ] && updates="$updates | .window = \"$opt_window\""
    updates="${updates# | }"

    if [ "$opt_save" = true ]; then
      info "Saving overrides to config"
      jq "$updates" "$dir/config.json" > "$tmp" && mv "$tmp" "$dir/config.json"
      generate_launch_sh "$name" "$project"
      success "Config updated + launch.sh regenerated"
    else
      # Temporary override: backup, modify, launch, restore
      cp "$dir/config.json" "${dir}/config.json.start-bak"
      jq "$updates" "$dir/config.json" > "$tmp" && mv "$tmp" "$dir/config.json"
    fi
  fi

  local window
  window=$(jq -r '.window // "'"$name"'"' "$dir/config.json")

  local fleet_json="$FLEET_DATA_DIR/$project/fleet.json"
  local session="$DEFAULT_SESSION"
  if [ -f "$fleet_json" ]; then
    local _fs
    _fs=$(jq -r '.tmux_session // empty' "$fleet_json" 2>/dev/null)
    [ -n "$_fs" ] && session="$_fs"
  fi

  _launch_in_tmux "$name" "$project" "$session" "$window" "$opt_window_index"

  # Restore config backup if temporary override
  if [ -f "${dir}/config.json.start-bak" ] && [ "$opt_save" != true ]; then
    mv "${dir}/config.json.start-bak" "$dir/config.json"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# fleet stop <name> [--all]
# ═══════════════════════════════════════════════════════════════════════
fleet_stop() {
  local name="" opt_all=false opt_project=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --all)     opt_all=true; shift ;;
      --project) opt_project="$2"; shift 2 ;;
      -*)        die "Unknown flag: $1" ;;
      *)         [ -z "$name" ] && name="$1" || die "Unexpected: $1"; shift ;;
    esac
  done

  local project="${opt_project:-$(resolve_project)}"

  if [ "$opt_all" = true ]; then
    local project_dir="$FLEET_DATA_DIR/$project"
    [ ! -d "$project_dir" ] && die "Project not found: $project"

    local stopped=0
    for worker_dir in "$project_dir"/*/; do
      [ ! -d "$worker_dir" ] && continue
      local w
      w=$(basename "$worker_dir")
      [[ "$w" == "missions" || "$w" == "_user" || "$w" == "_config" ]] && continue
      [ -f "$worker_dir/state.json" ] || continue

      local status
      status=$(jq -r '.status // "idle"' "$worker_dir/state.json" 2>/dev/null)
      [ "$status" = "active" ] || [ "$status" = "sleeping" ] || continue

      _stop_worker "$w" "$project"
      stopped=$((stopped + 1))
    done

    [ "$stopped" -eq 0 ] && info "No active workers to stop"
    return
  fi

  [ -z "$name" ] && die "Usage: fleet stop <name> [--all]"
  _stop_worker "$name" "$project"
}

_stop_worker() {
  local name="$1" project="$2"
  local dir="$FLEET_DATA_DIR/$project/$name"
  local state_file="$dir/state.json"

  [ ! -f "$state_file" ] && { warn "State not found for '$name'"; return 1; }

  local pane_id
  pane_id=$(jq -r '.pane_id // empty' "$state_file" 2>/dev/null)

  if [ -z "$pane_id" ]; then
    warn "'$name' has no pane — marking idle"
    local tmp="${state_file}.tmp"
    jq '.status = "idle" | .pane_id = null | .pane_target = null' "$state_file" > "$tmp" && \
      mv "$tmp" "$state_file"
    return
  fi

  # Check pane exists
  if ! tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$pane_id"; then
    warn "'$name' pane $pane_id is already gone — marking idle"
    local tmp="${state_file}.tmp"
    jq '.status = "idle" | .pane_id = null | .pane_target = null' "$state_file" > "$tmp" && \
      mv "$tmp" "$state_file"
    return
  fi

  info "Stopping '$name' (pane $pane_id)"

  # Send /stop command
  tmux send-keys -t "$pane_id" "/stop"
  tmux send-keys -t "$pane_id" -H 0d

  # Wait for exit (up to 30s)
  local wait=0
  while tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$pane_id"; do
    # Check if claude has exited (pane shows shell prompt)
    if tmux capture-pane -t "$pane_id" -p 2>/dev/null | tail -5 | grep -qE '^\$|^➜|^❯.*\$|zsh'; then
      break
    fi
    sleep 2; wait=$((wait+2))
    if [ "$wait" -ge 30 ]; then
      warn "Timeout — killing pane"
      tmux kill-pane -t "$pane_id" 2>/dev/null || true
      break
    fi
  done

  # Update state
  local tmp="${state_file}.tmp"
  jq '.status = "idle" | .pane_id = null | .pane_target = null' "$state_file" > "$tmp" && \
    mv "$tmp" "$state_file"

  success "Worker '$name' stopped"
}

# ═══════════════════════════════════════════════════════════════════════
# fleet ls [--json] [--project <name>]
# ═══════════════════════════════════════════════════════════════════════
fleet_ls() {
  local opt_json=false opt_project=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)    opt_json=true; shift ;;
      --project) opt_project="$2"; shift 2 ;;
      -*)        die "Unknown flag: $1" ;;
      *)         die "Unexpected: $1" ;;
    esac
  done

  # Get active tmux panes for liveness check
  local tmux_panes=""
  tmux_panes=$(tmux list-panes -a -F '#{pane_id}' 2>/dev/null || echo "")

  if [ "$opt_json" = true ]; then
    _ls_json "$opt_project" "$tmux_panes"
  else
    _ls_table "$opt_project" "$tmux_panes"
  fi
}

_ls_table() {
  local filter_project="$1" tmux_panes="$2"
  local count=0

  printf "${BOLD}%-20s %-10s %-8s %-8s %-14s %-28s${NC}\n" \
    "NAME" "STATUS" "MODEL" "PANE" "WINDOW" "BRANCH"
  printf "%-20s %-10s %-8s %-8s %-14s %-28s\n" \
    "────────────────────" "──────────" "────────" "────────" "──────────────" "────────────────────────────"

  for project_dir in "$FLEET_DATA_DIR"/*/; do
    [ ! -d "$project_dir" ] && continue
    local project
    project=$(basename "$project_dir")
    [ -n "$filter_project" ] && [ "$project" != "$filter_project" ] && continue

    for worker_dir in "$project_dir"/*/; do
      [ ! -d "$worker_dir" ] && continue
      local w
      w=$(basename "$worker_dir")
      [[ "$w" == "missions" || "$w" == "_user" || "$w" == "_config" ]] && continue
      [ -f "$worker_dir/state.json" ] || continue
      [ -f "$worker_dir/config.json" ] || continue

      local status model pane_id window branch
      status=$(jq -r '.status // "unknown"' "$worker_dir/state.json" 2>/dev/null)
      pane_id=$(jq -r '.pane_id // "-"' "$worker_dir/state.json" 2>/dev/null)
      model=$(jq -r '.model // "-"' "$worker_dir/config.json" 2>/dev/null)
      window=$(jq -r '.window // "-"' "$worker_dir/config.json" 2>/dev/null)
      branch=$(jq -r '.branch // "-"' "$worker_dir/config.json" 2>/dev/null)

      # Liveness check
      if [ "$status" = "active" ] && [ "$pane_id" != "-" ] && [ -n "$pane_id" ] && [ "$pane_id" != "null" ]; then
        if ! echo "$tmux_panes" | grep -qxF "$pane_id"; then
          status="dead"
        fi
      fi

      # Color status
      local status_colored
      case "$status" in
        active)   status_colored="${GREEN}active${NC}" ;;
        sleeping) status_colored="${YELLOW}sleeping${NC}" ;;
        idle)     status_colored="${DIM}idle${NC}" ;;
        dead)     status_colored="${RED}dead${NC}" ;;
        *)        status_colored="${DIM}$status${NC}" ;;
      esac

      printf "%-20s %-10b %-8s %-8s %-14s %-28s\n" \
        "$w" "$status_colored" "$model" "$pane_id" "$window" "$branch"
      count=$((count + 1))
    done
  done

  if [ "$count" -eq 0 ]; then
    echo "  (no workers found)"
  fi
}

_ls_json() {
  local filter_project="$1" tmux_panes="$2"
  local first=true
  echo "["

  for project_dir in "$FLEET_DATA_DIR"/*/; do
    [ ! -d "$project_dir" ] && continue
    local project
    project=$(basename "$project_dir")
    [ -n "$filter_project" ] && [ "$project" != "$filter_project" ] && continue

    for worker_dir in "$project_dir"/*/; do
      [ ! -d "$worker_dir" ] && continue
      local w
      w=$(basename "$worker_dir")
      [[ "$w" == "missions" || "$w" == "_user" || "$w" == "_config" ]] && continue
      [ -f "$worker_dir/state.json" ] || continue
      [ -f "$worker_dir/config.json" ] || continue

      local status pane_id
      status=$(jq -r '.status // "unknown"' "$worker_dir/state.json" 2>/dev/null)
      pane_id=$(jq -r '.pane_id // ""' "$worker_dir/state.json" 2>/dev/null)

      if [ "$status" = "active" ] && [ -n "$pane_id" ] && [ "$pane_id" != "null" ]; then
        if ! echo "$tmux_panes" | grep -qxF "$pane_id"; then
          status="dead"
        fi
      fi

      [ "$first" = true ] && first=false || echo ","
      jq -n --arg name "$w" --arg project "$project" --arg status "$status" \
        --slurpfile config "$worker_dir/config.json" \
        --slurpfile state "$worker_dir/state.json" \
        '{name: $name, project: $project, status: $status, config: $config[0], state: $state[0]}'
    done
  done

  echo "]"
}

# ═══════════════════════════════════════════════════════════════════════
# fleet config <name> [key] [value]
# ═══════════════════════════════════════════════════════════════════════
fleet_config() {
  local name="" key="" value="" opt_project=""
  local args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) opt_project="$2"; shift 2 ;;
      -*)        die "Unknown flag: $1" ;;
      *)         args+=("$1"); shift ;;
    esac
  done

  name="${args[0]:-}"
  key="${args[1]:-}"
  value="${args[2]:-}"

  [ -z "$name" ] && die "Usage: fleet config <name> [key] [value]"

  local project="${opt_project:-$(resolve_project)}"
  local config_file="$FLEET_DATA_DIR/$project/$name/config.json"

  [ ! -f "$config_file" ] && die "Config not found for '$name' in '$project'"

  if [ -z "$key" ]; then
    # Show full config
    jq '.' "$config_file"
  elif [ -z "$value" ]; then
    # Get single key — map "effort" to "reasoning_effort"
    local config_key="$key"
    [ "$key" = "effort" ] && config_key="reasoning_effort"
    jq -r --arg k "$config_key" '.[$k]' "$config_file"
  else
    # Set key=value — map "effort" to "reasoning_effort"
    local config_key="$key"
    [ "$key" = "effort" ] && config_key="reasoning_effort"

    # Determine jq typing
    local jq_set
    if [[ "$value" =~ ^-?[0-9]+$ ]]; then
      jq_set="--argjson v $value"
    elif [ "$value" = "null" ]; then
      jq_set="--argjson v null"
    elif [ "$value" = "true" ] || [ "$value" = "false" ]; then
      jq_set="--argjson v $value"
    else
      jq_set="--arg v $value"
    fi

    local tmp="${config_file}.tmp"
    jq $jq_set --arg k "$config_key" '.[$k] = $v' "$config_file" > "$tmp" && \
      mv "$tmp" "$config_file"

    # Regenerate launch.sh
    generate_launch_sh "$name" "$project"
    success "$key → $value (launch.sh regenerated)"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# fleet defaults [key] [value]
# ═══════════════════════════════════════════════════════════════════════
fleet_defaults() {
  local key="${1:-}" value="${2:-}"
  local defaults_file="$FLEET_DATA_DIR/defaults.json"

  if [ -z "$key" ]; then
    # Show all defaults
    if [ -f "$defaults_file" ]; then
      jq '.' "$defaults_file"
    else
      get_defaults | jq '.'
    fi
  elif [ -z "$value" ]; then
    # Get single key
    get_defaults | jq -r --arg k "$key" '.[$k]'
  else
    # Set key=value
    local current
    current=$(get_defaults)

    local jq_set
    if [[ "$value" =~ ^-?[0-9]+$ ]]; then
      jq_set="--argjson v $value"
    elif [ "$value" = "null" ]; then
      jq_set="--argjson v null"
    elif [ "$value" = "true" ] || [ "$value" = "false" ]; then
      jq_set="--argjson v $value"
    else
      jq_set="--arg v $value"
    fi

    echo "$current" | jq $jq_set --arg k "$key" '.[$k] = $v' > "$defaults_file"
    success "$key → $value"
  fi
}

# ═══════════════════════════════════════════════════════════════════════
# fleet log <name>
# ═══════════════════════════════════════════════════════════════════════
fleet_log() {
  local name="" opt_project="" opt_lines=100

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) opt_project="$2"; shift 2 ;;
      -n)        opt_lines="$2"; shift 2 ;;
      -*)        die "Unknown flag: $1" ;;
      *)         [ -z "$name" ] && name="$1" || die "Unexpected: $1"; shift ;;
    esac
  done

  [ -z "$name" ] && die "Usage: fleet log <name> [-n lines]"

  local project="${opt_project:-$(resolve_project)}"
  local state_file="$FLEET_DATA_DIR/$project/$name/state.json"
  [ ! -f "$state_file" ] && die "State not found for '$name'"

  local pane_id
  pane_id=$(jq -r '.pane_id // empty' "$state_file" 2>/dev/null)
  [ -z "$pane_id" ] && die "'$name' has no active pane"

  # Check pane exists
  if ! tmux list-panes -a -F '#{pane_id}' 2>/dev/null | grep -qxF "$pane_id"; then
    die "Pane $pane_id no longer exists"
  fi

  tmux capture-pane -t "$pane_id" -p -S "-${opt_lines}"
}

# ═══════════════════════════════════════════════════════════════════════
# fleet mail <name>
# ═══════════════════════════════════════════════════════════════════════
fleet_mail() {
  local name="" opt_project="" opt_label="UNREAD"

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --project) opt_project="$2"; shift 2 ;;
      --label)   opt_label="$2"; shift 2 ;;
      -*)        die "Unknown flag: $1" ;;
      *)         [ -z "$name" ] && name="$1" || die "Unexpected: $1"; shift ;;
    esac
  done

  [ -z "$name" ] && die "Usage: fleet mail <name> [--label LABEL]"

  local project="${opt_project:-$(resolve_project)}"
  local token_file="$FLEET_DATA_DIR/$project/$name/token"
  [ ! -f "$token_file" ] && die "No token for '$name'"

  local token
  token=$(cat "$token_file")
  [ -z "$token" ] && die "Empty token for '$name'"

  local response
  response=$(curl -sf -H "Authorization: Bearer $token" \
    "${FLEET_MAIL_URL}/api/messages?label=${opt_label}" 2>/dev/null)

  if [ -z "$response" ]; then
    echo "Fleet Mail unreachable or empty response"
    return 1
  fi

  echo "$response" | jq '.messages[] | {id, from, subject, date}' 2>/dev/null || \
    echo "No messages with label '$opt_label'"
}

# ═══════════════════════════════════════════════════════════════════════
# fleet fork <parent> <child> "<mission>"
# ═══════════════════════════════════════════════════════════════════════
fleet_fork() {
  local parent="" child="" mission=""
  local opt_model="" opt_project=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --model)   opt_model="$2"; shift 2 ;;
      --project) opt_project="$2"; shift 2 ;;
      -*)        die "Unknown flag: $1" ;;
      *)
        if [ -z "$parent" ]; then parent="$1"
        elif [ -z "$child" ]; then child="$1"
        elif [ -z "$mission" ]; then mission="$1"
        else die "Unexpected: $1"
        fi
        shift ;;
    esac
  done

  [ -z "$parent" ] || [ -z "$child" ] || [ -z "$mission" ] && \
    die "Usage: fleet fork <parent> <child> \"<mission>\""

  validate_name "$child"

  local project="${opt_project:-$(resolve_project)}"
  local parent_dir="$FLEET_DATA_DIR/$project/$parent"
  local parent_state="$parent_dir/state.json"
  [ ! -f "$parent_state" ] && die "Parent '$parent' not found"

  local parent_pane parent_session
  parent_pane=$(jq -r '.pane_id // empty' "$parent_state" 2>/dev/null)
  parent_session=$(jq -r '.session_id // empty' "$parent_state" 2>/dev/null)

  [ -z "$parent_pane" ] && die "Parent '$parent' has no active pane"
  [ -z "$parent_session" ] && die "Parent '$parent' has no session_id"

  # Create the worker first (--no-launch)
  info "Creating forked worker '$child' from '$parent'"
  local create_args=("$child" "$mission" "--no-launch" "--project" "$project")
  [ -n "$opt_model" ] && create_args+=("--model" "$opt_model")
  fleet_create "${create_args[@]}"

  # Update meta.forked_from
  local child_dir="$FLEET_DATA_DIR/$project/$child"
  local tmp="${child_dir}/config.json.tmp"
  jq --arg from "$parent" '.meta.forked_from = $from' "$child_dir/config.json" > "$tmp" && \
    mv "$tmp" "$child_dir/config.json"

  # Copy parent session data to child's project dir
  local worktree
  worktree=$(jq -r '.worktree // ""' "$child_dir/config.json")
  local parent_worktree
  parent_worktree=$(jq -r '.worktree // ""' "$parent_dir/config.json")

  local parent_proj_slug child_proj_slug
  parent_proj_slug=$(echo "$parent_worktree" | tr '/' '-')
  child_proj_slug=$(echo "$worktree" | tr '/' '-')

  local parent_proj_dir="$HOME/.claude/projects/$parent_proj_slug"
  local child_proj_dir="$HOME/.claude/projects/$child_proj_slug"

  if [ -f "$parent_proj_dir/$parent_session.jsonl" ]; then
    mkdir -p "$child_proj_dir"
    cp "$parent_proj_dir/$parent_session.jsonl" "$child_proj_dir/$parent_session.jsonl" 2>/dev/null || \
      warn "Failed to copy session JSONL (non-fatal)"
    [ -d "$parent_proj_dir/$parent_session" ] && \
      cp -r "$parent_proj_dir/$parent_session" "$child_proj_dir/$parent_session" 2>/dev/null || true
    success "Session data copied"
  fi

  # Launch with --resume --fork-session
  local fleet_json="$FLEET_DATA_DIR/$project/fleet.json"
  local session="$DEFAULT_SESSION"
  if [ -f "$fleet_json" ]; then
    local _fs
    _fs=$(jq -r '.tmux_session // empty' "$fleet_json" 2>/dev/null)
    [ -n "$_fs" ] && session="$_fs"
  fi

  local window
  window=$(jq -r '.window // "'"$child"'"' "$child_dir/config.json")

  # Create pane
  local worker_pane
  if ! tmux has-session -t "$session" 2>/dev/null; then
    tmux new-session -d -s "$session" -n "$window" -c "$worktree"
    worker_pane=$(tmux list-panes -t "$session" -F '#{pane_id}' | head -1)
  elif tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$window"; then
    worker_pane=$(tmux split-window -t "$session:$window" -c "$worktree" -d -P -F '#{pane_id}')
    tmux select-layout -t "$session:$window" tiled
  else
    worker_pane=$(tmux new-window -t "$session" -n "$window" -c "$worktree" -d -P -F '#{pane_id}')
  fi

  tmux select-pane -T "$child" -t "$worker_pane"

  # Build fork command
  local model effort perm
  model=$(jq -r '.model // "opus"' "$child_dir/config.json")
  effort=$(jq -r '.reasoning_effort // "high"' "$child_dir/config.json")
  perm=$(jq -r '.permission_mode // "bypassPermissions"' "$child_dir/config.json")

  local cmd="cd $worktree && CLAUDE_CODE_SKIP_PROJECT_LOCK=1 WORKER_NAME=$child claude"
  cmd="$cmd --model $model --effort $effort"
  if [ "$perm" = "bypassPermissions" ]; then
    cmd="$cmd --dangerously-skip-permissions"
  else
    cmd="$cmd --permission-mode $perm"
  fi
  cmd="$cmd --add-dir $child_dir"
  cmd="$cmd --resume $parent_session --fork-session"

  tmux send-keys -t "$worker_pane" "$cmd"
  tmux send-keys -t "$worker_pane" -H 0d

  # Update state
  local pane_target
  pane_target=$(tmux list-panes -a -F '#{pane_id} #{session_name}:#{window_index}.#{pane_index}' \
    | awk -v p="$worker_pane" '$1==p{print $2}' 2>/dev/null || echo "")

  jq -n --arg pane "$worker_pane" --arg target "$pane_target" --arg sess "$session" \
    '{status:"active", pane_id:$pane, pane_target:$target, tmux_session:$sess,
      session_id:"", past_sessions:[], relaunch_count:0, cycles_completed:0, custom:{}}' \
    > "$child_dir/state.json"

  _update_registry "$child" "$project" "$worker_pane" "$pane_target" "$session"

  success "Forked '$child' from '$parent' (pane $worker_pane)"
}

# ═══════════════════════════════════════════════════════════════════════
# fleet setup — One-command bootstrap
# ═══════════════════════════════════════════════════════════════════════
fleet_setup() {
  echo -e "${BOLD}fleet setup${NC} — bootstrapping fleet infrastructure"
  echo ""

  local errors=0

  # 1. Check required tools
  info "Checking dependencies..."
  for tool in bun jq tmux; do
    if command -v "$tool" >/dev/null 2>&1; then
      success "$tool → $(command -v "$tool")"
    else
      echo -e "  ${RED}✗${NC} $tool not found"
      case "$tool" in
        bun)  echo "    Install: curl -fsSL https://bun.sh/install | bash" ;;
        jq)   echo "    Install: brew install jq" ;;
        tmux) echo "    Install: brew install tmux" ;;
      esac
      errors=$((errors + 1))
    fi
  done

  [ "$errors" -gt 0 ] && die "Install missing tools above, then re-run: fleet setup"

  # 2. Resolve CLAUDE_FLEET_DIR — find the fleet repo
  local fleet_repo="$CLAUDE_FLEET_DIR"
  if [ ! -d "$fleet_repo" ]; then
    # Try common locations
    for candidate in "$HOME/.claude-fleet" "$HOME/.claude-ops" "$HOME/repos/claude-ops"; do
      if [ -d "$candidate/bin" ] && [ -f "$candidate/bin/fleet" ]; then
        fleet_repo="$candidate"
        break
      fi
    done
  fi
  [ ! -d "$fleet_repo" ] && die "Fleet repo not found. Clone it first:\n  git clone <repo-url> ~/.claude-fleet"
  success "Fleet repo: $fleet_repo"

  # 3. Create symlinks
  info "Setting up symlinks..."
  local real_dir
  real_dir=$(realpath "$fleet_repo" 2>/dev/null || readlink -f "$fleet_repo" 2>/dev/null || echo "$fleet_repo")

  # ~/.claude-fleet
  if [ ! -e "$HOME/.claude-fleet" ]; then
    ln -sfn "$real_dir" "$HOME/.claude-fleet"
    success "Created ~/.claude-fleet → $real_dir"
  else
    success "~/.claude-fleet exists"
  fi

  # ~/.claude-ops (backward compat)
  if [ ! -e "$HOME/.claude-ops" ]; then
    ln -sfn "$real_dir" "$HOME/.claude-ops"
    success "Created ~/.claude-ops → $real_dir (compat)"
  else
    success "~/.claude-ops exists"
  fi

  # ~/.claude/ops
  if [ ! -L "$HOME/.claude/ops" ] || [ "$(readlink "$HOME/.claude/ops")" != "$HOME/.claude-fleet" ]; then
    mkdir -p "$HOME/.claude"
    ln -sfn "$HOME/.claude-fleet" "$HOME/.claude/ops"
    success "Created ~/.claude/ops → ~/.claude-fleet"
  else
    success "~/.claude/ops exists"
  fi

  # ~/.local/bin/fleet
  mkdir -p "$HOME/.local/bin"
  ln -sf "$HOME/.claude-fleet/bin/fleet" "$HOME/.local/bin/fleet"
  success "Symlinked ~/.local/bin/fleet"

  # Check PATH
  if ! echo "$PATH" | tr ':' '\n' | grep -qxF "$HOME/.local/bin"; then
    warn "$HOME/.local/bin is not in PATH"
    echo "    Add to your shell rc:"
    echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi

  # 4. Create fleet data directory
  mkdir -p "$FLEET_DATA_DIR"
  success "Fleet data dir: $FLEET_DATA_DIR"

  # 5. Create defaults.json if missing
  if [ ! -f "$FLEET_DATA_DIR/defaults.json" ]; then
    cat > "$FLEET_DATA_DIR/defaults.json" <<'DEFAULTS'
{
  "model": "opus",
  "effort": "high",
  "permission_mode": "bypassPermissions",
  "sleep_duration": null
}
DEFAULTS
    success "Created defaults.json"
  else
    success "defaults.json exists"
  fi

  # 6. Register MCP server
  info "Registering MCP server..."
  fleet_mcp register --quiet

  echo ""
  success "Fleet setup complete!"
  echo ""
  echo "  fleet ls              — list workers"
  echo "  fleet create <n> \"m\" — create a worker"
  echo "  fleet help            — all commands"
}

# ═══════════════════════════════════════════════════════════════════════
# fleet mcp — Manage MCP server registration
# ═══════════════════════════════════════════════════════════════════════
fleet_mcp() {
  local subcmd="${1:-status}"
  shift 2>/dev/null || true
  local quiet=false
  [[ "${1:-}" == "--quiet" ]] && quiet=true

  local settings_file="$HOME/.claude/settings.json"
  local mcp_script="$CLAUDE_FLEET_DIR/mcp/worker-fleet/index.ts"
  local bun_path="${BUN:-$(command -v bun 2>/dev/null || echo "")}"

  case "$subcmd" in
    register)
      [ -z "$bun_path" ] && die "bun not found. Install: curl -fsSL https://bun.sh/install | bash"
      [ ! -f "$mcp_script" ] && die "MCP server not found: $mcp_script"

      if [ ! -f "$settings_file" ]; then
        echo '{}' > "$settings_file"
      fi

      # Build the MCP server config
      local tmp
      tmp=$(mktemp)
      jq --arg cmd "$bun_path" \
         --arg script "$mcp_script" \
         --arg mail_url "$FLEET_MAIL_URL" \
         '.mcpServers["worker-fleet"] = {
            command: $cmd,
            args: ["run", $script],
            env: {FLEET_MAIL_URL: $mail_url}
          }' "$settings_file" > "$tmp" && mv "$tmp" "$settings_file"

      if [ "$quiet" = false ]; then
        success "MCP server registered in settings.json"
        echo "  command: $bun_path run $mcp_script"
        echo "  Restart Claude to pick up the change."
      fi
      ;;

    unregister)
      if [ -f "$settings_file" ]; then
        local tmp
        tmp=$(mktemp)
        jq 'del(.mcpServers["worker-fleet"])' "$settings_file" > "$tmp" && mv "$tmp" "$settings_file"
        success "MCP server unregistered"
      fi
      ;;

    status)
      if [ -f "$settings_file" ] && jq -e '.mcpServers["worker-fleet"]' "$settings_file" >/dev/null 2>&1; then
        echo -e "${GREEN}registered${NC}"
        jq '.mcpServers["worker-fleet"]' "$settings_file"
      else
        echo -e "${RED}not registered${NC}"
        echo "  Run: fleet mcp register"
      fi
      ;;

    build)
      info "Building MCP server..."
      [ -z "$bun_path" ] && die "bun not found"
      (cd "$(dirname "$mcp_script")" && "$bun_path" build index.ts --outfile index.js --target bun 2>&1) || \
        die "Build failed"
      success "Built index.js"
      ;;

    *)
      echo "Usage: fleet mcp [register|unregister|status|build]"
      ;;
  esac
}

# ═══════════════════════════════════════════════════════════════════════
# fleet help
# ═══════════════════════════════════════════════════════════════════════
fleet_help() {
  cat <<EOF
${BOLD}fleet${NC} v${VERSION} — Worker fleet management CLI

${BOLD}USAGE${NC}
  fleet <command> [args] [flags]

${BOLD}COMMANDS${NC}
  ${CYAN}setup${NC}                                  Bootstrap fleet (symlinks, MCP, deps)
  ${CYAN}create${NC} <name> "<mission>"             Create + launch worker
  ${CYAN}start${NC}  <name>                          Start/restart existing worker
  ${CYAN}stop${NC}   <name> [--all]                  Graceful stop
  ${CYAN}ls${NC}     [--json]                        List all workers
  ${CYAN}config${NC} <name> [key] [value]            Get/set worker config
  ${CYAN}defaults${NC} [key] [value]                 Get/set global defaults
  ${CYAN}log${NC}    <name> [-n lines]               Tail worker's tmux pane
  ${CYAN}mail${NC}   <name> [--label LABEL]          Check worker's inbox
  ${CYAN}fork${NC}   <parent> <child> "<mission>"    Fork from existing session
  ${CYAN}mcp${NC}    [register|status|build]         Manage MCP server

${BOLD}FLAGS${NC} (for create/start)
  --model opus|sonnet|haiku       Override model
  --effort low|medium|high|max    Override reasoning effort
  --permission-mode MODE          Permission mode
  --window <name>                 tmux window group
  --window-index <N>              Explicit window position
  --project <name>                Override project detection
  --type <archetype>              Template defaults (chief-of-staff, implementer, merger, etc.)
  --no-launch                     Create only, don't launch (create)
  --save                          Persist flag overrides to config (start)
  --json                          Machine-readable output (ls)

${BOLD}RESOLUTION CHAIN${NC}
  CLI flag > per-worker config.json > fleet defaults.json > hardcoded defaults

${BOLD}EXAMPLES${NC}
  fleet create reviewer "Review PRs for security issues"
  fleet create reviewer "Review PRs" --model opus --window code-review --effort max
  fleet start reviewer --model opus --save
  fleet stop --all
  fleet config reviewer model                      # get
  fleet config reviewer model opus                 # set + regenerate launch.sh
  fleet defaults model sonnet
  fleet fork chief-of-staff analyst "Analyze the finance module"
  fleet ls --json
EOF
}

# ═══════════════════════════════════════════════════════════════════════
# Dispatch
# ═══════════════════════════════════════════════════════════════════════
case "${1:-help}" in
  setup)             shift; fleet_setup "$@" ;;
  create)            shift; fleet_create "$@" ;;
  start|restart)     shift; fleet_start "$@" ;;
  stop)              shift; fleet_stop "$@" ;;
  ls|list)           shift; fleet_ls "$@" ;;
  config|cfg)        shift; fleet_config "$@" ;;
  defaults|default)  shift; fleet_defaults "$@" ;;
  log|logs)          shift; fleet_log "$@" ;;
  mail)              shift; fleet_mail "$@" ;;
  fork)              shift; fleet_fork "$@" ;;
  mcp)               shift; fleet_mcp "$@" ;;
  help|--help|-h)    fleet_help ;;
  version|--version|-v) echo "fleet v${VERSION}" ;;
  *)                 echo -e "${RED}Unknown command: $1${NC}" >&2; fleet_help; exit 1 ;;
esac
