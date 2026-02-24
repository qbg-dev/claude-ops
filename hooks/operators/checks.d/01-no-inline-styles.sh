#!/usr/bin/env bash
# Check: no inline styles in TSX/CSS files
# Monitor can delete this file to disable, or add new checks alongside it.
[ -z "$FILE_PATH" ] && exit 0
echo "$FILE_PATH" | grep -qE '\.(tsx|jsx)$' || exit 0
[ ! -f "$FILE_PATH" ] && exit 0
COUNT=$(grep -c 'style={{' "$FILE_PATH" 2>/dev/null || echo 0)
[ "$COUNT" -gt 0 ] && echo "WARNING: $COUNT inline style(s) in $(basename "$FILE_PATH"). Use CSS classes."
exit 0
