#!/usr/bin/env bash
# Check: no hardcoded project/tenant IDs in code files
[ -z "$FILE_PATH" ] && exit 0
echo "$FILE_PATH" | grep -qE '\.(ts|tsx)$' || exit 0
[ ! -f "$FILE_PATH" ] && exit 0
# Look for bare numeric IDs that look like project/tenant IDs (2-3 digit numbers assigned to variables)
HARDCODED=$(grep -nE "(projectId|tenantId|companyId|organizationId)\s*[:=]\s*['\"]?\d{1,4}['\"]?" "$FILE_PATH" 2>/dev/null | head -3)
[ -n "$HARDCODED" ] && echo "WARNING: Possible hardcoded ID in $(basename "$FILE_PATH"): $HARDCODED"
exit 0
