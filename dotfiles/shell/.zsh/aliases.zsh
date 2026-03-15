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

alias claude-mux="python3 ~/.claude-fleet/bin/claude-mux.py"
alias claude-no-noti='CLAUDE_DISABLE_NOTIFICATIONS=true claude'

# ===== Codex =====
alias codex="$HOME/.local/bin/codex-wrapper"
alias codexd='codex --dangerously-bypass-approvals-and-sandbox --search'

# ===== Editors =====
alias n=nvim

# ===== Modern CLI (explicit names, no shadowing) =====
alias ll='eza --icons --git --group-directories-first -l'
alias g='grep --color=always'

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
alias conda-init='eval "$(conda shell.zsh hook 2>/dev/null || /opt/miniconda3/bin/conda shell.zsh hook)"'

# ===== China network routing =====
alias cn='~/.claude/scripts/china_network.sh'
alias cn-on='cn on'
alias cn-off='cn off'

# ===== fzs (program launcher) =====
alias fzs="fzs --config ~/.config/fzs/config.toml"
alias sp="fzs"
export FZS_SHELL=zsh
export FZS_VI_MODE=1
