# Dotfiles Dependencies

All external tools, packages, and runtimes referenced by `~/.claude-ops/dotfiles/`.

## Required (core shell breaks without these)

| Package | Install | Used by |
|---------|---------|---------|
| **homebrew** | `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` | zshenv, path.zsh |
| **zsh** | System default on macOS | Base shell |
| **tmux** | `brew install tmux` | tmux.conf + all modules |
| **git** | `brew install git` | gitconfig |
| **powerlevel10k** | `brew install powerlevel10k` | zshrc (prompt theme) |
| **zsh-autosuggestions** | `brew install zsh-autosuggestions` | zshrc |
| **zsh-syntax-highlighting** | `brew install zsh-syntax-highlighting` | zshrc |

## Recommended (aliases/functions break without these)

| Package | Install | Used by |
|---------|---------|---------|
| **bat** | `brew install bat` | aliases.zsh (`cat` alias) |
| **eza** | `brew install eza` | aliases.zsh (`ls`, `ll` aliases) |
| **fzf** | `brew install fzf` | zshrc (keybindings + completion) |
| **zoxide** | `brew install zoxide` | zshrc (`cd` alias) |
| **neovim** | `brew install neovim` | zshrc (EDITOR/VISUAL), aliases.zsh |
| **gh** | `brew install gh` | gitconfig (credential helper) |
| **git-lfs** | `brew install git-lfs` | gitconfig (LFS filter) |

## Tmux plugins

| Plugin | Install | Purpose |
|--------|---------|---------|
| **tpm** | `git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm` | Plugin manager |
| **tmux-resurrect** | Auto via tpm (`prefix + I`) | Session save/restore |
| **tmux-continuum** | Auto via tpm | Auto-save sessions |
| **tmux-fzf** | Auto via tpm | Fuzzy finder for sessions |

## Language runtimes (conditional—only loaded if installed)

| Tool | Install | Used by |
|------|---------|---------|
| **bun** | `curl -fsSL https://bun.sh/install \| bash` | zshrc, path.zsh |
| **cargo/rustup** | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` | zshenv |
| **rbenv** | `brew install rbenv` | lazy-loaders.zsh, path.zsh |
| **ruby@3.3** | `brew install ruby@3.3` | path.zsh (conditional) |
| **python@3.11** | `brew install python@3.11` | path.zsh (conditional) |
| **openjdk@17** | `brew install openjdk@17` | path.zsh (conditional) |
| **postgresql@15** | `brew install postgresql@15` | path.zsh (conditional) |
| **miniconda3** | Installer from conda.io | path.zsh, aliases.zsh (conditional) |
| **juliaup** | `curl -fsSL https://install.julialang.org \| sh` | path.zsh |
| **pixi** | `curl -fsSL https://pixi.sh/install.sh \| bash` | path.zsh, functions.zsh |

## Applications (conditional—only added to PATH if installed)

| App | Used by |
|-----|---------|
| **Visual Studio Code** | path.zsh (conditional) |
| **Codeium/Windsurf** | path.zsh |
| **Antigravity** | path.zsh |
| **Google Chrome** | aliases.zsh (`openC`) |

## Claude & LLM tools

| Tool | Install | Used by |
|------|---------|---------|
| **claude** (Claude Code CLI) | `npm install -g @anthropic-ai/claude-code` | aliases.zsh (c, cdo, cds, cdh, etc.) |
| **codex** | `~/.local/bin/codex-wrapper` | aliases.zsh |
| **claude-mux** | `~/.claude-ops/bin/claude-mux.py` | aliases.zsh |
| **snippets** | Custom tool | aliases.zsh |
| **fzs** | Custom program launcher | aliases.zsh |

## Custom scripts (must exist at these paths)

| Script | Path | Used by |
|--------|------|---------|
| tmux-harness-summary.sh | `~/.claude-ops/scripts/` | tmux.conf (status bar) |
| copy-resume-cmd.sh | `~/.claude/scripts/` | claude-ops.tmux.conf |
| move-to-bg.sh | `~/.claude-ops/scripts/` | claude-ops.tmux.conf |
| tmux-cycle-active-worker.sh | `~/.claude-ops/scripts/` | claude-ops.tmux.conf |
| tmux-multilevel scripts | `~/.local/bin/tmux-multilevel/core/` | multilevel.tmux.conf |

## Secrets (files, not packages—loaded by secrets.zsh)

| File | Env var set |
|------|-------------|
| `~/.assembly` | ASSEMBLYAI_API_KEY |
| `~/.cloudflare/api_token` | CLOUDFLARE_API_TOKEN |
| `~/.nexus-token` | NEXUS_TOKEN |
| `~/.hetzner` | (sourced—HETZNER_IP, etc.) |

## Other tools (referenced in aliases/functions)

| Tool | Install | Used by |
|------|---------|---------|
| **stylua** | `brew install stylua` | editors/stylua.toml (Lua formatter config) |
| **mysql** | `brew install mysql-client` | aliases.zsh (db-staging alias) |
| **python3** | System or brew | aliases.zsh (claude-mux.py) |

## Terminal setup

| Item | Path | Used by |
|------|------|---------|
| Custom tmux-256color terminfo | `~/.terminfo/74/tmux-256color` | terminal.tmux.conf |
| Zsh completions dir | `~/.zfunc/` | zshrc (fpath) |

## macOS-specific

| Feature | Used by |
|---------|---------|
| **pbcopy/pbpaste** | tmux.conf (copy mode), aliases.zsh |
| **open** command | aliases.zsh, functions.zsh |
| **Amazon Q** (optional) | zshrc (pre/post blocks) |

## Optional secrets (beyond secrets.zsh)

| File | Used by |
|------|---------|
| `~/.config/discord-bot/.env` | functions.zsh (load-discord-token) |
| `~/.config/fzs/config.toml` | aliases.zsh (fzs launcher) |

## Quick setup (essential packages only)

```bash
# Core
brew install powerlevel10k zsh-autosuggestions zsh-syntax-highlighting
brew install tmux git gh git-lfs
brew install bat eza fzf zoxide neovim

# Tmux plugins
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm
# Then in tmux: prefix + I to install plugins

# Runtimes (as needed)
curl -fsSL https://bun.sh/install | bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```
