# ~/.zsh/lazy-loaders.zsh - Lazy loading for version managers
# These functions replace themselves with the real tool on first use

# ===== rbenv (Ruby) =====
# Note: rbenv init is fast, keeping direct eval for now
# If slow, convert to lazy-load pattern below:
# rbenv() {
#   unfunction rbenv
#   eval "$(command rbenv init - zsh)"
#   rbenv "$@"
# }

# For now, direct init (fast enough)
if command -v rbenv &> /dev/null; then
  eval "$(rbenv init -)"
fi

# ===== pyenv (Python) - LAZY =====
# Uncomment if pyenv is installed and you want lazy loading:
# pyenv() {
#   unfunction pyenv
#   eval "$(command pyenv init - zsh)"
#   pyenv "$@"
# }

# ===== nodenv (Node.js) - LAZY =====
# Uncomment if nodenv is installed:
# nodenv() {
#   unfunction nodenv
#   eval "$(command nodenv init - zsh)"
#   nodenv "$@"
# }

# ===== jenv (Java) - LAZY =====
# Uncomment if jenv is installed:
# jenv() {
#   unfunction jenv
#   eval "$(command jenv init - zsh)"
#   jenv "$@"
# }
