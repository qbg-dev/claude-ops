#!/bin/bash

# Read JSON input from stdin
input=$(cat)

# Extract values from JSON (single jq call for performance)
eval "$(echo "$input" | jq -r '
  @sh "dir=\(.workspace.current_dir)",
  @sh "model=\(.model.display_name)",
  @sh "cost_raw=\(.cost.total_cost_usd // empty)",
  @sh "transcript_path=\(.transcript_path // empty)",
  @sh "session_id=\(.session_id // empty)"
')"

# ============================================================================
# PANE ↔ SESSION MAPPING
# ============================================================================
# Write pane_id → session_id link. Cached per session (pane doesn't change).
# Used by copy-resume-cmd.sh (C-x y) for instant lookup.
# ============================================================================
PANE_MAP_DIR="$HOME/.claude/pane-map"
if [ -n "$session_id" ] && [ "$session_id" != "null" ]; then
	map_file="$PANE_MAP_DIR/$session_id"
	# Resolve pane ID by walking PPID chain to a tmux pane
	_pane_id=$(tmux list-panes -a -F '#{pane_pid} #{pane_id}' 2>/dev/null | while read pid id; do
		p=$$; while [ "$p" -gt 1 ]; do
			[ "$p" = "$pid" ] && echo "$id" && break 2
			p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
		done
	done)
	if [ -n "$_pane_id" ]; then
		# Check if mapping already correct (skip writes for performance)
		existing_pane=$(cat "$map_file" 2>/dev/null)
		if [ "$existing_pane" != "$_pane_id" ]; then
			mkdir -p "$PANE_MAP_DIR/by-pane"
			# Remove stale reverse mapping if pane changed
			[ -n "$existing_pane" ] && rm -f "$PANE_MAP_DIR/by-pane/$existing_pane"
			echo "$_pane_id" > "$map_file"
			echo "$session_id" > "$PANE_MAP_DIR/by-pane/$_pane_id"
		elif [ ! -f "$PANE_MAP_DIR/by-pane/$_pane_id" ]; then
			mkdir -p "$PANE_MAP_DIR/by-pane"
			echo "$session_id" > "$PANE_MAP_DIR/by-pane/$_pane_id"
		fi
	fi
fi

# ============================================================================
# PANE REGISTRY LOOKUP
# ============================================================================
# WORKER REGISTRY LOOKUP (unified registry.json)
# ============================================================================
# Find this pane's worker in registry.json by matching pane_id.
# Extracts: worker_name, parent, children count, status.
# ============================================================================
_reg_worker_name=""
_reg_parent=""
_reg_children_count=0
_reg_status=""
_reg_parent_pane=""

# Auto-detect registry.json from git worktree or cwd
_REGISTRY_FILE=""
if [ -n "$dir" ]; then
	_main_project="$dir"
	if [ -f "$dir/.git" ]; then
		_main_project=$(sed 's|gitdir: ||; s|/\.git/worktrees/.*||' "$dir/.git" 2>/dev/null)
	fi
	source "$HOME/.claude-ops/lib/resolve-registry.sh" 2>/dev/null
	_REGISTRY_FILE=$(resolve_registry "$_main_project" 2>/dev/null || echo "$_main_project/.claude/workers/registry.json")
fi

