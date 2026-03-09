# ~/.zsh/secrets.zsh - Load secrets from individual files
# NOTE: This file contains NO secrets — just cat commands.
# Safe to commit in dotfiles. The actual token files live outside the repo.

# ===== API Keys =====
[[ -f ~/.assembly ]] && export ASSEMBLYAI_API_KEY="$(cat ~/.assembly)"
[[ -f ~/.cloudflare/api_token ]] && export CLOUDFLARE_API_TOKEN="$(cat ~/.cloudflare/api_token)"
[[ -f ~/.nexus-token ]] && export NEXUS_TOKEN="$(cat ~/.nexus-token)"

# ===== Source env files if present =====
[[ -f ~/.hetzner ]] && source ~/.hetzner
