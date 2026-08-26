#!/bin/bash
# Living file + SQLite backup to private kuchiclaw-memory GitHub repo.
# Runs on the host (not inside a container) via systemd timer.
#
# Generates a short-lived GitHub App installation token (JWT → API),
# copies living files + SQLite snapshot into the memory repo clone,
# commits if changed, pushes.
#
# Required files:
#   data/github-app/private-key.pem  — GitHub App RSA private key
#   data/kuchiclaw-memory/            — local clone of the memory repo
#
# Config (edit these if your setup differs):
GITHUB_APP_ID="3083609"
GITHUB_INSTALLATION_ID="116126634"
GITHUB_REPO_OWNER="tuggspeedman-ai"
GITHUB_REPO_NAME="kuchiclaw-memory"

set -euo pipefail

# Resolve paths relative to the project root (parent of skills/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PEM_FILE="$PROJECT_ROOT/data/github-app/private-key.pem"
MEMORY_REPO="$PROJECT_ROOT/data/kuchiclaw-memory"
GROUPS_DIR="$PROJECT_ROOT/groups"
DB_FILE="$PROJECT_ROOT/data/kuchiclaw.db"

# --- GitHub App JWT generation (pure bash + openssl) ---

base64url() {
  openssl base64 -A | tr '+/' '-_' | tr -d '='
}

generate_jwt() {
  local now
  now=$(date +%s)
  local iat=$((now - 60))   # 60s clock skew allowance
  local exp=$((now + 300))  # 5 min expiry (GitHub max is 10)

  local header
  header=$(printf '{"alg":"RS256","typ":"JWT"}' | base64url)

  local payload
  payload=$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' "$iat" "$exp" "$GITHUB_APP_ID" | base64url)

  local signature
  signature=$(printf '%s.%s' "$header" "$payload" \
    | openssl dgst -sha256 -sign "$PEM_FILE" \
    | base64url)

  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

# --- Get installation access token ---

get_installation_token() {
  local jwt
  jwt=$(generate_jwt)

  local response
  response=$(curl -sf -X POST \
    -H "Authorization: Bearer $jwt" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/app/installations/$GITHUB_INSTALLATION_ID/access_tokens")

  printf '%s' "$response" | grep -o '"token" *: *"[^"]*"' | head -1 | sed 's/.*: *"//;s/"//'
}

# --- Main ---

echo "[Backup] Starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Validate prerequisites
if [ ! -f "$PEM_FILE" ]; then
  echo "[Backup] ERROR: Private key not found at $PEM_FILE" >&2
  exit 1
fi

# Clone memory repo if it doesn't exist yet
if [ ! -d "$MEMORY_REPO/.git" ]; then
  echo "[Backup] Cloning memory repo..."
  TOKEN=$(get_installation_token)
  git clone "https://x-access-token:${TOKEN}@github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}.git" "$MEMORY_REPO"
fi

# Get a fresh token for push
TOKEN=$(get_installation_token)
if [ -z "$TOKEN" ]; then
  echo "[Backup] ERROR: Failed to get installation token" >&2
  exit 1
fi

# Configure git remote with token (token is short-lived, safe to embed in URL)
cd "$MEMORY_REPO"
git remote set-url origin "https://x-access-token:${TOKEN}@github.com/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}.git"
git config user.name "kuchiclaw-backup"
git config user.email "noreply@kuchiclaw"

# Pull latest to avoid conflicts
git pull --ff-only origin main 2>/dev/null || true

# Copy living files (preserve directory structure)
if [ -d "$GROUPS_DIR" ]; then
  # Copy all MEMORY.md and CONTEXT.md files, preserving group folder structure
  find "$GROUPS_DIR" -name "MEMORY.md" -o -name "CONTEXT.md" | while read -r f; do
    # Get relative path from groups/ (e.g., main/MEMORY.md)
    rel="${f#$GROUPS_DIR/}"
    mkdir -p "$MEMORY_REPO/groups/$(dirname "$rel")"
    cp "$f" "$MEMORY_REPO/groups/$rel"
  done
fi

# SQLite backup as a text dump, not a binary snapshot: binary .backup files
# don't delta-compress, so git history grew by the full DB size every day.
# .dump runs in a read transaction (safe with WAL) and is deterministic, so
# unchanged days produce no diff at all. Restore: sqlite3 new.db < backup.sql
if [ -f "$DB_FILE" ]; then
  # .dump omits PRAGMA user_version, but that's the IPC-layout attestation the
  # startup gate requires (=2) — append it so a restored DB passes the gate.
  {
    sqlite3 "$DB_FILE" ".dump"
    printf 'PRAGMA user_version = %s;\n' "$(sqlite3 "$DB_FILE" 'PRAGMA user_version;')"
  } > "$MEMORY_REPO/kuchiclaw-backup.sql"
  # Drop the legacy binary snapshot so commits stop carrying it (history keeps
  # old blobs, but growth stops here).
  rm -f "$MEMORY_REPO/kuchiclaw-backup.db"
fi

# Stage, check for changes, commit and push
git add -A
if ! git diff --cached --quiet; then
  git commit -m "backup $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  git push origin main
  echo "[Backup] Pushed changes"
else
  echo "[Backup] No changes to commit"
fi

echo "[Backup] Done"
