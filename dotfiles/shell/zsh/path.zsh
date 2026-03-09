# ~/.zsh/path.zsh - Clean PATH management
# typeset -U PATH ensures no duplicates (set in main .zshrc)

# ===== User binaries (highest priority) =====
export PATH="$HOME/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"

# ===== Claude & LLM tools =====
export PATH="$HOME/.claude/local:$PATH"
export PATH="$HOME/.codex/bin:$PATH"
export PATH="$HOME/.claude-ops/bin:$PATH"

# ===== Package managers =====
export PATH="$HOME/.pixi/bin:$PATH"
export PATH="/opt/miniconda3/bin:$PATH"
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# ===== Language runtimes =====
export PATH="$HOME/.rbenv/bin:$PATH"
export PATH="/opt/homebrew/opt/ruby@3.3/bin:$PATH"
export PATH="/opt/homebrew/opt/python@3.11/libexec/bin:$PATH"
export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"
export PATH="$HOME/.juliaup/bin:$PATH"

# ===== Homebrew =====
export PATH="/opt/homebrew/bin:$PATH"
export PATH="/opt/homebrew/sbin:$PATH"
export PATH="/opt/homebrew/opt/postgresql@15/bin:$PATH"

# ===== System Python =====
export PATH="$HOME/Library/Python/3.10/bin:$PATH"

# ===== TeX =====
export PATH="/usr/local/texlive/2025/bin/universal-darwin:$PATH"

# ===== Applications =====
export PATH="/Applications/Visual Studio Code.app/Contents/Resources/app/bin:$PATH"
export PATH="$HOME/.codeium/windsurf/bin:$PATH"
export PATH="$HOME/.antigravity/antigravity/bin:$PATH"
export PATH="$HOME/.npm-global/bin:$PATH"