if [ -n "$_pane_id" ] && [ -f "$_REGISTRY_FILE" ]; then
	# Single jq call: find worker by pane_id, extract parent/children/status
	eval "$(jq -r --arg pid "$_pane_id" '
		to_entries[] | select(.key != "_config") | select(.value.pane_id == $pid) |
		@sh "_reg_worker_name=\(.key)",
		@sh "_reg_parent=\(.value.report_to // .value.parent // "")",
		@sh "_reg_children_count=\(.value.direct_reports // .value.children // [] | length)",
		@sh "_reg_status=\(.value.status // "")"
	' "$_REGISTRY_FILE" 2>/dev/null)"

	# Resolve parent's pane_id for display
	if [ -n "$_reg_parent" ]; then
		_reg_parent_pane=$(jq -r --arg p "$_reg_parent" '.[$p].pane_id // empty' "$_REGISTRY_FILE" 2>/dev/null)
	fi

	# ── Register active_session_id in registry (non-blocking, best-effort) ──
	if [ -n "$_reg_worker_name" ] && [ -n "$session_id" ] && [ "$session_id" != "null" ]; then
		_cur_sid=$(jq -r --arg n "$_reg_worker_name" '.[$n].active_session_id // empty' "$_REGISTRY_FILE" 2>/dev/null)
		if [ "$_cur_sid" != "$session_id" ]; then
			(
				_LOCK_DIR="${HOME}/.claude-ops/state/locks/worker-registry"
				mkdir -p "$(dirname "$_LOCK_DIR")" 2>/dev/null || true
				_W=0; while ! mkdir "$_LOCK_DIR" 2>/dev/null; do sleep 0.2; _W=$((_W+1)); [ "$_W" -ge 5 ] && exit 0; done
				_tmp=$(mktemp)
				# Set active_session_id; append old session to past_session_ids (max 10)
				jq --arg n "$_reg_worker_name" --arg sid "$session_id" '
					.[$n].active_session_id as $old |
					.[$n].active_session_id = $sid |
					if $old and $old != "" and $old != $sid then
						.[$n].past_session_ids = ((.[$n].past_session_ids // []) + [$old] | .[-10:])
					else . end
				' "$_REGISTRY_FILE" > "$_tmp" 2>/dev/null && mv "$_tmp" "$_REGISTRY_FILE" || rm -f "$_tmp"
				rmdir "$_LOCK_DIR" 2>/dev/null || true
			) &
		fi
	fi
fi

# Legacy compatibility: set pane_line for old display code
PANE_REGISTRY="$_REGISTRY_FILE"
pane_line=""

# Get git information
git_branch=""
git_status=""
if [ -n "$dir" ]; then
	git_branch=$(cd "$dir" 2>/dev/null && git branch --show-current 2>/dev/null)
	if [ -n "$git_branch" ]; then
		# Skip git status if lock exists to avoid conflicts with other git operations
		if [ ! -f "$dir/.git/index.lock" ]; then
			git_status=$(cd "$dir" 2>/dev/null && git status --porcelain 2>/dev/null)
		fi
	fi
fi

# Format git info
git_info=""
if [ -n "$git_branch" ]; then
	if [ -n "$git_status" ]; then
		git_info=$(printf " 🌿 %b%s*%b" "\033[96m" "$git_branch" "\033[0m")
	else
		git_info=$(printf " 🌿 %b%s%b" "\033[96m" "$git_branch" "\033[0m")
	fi
fi

# Format cost with luxury tiers
cost_info=""
if [ -n "$cost_raw" ] && [ "$cost_raw" != "null" ]; then
	cost_dollars=$(awk "BEGIN{printf \"%.8f\", $cost_raw}")

	# Determine luxury tier (green→red heat map)
	if (($(echo "$cost_dollars <= 0.10" | bc -l))); then
		emoji="🪙"; color="\033[92m"
	elif (($(echo "$cost_dollars <= 1.00" | bc -l))); then
		emoji="💵"; color="\033[1;92m"
	elif (($(echo "$cost_dollars <= 5.00" | bc -l))); then
		emoji="💳"; color="\033[93m"
	elif (($(echo "$cost_dollars <= 20.00" | bc -l))); then
		emoji="✨"; color="\033[1;93m"
	elif (($(echo "$cost_dollars <= 100.00" | bc -l))); then
		emoji="🎉"; color="\033[91m"
	elif (($(echo "$cost_dollars <= 500.00" | bc -l))); then
		emoji="🎆"; color="\033[1;91m"
	else
		emoji="💎"; color="\033[1;91m"
	fi

	if (($(echo "$cost_dollars < 0.01" | bc -l))); then
		cost_display=$(printf "\$%.4f" "$cost_dollars")
	else
		cost_display=$(printf "\$%.2f" "$cost_dollars")
	fi

	cost_info=$(printf " | %s %b%s%b" "${emoji}" "${color}" "${cost_display}" "\033[0m")

	# ============================================================================
	# SELF-CONTAINED SPENDING TRACKER
	# ============================================================================
	# Append-only JSONL at ~/.claude/spending.jsonl. No locks needed.
	# printf >> file is atomic for lines < PIPE_BUF (512 bytes). Ours are ~81 bytes.
	# Duplicates per session are expected — aggregation deduplicates by max cost per sid.
	# Format: {"sid":"...","cost":N.NN,"ts":EPOCH}
	# ============================================================================
	SPENDING_FILE="$HOME/.claude/spending.jsonl"

	if [ -n "$session_id" ] && [ "$session_id" != "null" ] && (($(echo "$cost_dollars > 0" | bc -l))); then
		printf '{"sid":"%s","cost":%s,"ts":%s}\n' "$session_id" "$cost_dollars" "$(date +%s)" >> "$SPENDING_FILE"
	fi
fi

# ============================================================================
# COMPUTE SPENDING TOTALS (hourly / daily / weekly)
# ============================================================================
# Dedup by max cost per sid, then sum by time window. Tolerates malformed lines.
# ============================================================================
spending_totals=""
SPENDING_FILE="$HOME/.claude/spending.jsonl"

if [ -f "$SPENDING_FILE" ] && [ -s "$SPENDING_FILE" ]; then
	now_epoch=$(date +%s)

	# Single jq pass: dedup by max cost per sid, then compute hourly/daily/weekly sums.
	# Uses jq -R (raw line input) + fromjson? to tolerate truncated/malformed lines.
	read -r hourly_total daily_total weekly_total < <(
		jq -R -r -s --argjson now "$now_epoch" '
			[split("\n")[] | select(length > 0) | fromjson? | select(.ts and .cost)] |
			group_by(.sid) | map(max_by(.cost)) |
			reduce .[] as $e ({h:0,d:0,w:0};
				($now - $e.ts) as $age |
				(if $age <= 3600   then .h += $e.cost else . end) |
				(if $age <= 86400  then .d += $e.cost else . end) |
				(if $age <= 604800 then .w += $e.cost else . end)
			) |
			"\(.h | . * 100 | round / 100) \(.d | . * 100 | round / 100) \(.w | . * 100 | round / 100)"
		' "$SPENDING_FILE" 2>/dev/null || echo "0 0 0"
	)

	# Probabilistic rotation: 1% chance, only if file > 3000 lines. Prunes > 30 days.
	if [ $((RANDOM % 100)) -eq 0 ]; then
		_lc=$(wc -l < "$SPENDING_FILE" 2>/dev/null || echo 0)
		if [ "${_lc}" -gt 3000 ]; then
			_cutoff=$((now_epoch - 2592000))
			jq -R -s --argjson cutoff "$_cutoff" '
				[split("\n")[] | select(length > 0) | fromjson? |
				 select(.ts and .cost and .ts >= $cutoff)] |
				group_by(.sid) | map(max_by(.cost)) | .[]
			' "$SPENDING_FILE" > "${SPENDING_FILE}.rot.$$" 2>/dev/null && \
			mv "${SPENDING_FILE}.rot.$$" "$SPENDING_FILE" || \
			rm -f "${SPENDING_FILE}.rot.$$"
		fi
	fi

	# Color helper: green < threshold1 < yellow < threshold2 < red
	color_tier() {
		local val="$1" lo="$2" hi="$3"
		if (($(echo "$val >= $hi" | bc -l 2>/dev/null || echo 0))); then
			echo "\033[1;91m"  # Bold Red
		elif (($(echo "$val >= $lo" | bc -l 2>/dev/null || echo 0))); then
			echo "\033[93m"    # Yellow
		else
			echo "\033[92m"    # Green
		fi
	}

	# Hourly (actual spend in last 60 min)
	if [ -n "$hourly_total" ] && [ "$hourly_total" != "0.00" ]; then
		hc=$(color_tier "$hourly_total" 2.00 10.00)
		spending_totals=$(printf " ⏰ %b\$%s%b (1h)" "$hc" "$hourly_total" "\033[0m")
	fi

	# Daily (actual spend in last 24h)
	if [ -n "$daily_total" ] && [ "$daily_total" != "0.00" ]; then
		dc=$(color_tier "$daily_total" 5.00 20.00)
		spending_totals="${spending_totals}$(printf "  📅 %b\$%s%b (24h)" "$dc" "$daily_total" "\033[0m")"
	fi

	# Weekly (actual spend in last 7d)
	if [ -n "$weekly_total" ] && [ "$weekly_total" != "0.00" ]; then
		wc=$(color_tier "$weekly_total" 30.00 100.00)
		spending_totals="${spending_totals}$(printf "  💰 %b\$%s%b (7d)" "$wc" "$weekly_total" "\033[0m")"
	fi
fi

# ============================================================================
# OUTPUT
# ============================================================================
dir_display="$(basename "$dir")"
model_colored=$(printf "%b%s%b" "\033[94m" "$model" "\033[0m")

# Detect if we're in a git worktree (worktrees have .git as a file, not a dir)
is_worktree=0
wt_display=""
if [ -n "$dir" ] && [ -f "$dir/.git" ]; then
	is_worktree=1
	_wt_name=$(basename "$dir")
	wt_display=$(printf "%b%s%b" "\033[1;97m" "$_wt_name" "\033[0m")
fi

# Check if this is a worker branch
is_worker=0
_worker_name=""
if [ -n "$git_branch" ]; then
	case "$git_branch" in worker/*) is_worker=1; _worker_name="${git_branch#worker/}" ;; esac
fi

# ============================================================================
# CURRENT TASK LOOKUP (workers only)
# ============================================================================
# Find the in_progress task from filesystem tasks.json.
# Worker name from git branch or registry pane_id match.
# ============================================================================
_task_line=""
# Use registry worker name if available, fall back to git branch
_effective_worker="${_reg_worker_name:-$_worker_name}"
if [ -n "$_effective_worker" ]; then
	_main_project="$dir"
	if [ -f "$dir/.git" ]; then
		_main_project=$(sed 's|gitdir: ||; s|/\.git/worktrees/.*||' "$dir/.git" 2>/dev/null)
	fi
	_tasks_file="$_main_project/.claude/workers/$_effective_worker/tasks.json"
	[ -f "$_tasks_file" ] && _task_line=$(jq -r '
		to_entries[] |
		select(.value.status == "in_progress") |
		"\(.key): \(.value.activeForm // .value.subject)"
	' "$_tasks_file" 2>/dev/null | head -1)
fi

# Determine tree role from unified registry.json
_tree_tag=""
if [ -n "$_reg_worker_name" ]; then
	if [ -n "$_reg_parent" ]; then
		# Child — show own name ← parent @ target
		_pr_ptarget=$(jq -r --arg p "$_reg_parent" '.[$p].pane_target // "-"' "$_REGISTRY_FILE" 2>/dev/null)
		_loc=""
		[ -n "$_pr_ptarget" ] && [ "$_pr_ptarget" != "-" ] && \
			_loc=$(printf " @ %b%s%b" "\033[36m" "$_pr_ptarget" "\033[0m")
		_tree_tag=$(printf "\n🔗 %b%s%b ← %b%s%b%s" "\033[1;97m" "$_reg_worker_name" "\033[0m" "\033[93m" "$_reg_parent" "\033[0m" "$_loc")
	elif [ "$_reg_children_count" -gt 0 ]; then
		# Root parent — show own name + children count
		_live=$(jq -r --arg name "$_reg_worker_name" '
			. as $reg | [$reg[$name].children // [] | .[] | select($reg[.].pane_id | type == "string")] | length
		' "$_REGISTRY_FILE" 2>/dev/null || echo "?")
		_tree_tag=$(printf "\n🔗 %b%s%b — %b%s%b children (%b%s%b live)" "\033[1;97m" "$_reg_worker_name" "\033[0m" "\033[93m" "$_reg_children_count" "\033[0m" "\033[92m" "$_live" "\033[0m")
	else
		# Registered but orphan — just show name
		_tree_tag=$(printf "\n🔗 %b%s%b" "\033[1;97m" "$_reg_worker_name" "\033[0m")
	fi
fi

if [ "$is_worker" = 1 ]; then
	# Worker line: 🔧 ParentRepo ↪ worktree 🌿 worker/name [child:1 ← parent @ w:1.0]  ⚙️ model | $cost
	_dir_part=""
	if [ "$is_worktree" = 1 ] && [ -n "$wt_display" ]; then
		_dir_part="$wt_display"
	else
		_dir_part=$(printf "%b%s%b" "\033[1;97m" "$dir_display" "\033[0m")
	fi
	printf "🔧 %s%s%s  ⚙️ %s%s" "$_dir_part" "$git_info" "$_tree_tag" "$model_colored" "$cost_info"
	# Current task (if any)
	if [ -n "$_task_line" ]; then
		printf "\n📋 %b%s%b" "\033[1;93m" "$_task_line" "\033[0m"
	fi
else
	# Non-worker line: 📁 dirname 🌿 branch  ⚙️ model | $cost
	_dir_part=""
	if [ "$is_worktree" = 1 ] && [ -n "$wt_display" ]; then
		_dir_part="$wt_display"
	else
		_dir_part="$dir_display"
	fi
	printf "📁 %s%s  ⚙️ %s%s" "$_dir_part" "$git_info" "$model_colored" "$cost_info"
fi
if [ -n "$spending_totals" ]; then
	printf "\n%s" "$spending_totals"
fi

# Transcript path on separate line
if [ -n "$transcript_path" ] && [ "$transcript_path" != "null" ]; then
	transcript_name=$(basename "$transcript_path")
	session_name=""
	if [ -f "$transcript_path" ]; then
		session_name=$(grep '"type":"summary"' "$transcript_path" 2>/dev/null | tail -1 | jq -r '.summary // empty' 2>/dev/null)
	fi
	if [ -n "$session_name" ]; then
		name_colored=$(printf "%b%s%b" "\033[1;36m" "$session_name" "\033[0m")
		transcript_colored=$(printf "%b%s%b" "\033[36m" "$transcript_name" "\033[0m")
		printf "\n📝 %s — %s" "$name_colored" "$transcript_colored"
	else
		transcript_colored=$(printf "%b%s%b" "\033[36m" "$transcript_name" "\033[0m")
		printf "\n📝 %s" "$transcript_colored"
	fi
fi

# (Registry relationship now shown inline via _tree_tag above)
