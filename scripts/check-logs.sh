#!/usr/bin/env bash
# check:logs — fail if server-side code looks like it logs secrets.
# Scans src/ (excluding tests) for console.* calls that interpolate likely
# secret-bearing identifiers. This is a heuristic tripwire, not a proof:
# a match means "a human must review this line", not "a leak exists".
set -u

PATTERN='console\.(log|warn|error|debug|info)\(.*\b(accessToken|access_token|refreshToken|refresh_token|clientSecret|client_secret|appSecret|passwordHash|password|secret|token|cookie|authorization|apiKey|api_key|bearer)\b'

# Exclude: test files, the crypto module (which handles ciphertext, not logging),
# and the documented sanitizer helpers.
matches=$(grep -rEn --include='*.ts' --include='*.tsx' \
  --exclude='*.test.ts' --exclude='*.test.tsx' \
  "$PATTERN" src/ | grep -v 'sanitize' || true)

if [ -n "$matches" ]; then
  echo "check:logs: POSSIBLE secret logging — review these lines:"
  echo "$matches"
  echo ""
  echo "If a line is safe (e.g. logs a boolean like 'passwordValid', or a redacted"
  echo "preview via sanitize*), narrow this grep rather than deleting the intent."
  exit 1
fi

echo "check:logs: OK — no obvious secret-logging patterns in src/ (non-test files)."
