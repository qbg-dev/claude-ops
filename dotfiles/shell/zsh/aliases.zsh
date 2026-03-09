# ~/.zsh/aliases.zsh - All shell aliases

# ===== Claude CLI =====
cd_='claude --dangerously-skip-permissions'
alias c='claude'
alias cdo="$cd_ --model opus --effort high"
alias cds="$cd_ --model sonnet"
alias cdh="$cd_ --model haiku"
alias cdo1m="$cd_ --model 'opus[1m]'"
alias cds1m="$cd_ --model 'sonnet[1m]'"
alias cdoc='cdo --chrome'
alias cdsc='cds --chrome'
alias cdhc='cdh --chrome'

# Edit-then-claude (opens editor with clipboard, then Claude one-shot)
alias eclaudedo='eclaude opus'
alias eclaudeds='eclaude sonnet'
alias eclaudedh='eclaude haiku'

# Edit-then-claude interactive (pipes to stdin for interactive session)
alias eclaudedoi='eclaudei opus'
alias eclaudedsi='eclaudei sonnet'
alias eclaudedhi='eclaudei haiku'

# Paste-and-claude (clipboard directly to Claude)
alias pclaudedo='cdo "$(pbpaste)"'
alias pclaudedh='cdh "$(pbpaste)"'
alias pclaudeds='cds "$(pbpaste)"'

alias claude-mux="python3 ~/.claude-ops/bin/claude-mux.py"
alias claude-no-noti='CLAUDE_DISABLE_NOTIFICATIONS=true claude'

# ===== Codex =====
alias codex="$HOME/.local/bin/codex-wrapper"
alias codexd='codex --dangerously-bypass-approvals-and-sandbox --search'

# ===== Editors =====
alias n=nvim

# ===== Modern CLI replacements =====
alias cat='bat'
alias ll='eza --icons --git --group-directories-first -l'
alias g='grep --color=always'

# ls wrapper: translates coreutils-style `ls -t` to eza's `--sort=modified`
ls() {
  local args=()
  local sort_by_time=false
  for arg in "$@"; do
    if [[ "$arg" == "-t" ]]; then
      sort_by_time=true
    else
      args+=("$arg")
    fi
  done
  if $sort_by_time; then
    eza --icons --git --group-directories-first --sort=modified "${args[@]}"
  else
    eza --icons --git --group-directories-first "${args[@]}"
  fi
}

# ===== Clipboard =====
alias p='pbcopy'
alias pb='pbpaste'

# ===== Web =====
alias openC='open -a "Google Chrome"'

# ===== Database =====
alias db-tunnel='ssh -fN bastion-ali && echo "Tunnel open on localhost:3306"'
alias db-staging='mysql -h 127.0.0.1 -P 3306 -u bop_stage_r -pbop_stage_r'
alias db-kill='pkill -f "ssh.*bastion-ali" && echo "Tunnel closed"'

# ===== Snippets =====
alias cldmd='claudemd'
alias snippi='snippets search -p -i'

# ===== Conda =====
alias conda-init='eval "$(/opt/miniconda3/bin/conda shell.zsh hook)"'

# ===== fzs (program launcher) =====
alias fzs="fzs --config ~/.config/fzs/config.toml"
alias sp="fzs"
export FZS_SHELL=zsh
export FZS_VI_MODE=1
