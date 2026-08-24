#!/usr/bin/env bash
# Export OAuth tokens from macOS keychain to data/oauth.json.
# Run locally on your Mac: bash deploy/export-oauth.sh
#
# DEPRECATED as the VPS credential source: exporting the keychain tokens shares the
# refresh lineage with this Mac, so each side's refresh invalidates the other's tokens
# (auth crash-loops). Provision the VPS with a dedicated grant instead:
#   claude setup-token   → set the result as CLAUDE_CODE_OAUTH_TOKEN in /opt/kuchiclaw/.env
# Kept only as a break-glass fallback for the oauth.json path.
set -euo pipefail

OAUTH_PATH="data/oauth.json"

echo "Reading OAuth tokens from macOS keychain..."
RAW=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null) || {
  echo "Error: Could not read from keychain. Is Claude Code logged in?"
  exit 1
}

# Extract tokens using python3 (available on macOS)
python3 -c "
import json, sys
creds = json.loads('''$RAW''')
oauth = creds.get('claudeAiOauth', {})
if not oauth.get('accessToken') or not oauth.get('refreshToken'):
    print('Error: No OAuth tokens found in keychain.', file=sys.stderr)
    sys.exit(1)
data = {
    'accessToken': oauth['accessToken'],
    'refreshToken': oauth['refreshToken'],
    'expiresAt': oauth['expiresAt']
}
print(json.dumps(data, indent=2))
" > "$OAUTH_PATH"

chmod 600 "$OAUTH_PATH"
echo "Exported to $OAUTH_PATH (chmod 600)"
echo ""
echo "To copy to VPS:"
echo "  scp $OAUTH_PATH root@YOUR_SERVER:/opt/kuchiclaw/data/"
echo "  ssh root@YOUR_SERVER 'chown kuchiclaw:kuchiclaw /opt/kuchiclaw/data/oauth.json'"
