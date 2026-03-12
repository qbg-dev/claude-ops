#!/bin/bash
# Thin wrapper — delegates to extensions/statusline/statusline-command.sh
# Resolve through symlinks to find the real script location
_self="${BASH_SOURCE[0]}"
while [ -L "$_self" ]; do
  _dir="$(cd "$(dirname "$_self")" && pwd -P)"
  _self="$(readlink "$_self")"
  [[ "$_self" != /* ]] && _self="$_dir/$_self"
done
_dir="$(cd "$(dirname "$_self")" && pwd -P)"
exec bash "$_dir/../extensions/statusline/statusline-command.sh"
