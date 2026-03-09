# ~/.zsh/functions.zsh - Custom shell functions

# ===== Edit-then-Claude Functions =====
# Usage: ecdo, ecds, ecdh (one-shot with -p)
#        ecdoi, ecdsi, ecdhi (interactive via stdin pipe)
# Opens $EDITOR with clipboard, then sends to claude

eclaude() {
  local model="${1:-sonnet}"
  local temp=$(mktemp /tmp/claude-prompt.XXXXXX.md)

  # Pre-paste clipboard content
  pbpaste > "$temp"

  # Open editor (vim, nvim, etc.)
  ${EDITOR:-vim} "$temp"

  # Check if user saved content (not empty)
  if [[ -s "$temp" ]]; then
    # Send as one-shot prompt
    claude --dangerously-skip-permissions --model "$model" -p "$(cat "$temp")"
  else
    echo "Cancelled (empty prompt)"
  fi

  rm -f "$temp"
}

# Interactive variant - blank editor, then starts interactive session with prompt
eclaudei() {
  local model="${1:-sonnet}"
  local temp=$(mktemp /tmp/claude-prompt.XXXXXX.md)

  # Open blank editor
  ${EDITOR:-vim} "$temp"

  # Pass prompt as argument (keeps stdin connected for interactive mode)
  if [[ -s "$temp" ]]; then
    claude --dangerously-skip-permissions --model "$model" "$(cat "$temp")"
  else
    echo "Cancelled (empty prompt)"
  fi

  rm -f "$temp"
}

# ===== URL opener =====
openw() {
  [[ $# -eq 0 ]] && { open; return; }
  for url in "$@"; do
    if [[ "$url" != *"://"* ]]; then
      url="https://$url"
    fi
    open "$url"
  done
}

# ===== Copy file path as URL =====
cpf() {
  local file="$1"
  local abs_path="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  echo "file://$abs_path" | pbcopy
}

# ===== Markdown preview in Neovim =====
mdp() {
  if [ -z "$1" ]; then
    echo "Usage: mdp <markdown-file>"
    return 1
  fi
  nvim -c "MarkdownPreview" "$1"
}

# ===== Pixi activation =====
pixi_activate() {
  local manifest_path="${1:-.}"
  eval "$(pixi shell-hook --manifest-path $manifest_path)"
}

# ===== Claude helpers =====
claude-named() {
  if [ -z "$1" ]; then
    echo "Usage: claude-named \"Instance Name\" [claude options]"
    return 1
  fi
  local instance_name="$1"
  shift
  CLAUDE_INSTANCE_NAME="$instance_name" claude "$@"
}

# ===== Discord bot token loader =====
load-discord-token() {
  if [[ -f ~/.config/discord-bot/.env ]]; then
    export $(grep -v '^#' ~/.config/discord-bot/.env | xargs)
    echo "Discord bot token loaded into DISCORD_BOT_TOKEN"
  else
    echo "No Discord bot config found at ~/.config/discord-bot/.env"
  fi
}
