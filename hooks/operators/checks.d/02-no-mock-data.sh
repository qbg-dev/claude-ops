#!/usr/bin/env bash
# Check: no mock/placeholder data in written files
[ -z "$FILE_PATH" ] && exit 0
echo "$FILE_PATH" | grep -qE '\.(ts|tsx|json)$' || exit 0
[ ! -f "$FILE_PATH" ] && exit 0
MOCKS=$(grep -cnE '(TODO|FIXME|mock|placeholder|dummy|fake|test123|lorem ipsum)' "$FILE_PATH" 2>/dev/null || echo 0)
[ "$MOCKS" -gt 0 ] && echo "WARNING: $MOCKS potential mock/placeholder data in $(basename "$FILE_PATH")."
exit 0
