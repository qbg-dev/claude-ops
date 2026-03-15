#!/usr/bin/env bash
# extensions/review/install.sh — Install the review extension.
# Creates symlinks for backward compatibility and installs pre-commit + pre-push hooks.
set -euo pipefail

EXT_DIR="$(cd "$(dirname "$0")" && pwd)"
FLEET_DIR="$(cd "$EXT_DIR/../.." && pwd)"

echo "Installing review extension..."

# Symlink REVIEW.md to repo root
ln -sf extensions/review/REVIEW.md "$FLEET_DIR/REVIEW.md"

# Symlink scripts for backward compatibility (scripts/ → extensions/review/scripts/)
for script in review.sh check-docs.sh verification-hash.sh; do
  ln -sf "../extensions/review/scripts/$script" "$FLEET_DIR/scripts/$script"
done

# Install hooks
HOOK_DIR="$FLEET_DIR/.git/hooks"
if [ -d "$HOOK_DIR" ]; then
  cp "$EXT_DIR/hooks/pre-commit" "$HOOK_DIR/pre-commit"
  chmod +x "$HOOK_DIR/pre-commit"
  echo "  Installed pre-commit hook"

  cp "$EXT_DIR/hooks/pre-push" "$HOOK_DIR/pre-push"
  chmod +x "$HOOK_DIR/pre-push"
  echo "  Installed pre-push hook (DX feedback gate)"
fi

echo "Done. Review extension installed."
echo "  REVIEW.md → extensions/review/REVIEW.md"
echo "  scripts/{review,check-docs,verification-hash}.sh → extensions/review/scripts/"
echo "  hooks: pre-commit + pre-push (DX feedback gate)"
