#!/usr/bin/env bash
# Update a deployed KuchiClaw instance. Run as root on the VPS: bash deploy/update.sh
#
# The rule this script exists to enforce: a `git pull` is not deployed until the
# host runtime is verified, the agent image is rebuilt, and the units are
# reinstalled — host code, container image, and systemd units must move
# together, or the running system silently drifts.
set -euo pipefail

cd /opt/kuchiclaw
PREV_COMMIT=$(sudo -u kuchiclaw git rev-parse --short HEAD)

# On failure the service is left STOPPED on purpose. The alternative — letting
# systemd restart it against a half-mutated tree — was observed to crash-loop
# through the entire StartLimit and spam OnFailure alerts (2026-08-25 P6 deploy).
on_failure() {
  echo "" >&2
  echo "UPDATE FAILED — the service was left STOPPED and the checkout may be ahead." >&2
  echo "Roll back with:" >&2
  echo "  cd /opt/kuchiclaw && sudo -u kuchiclaw git reset --hard ${PREV_COMMIT}" >&2
  echo "  sudo -u kuchiclaw npm ci" >&2
  echo "  docker tag kuchiclaw-agent:rollback-${PREV_COMMIT} kuchiclaw-agent  # if the anchor exists" >&2
  echo "  systemctl start kuchiclaw" >&2
}
trap on_failure ERR

# Stop BEFORE any apt or npm mutation: apt's needrestart otherwise auto-bounces
# the service mid-update (new node binary, old-ABI modules), and npm ci deletes
# node_modules before repopulating — a restart in that window boots from rubble.
echo "[1/7] Stopping kuchiclaw for the update window..."
systemctl stop kuchiclaw

echo "[2/7] Verifying Node.js 24 + toolchain (better-sqlite3 13 segfaults on older majors)..."
if ! node -v | grep -q "^v24\."; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v | grep -q "^v24\." || { echo "ERROR: Node 24 required, found $(node -v)" >&2; exit 1; }
# build-essential: native modules may compile from source under npm ci
apt-get install -y sqlite3 build-essential python3

echo "[3/7] Preserving rollback anchor (image as of ${PREV_COMMIT})..."
# No-clobber: a retried partial update must not destroy its own rollback path.
if docker image inspect kuchiclaw-agent >/dev/null 2>&1 && \
   ! docker image inspect "kuchiclaw-agent:rollback-${PREV_COMMIT}" >/dev/null 2>&1; then
  docker tag kuchiclaw-agent "kuchiclaw-agent:rollback-${PREV_COMMIT}"
fi

echo "[4/7] Pulling latest main..."
# GitHub rate-limits ANONYMOUS git from datacenter IP ranges, so an unauthenticated
# fetch from this VPS returns 401 on the upload-pack POST perhaps half the time —
# every past deploy here was winning a coin flip. Retry rather than leaving the
# service stopped over a transient throttle. The durable fix is a read-only deploy
# key (see BACKLOG); this keeps deploys survivable until then.
pull_ok=0
for attempt in 1 2 3 4 5; do
  if sudo -u kuchiclaw git pull --ff-only; then pull_ok=1; break; fi
  echo "  pull attempt ${attempt} failed; retrying in $((attempt * 5))s..." >&2
  sleep $((attempt * 5))
done
[ "$pull_ok" = "1" ] || { echo "ERROR: git pull failed 5 times — authenticate the host (deploy key) or check connectivity." >&2; exit 1; }

echo "[5/7] Installing host dependencies (clean, ABI-correct for this Node)..."
sudo -u kuchiclaw npm ci
# Prove the native module actually loads before we call this deployable.
sudo -u kuchiclaw node -e "require('better-sqlite3')"

echo "[6/7] Rebuilding agent image..."
sudo -u kuchiclaw docker build -t kuchiclaw-agent .

echo "[7/7] Reinstalling units and starting..."
cp /opt/kuchiclaw/kuchiclaw.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-alert@.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-backup.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kuchiclaw-backup.timer
systemctl start kuchiclaw

echo ""
echo "Done: $(sudo -u kuchiclaw git rev-parse --short HEAD) deployed (was ${PREV_COMMIT})."
sleep 5
systemctl is-active kuchiclaw || echo "(still starting — the crash-loop breaker paces startup; watch the journal)"
systemctl list-timers kuchiclaw-backup.timer --no-pager | head -3
echo "Follow logs: journalctl -u kuchiclaw -f"
echo "After verifying, clean the anchor: docker rmi kuchiclaw-agent:rollback-${PREV_COMMIT}"
