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

# Any failure below leaves a mixed state (new checkout, old image, old process).
# set -e stops before the restart, so the OLD process keeps running — but a later
# crash-restart would boot the new code. Print the way back instead of guessing.
on_failure() {
  echo "" >&2
  echo "UPDATE FAILED — the running service is untouched, but the checkout may be ahead." >&2
  echo "Roll back with:" >&2
  echo "  cd /opt/kuchiclaw && sudo -u kuchiclaw git reset --hard ${PREV_COMMIT}" >&2
  echo "  docker tag kuchiclaw-agent:rollback-${PREV_COMMIT} kuchiclaw-agent  # if the anchor exists" >&2
  echo "  systemctl restart kuchiclaw" >&2
}
trap on_failure ERR

echo "[1/6] Verifying Node.js 24 (better-sqlite3 13 segfaults on older majors)..."
if ! node -v | grep -q "^v24\."; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node -v | grep -q "^v24\." || { echo "ERROR: Node 24 required, found $(node -v)" >&2; exit 1; }
apt-get install -y sqlite3

echo "[2/6] Preserving rollback anchor (image as of ${PREV_COMMIT})..."
# No-clobber: a retried partial update must not destroy its own rollback path.
if docker image inspect kuchiclaw-agent >/dev/null 2>&1 && \
   ! docker image inspect "kuchiclaw-agent:rollback-${PREV_COMMIT}" >/dev/null 2>&1; then
  docker tag kuchiclaw-agent "kuchiclaw-agent:rollback-${PREV_COMMIT}"
fi

echo "[3/6] Pulling latest main..."
sudo -u kuchiclaw git pull --ff-only

echo "[4/6] Installing host dependencies (clean, ABI-correct for this Node)..."
sudo -u kuchiclaw npm ci

echo "[5/6] Rebuilding agent image..."
sudo -u kuchiclaw docker build -t kuchiclaw-agent .

echo "[6/6] Reinstalling units and restarting..."
cp /opt/kuchiclaw/kuchiclaw.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-alert@.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-backup.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kuchiclaw-backup.timer
systemctl restart kuchiclaw

echo ""
echo "Done: $(sudo -u kuchiclaw git rev-parse --short HEAD) deployed (was ${PREV_COMMIT})."
systemctl list-timers kuchiclaw-backup.timer --no-pager | head -3
echo "Follow logs: journalctl -u kuchiclaw -f"
echo "After verifying, clean the anchor: docker rmi kuchiclaw-agent:rollback-${PREV_COMMIT}"
