# Non-interactive PATH — ensures tmux, launchd, and SSH sessions get brew + local bins

# Detect Homebrew prefix (Apple Silicon vs Intel Mac)
if [[ -d /opt/homebrew ]]; then
  export HOMEBREW_PREFIX=/opt/homebrew
elif [[ -d /usr/local/Cellar ]]; then
  export HOMEBREW_PREFIX=/usr/local
fi

export PATH="$HOMEBREW_PREFIX/bin:$HOMEBREW_PREFIX/sbin:$HOME/.local/bin:$HOME/.bun/bin:$PATH"
. "$HOME/.cargo/env"
