# ~/.zsh/keybindings.zsh - Keybindings (after vi mode is set)

# ===== Vi mode =====
set -o vi

# ===== History search with arrow keys =====
bindkey '^[[A' history-search-backward
bindkey '^[[B' history-search-forward

# ===== Autosuggestions =====
bindkey '^ ' autosuggest-accept

# ===== Word navigation =====
# Ctrl+Left/Right
bindkey '^[[1;5D' backward-word
bindkey '^[[1;5C' forward-word

# Option+Left/Right (multiple terminal formats)
bindkey '\e[1;3D' backward-word
bindkey '\e[1;3C' forward-word
bindkey '\eb' backward-word
bindkey '\ef' forward-word

# ===== Line navigation =====
bindkey '^A' beginning-of-line
bindkey '^E' end-of-line

# ===== Edit command in $EDITOR =====
autoload -z edit-command-line
zle -N edit-command-line
bindkey '^G' edit-command-line
