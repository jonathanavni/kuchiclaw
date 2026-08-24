#!/usr/bin/env bash
set -euo pipefail

APP_ROOT=/opt/kuchiclaw
DATA_ROOT=/opt/kuchiclaw/data
IPC_ROOT=/opt/kuchiclaw/data/ipc
DB_PATH=/opt/kuchiclaw/data/kuchiclaw.db
MARKER_PATH=/opt/kuchiclaw/data/ipc-layout-v2
SERVICE_NAME=kuchiclaw

fail() {
  echo "cutover failed: $*" >&2
  exit 1
}

db_version() {
  sqlite3 "$DB_PATH" 'PRAGMA user_version;'
}

task_count() {
  sqlite3 "$DB_PATH" 'SELECT COUNT(*) FROM scheduled_tasks;'
}

legacy_containers() {
  local container_id
  for container_id in $(docker ps -q); do
    if docker inspect --format '{{range .Mounts}}{{println .Source}}{{end}}' "$container_id" \
      | grep -Fxq "$IPC_ROOT"; then
      echo "$container_id"
    fi
  done
}

[[ "$APP_ROOT" == /opt/kuchiclaw ]] || fail "unexpected application root"
command -v docker >/dev/null || fail "docker is required"
command -v sqlite3 >/dev/null || fail "sqlite3 is required"
command -v journalctl >/dev/null || fail "journalctl is required"

# The installed service executes TypeScript from APP_ROOT, so verify that exact
# source tree contains the v2 startup gate before changing any deployment state.
# Confirm the unit actually runs from APP_ROOT first — otherwise the source we
# inspect below is not the source that will start.
unit_workdir=$(systemctl show -p WorkingDirectory --value "$SERVICE_NAME" 2>/dev/null || true)
[[ "$unit_workdir" == "$APP_ROOT" ]] \
  || fail "service WorkingDirectory ('$unit_workdir') is not $APP_ROOT; inspected source may not be what runs"
[[ -f "$APP_ROOT/src/db.ts" ]] || fail "deployed v2 database source is missing"
grep -Fqx 'export const IPC_LAYOUT_DB_VERSION = 2;' "$APP_ROOT/src/db.ts" \
  || fail "deployed checkout is not M12 Phase 1 v2 code"
[[ -f "$APP_ROOT/src/index.ts" ]] || fail "deployed v2 entrypoint is missing"
grep -Fq 'enforceStartupGate(startupOptions);' "$APP_ROOT/src/index.ts" \
  || fail "deployed entrypoint does not enforce the v2 startup gate"
# Require the hardened fresh-install attestation, so a half-applied Phase 1 (the
# startup gate present but the legacy-mount race still open) is rejected too.
grep -Fq '!isAbsent(ipcDir)' "$APP_ROOT/src/index.ts" \
  || fail "deployed entrypoint predates the fresh-install attestation hardening"

systemctl stop "$SERVICE_NAME"

container_ids=$(legacy_containers)
if [[ -n "$container_ids" ]]; then
  # Container IDs contain no whitespace, so shell splitting is intentional here.
  docker kill $container_ids >/dev/null
fi
[[ -z "$(legacy_containers)" ]] || fail "a container still mounts the legacy IPC root"

already_cut_over=0
if [[ -e "$MARKER_PATH" || -L "$MARKER_PATH" ]]; then
  [[ -f "$MARKER_PATH" && ! -L "$MARKER_PATH" ]] \
    || fail "filesystem attestation is not a regular file"
  [[ -f "$DB_PATH" ]] || fail "filesystem attestation exists without a database"
  [[ "$(db_version)" == 2 ]] || fail "filesystem and database attestations disagree"
  already_cut_over=1
fi

if [[ "$already_cut_over" == 0 ]]; then
  quarantine_path=""
  if [[ -e "$IPC_ROOT" || -L "$IPC_ROOT" ]]; then
    epoch=$(date +%s)
    quarantine_path="$DATA_ROOT/ipc-legacy-$epoch"
    while [[ -e "$quarantine_path" ]]; do
      epoch=$((epoch + 1))
      quarantine_path="$DATA_ROOT/ipc-legacy-$epoch"
    done
    mv "$IPC_ROOT" "$quarantine_path"
  else
    quarantine_path=$(find "$DATA_ROOT" -maxdepth 1 -type d -name 'ipc-legacy-*' \
      -printf '%T@ %p\n' | sort -nr | sed -n '1p' | cut -d' ' -f2-)
  fi

  [[ ! -e "$IPC_ROOT" && ! -L "$IPC_ROOT" ]] || fail "legacy IPC root still exists"
  [[ -n "$quarantine_path" && -d "$quarantine_path" ]] \
    || fail "no IPC quarantine exists; inspect state before retrying"
  [[ -f "$DB_PATH" ]] || fail "database not found at $DB_PATH"

  suffix=${quarantine_path##*-}
  dump_path="$DATA_ROOT/scheduled-tasks-legacy-$suffix.sql"
  current_version=$(db_version)
  current_count=$(task_count)

  if [[ "$current_version" != 2 || "$current_count" != 0 ]]; then
    dump_tmp="$dump_path.tmp"
    sqlite3 "$DB_PATH" '.dump scheduled_tasks' > "$dump_tmp"
    [[ -s "$dump_tmp" ]] || fail "scheduled-task dump is empty"
    mv "$dump_tmp" "$dump_path"
    [[ -s "$dump_path" ]] || fail "scheduled-task dump is empty"
    sqlite3 "$DB_PATH" <<'SQL'
BEGIN;
DELETE FROM scheduled_tasks;
PRAGMA user_version = 2;
COMMIT;
SQL
  else
    [[ -s "$dump_path" ]] \
      || fail "database epoch is stamped but the scheduled-task dump is missing"
  fi

  [[ "$(task_count)" == 0 ]] || fail "scheduled tasks were not purged"
  [[ "$(db_version)" == 2 ]] || fail "database epoch was not stamped"

  touch "$MARKER_PATH"
  [[ -f "$MARKER_PATH" ]] || fail "filesystem attestation was not created"
fi

# Capture a boundary so the readiness probe below only reads this restart's logs.
start_marker=$(date '+%Y-%m-%d %H:%M:%S')
systemctl start "$SERVICE_NAME"

# Readiness signal emitted by the running binary itself: the orchestrator logs
# this line only after the startup gate, IPC polling, and the scheduler are all
# up. Checking it (not just the marker/epoch this script wrote) proves the new
# code actually booted through the gate. Poll up to 20s — first boot includes a
# Telegram connect round-trip.
ready=0
for _ in $(seq 1 20); do
  systemctl is-active --quiet "$SERVICE_NAME" \
    || fail "service exited during startup; inspect: journalctl -u $SERVICE_NAME"
  if journalctl -u "$SERVICE_NAME" --since "$start_marker" 2>/dev/null \
      | grep -Fq "[Orchestrator] KuchiClaw is running"; then
    ready=1
    break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || fail "service did not report readiness after startup"
# Secondary confirmation that the attestation the gate passed is intact.
[[ -f "$MARKER_PATH" && ! -L "$MARKER_PATH" ]] \
  || fail "service readiness check found no valid filesystem attestation"
[[ -f "$DB_PATH" ]] || fail "service readiness check found no database"
[[ "$(db_version)" == 2 ]] || fail "service readiness check found the wrong database epoch"

echo "M12 Phase 1 IPC cutover complete."
echo "Recreate trusted scheduled tasks from the main chat, heartbeat first."
echo "Rollback rule: quarantine $IPC_ROOT again before starting an older binary."
