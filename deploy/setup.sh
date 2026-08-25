#!/usr/bin/env bash
# Provision a fresh Ubuntu 24.04 VPS for KuchiClaw.
# Run as root: bash deploy/setup.sh
set -euo pipefail

echo "=== KuchiClaw VPS Setup ==="

# 1. System updates
echo "[1/6] Updating system packages..."
apt-get update && apt-get upgrade -y

# 2. Install Docker
echo "[2/6] Installing Docker..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
else
  echo "Docker already installed."
fi

# 3. Install Node.js 24 via NodeSource + sqlite3 CLI (backup.sh dies without it)
echo "[3/6] Installing Node.js 24..."
if ! command -v node &>/dev/null || ! node -v | grep -q "^v24\."; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
else
  echo "Node.js 24 already installed."
fi
# sqlite3: backup.sh needs the CLI. build-essential/python3: native modules
# (better-sqlite3) may compile from source under npm ci.
apt-get install -y sqlite3 build-essential python3

# 4. Create kuchiclaw user
echo "[4/6] Creating kuchiclaw user..."
if ! id kuchiclaw &>/dev/null; then
  useradd -r -m -s /bin/bash -d /opt/kuchiclaw kuchiclaw
  usermod -aG docker kuchiclaw
  echo "Created user 'kuchiclaw' in docker group."
else
  echo "User 'kuchiclaw' already exists."
fi

# 5. Clone repo and install deps
echo "[5/6] Setting up project..."
if [ ! -d /opt/kuchiclaw/.git ]; then
  sudo -u kuchiclaw git clone https://github.com/tuggspeedman-ai/kuchiclaw.git /opt/kuchiclaw
else
  echo "Repo already cloned."
fi
cd /opt/kuchiclaw
sudo -u kuchiclaw npm install
sudo -u kuchiclaw docker build -t kuchiclaw-agent .

# Ensure data directories exist with correct ownership
sudo -u kuchiclaw mkdir -p data/ipc groups/main
if [ ! -f groups/main/MEMORY.md ]; then
  sudo -u kuchiclaw bash -c 'echo "# Memory" > groups/main/MEMORY.md'
fi
if [ ! -f groups/main/CONTEXT.md ]; then
  sudo -u kuchiclaw bash -c 'echo "# Context" > groups/main/CONTEXT.md'
fi

# 6. Install systemd units: service, alert watchdog, and daily backup timer
echo "[6/6] Installing systemd units..."
cp /opt/kuchiclaw/kuchiclaw.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-alert@.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-backup.service /etc/systemd/system/
cp /opt/kuchiclaw/deploy/kuchiclaw-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable kuchiclaw
systemctl enable --now kuchiclaw-backup.timer

echo ""
echo "=== Setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Create /opt/kuchiclaw/.env with your secrets (see template below)"
echo "     Do this before 03:00 UTC — the backup timer is already enabled, and"
echo "     without .env its failure alert cannot fire (alert.sh reads .env)."
echo "  2. Copy oauth.json: scp data/oauth.json root@SERVER:/opt/kuchiclaw/data/"
echo "     Then: chown kuchiclaw:kuchiclaw /opt/kuchiclaw/data/oauth.json"
echo "           chmod 600 /opt/kuchiclaw/data/oauth.json"
echo "  3. Start the service: systemctl start kuchiclaw"
echo "  4. Check logs: journalctl -u kuchiclaw -f"
echo ""
echo ".env template:"
echo "  TELEGRAM_BOT_TOKEN=your-bot-token"
echo "  FASTMAIL_API_TOKEN=your-fastmail-token"
echo "  FASTMAIL_GROUPS=main,tg-your-chat-id  # Explicit entitlements; unset/empty injects nowhere"
echo "  MAIN_CHAT_ID=tg-your-chat-id"
echo "  ALLOWED_SENDER_IDS=your-telegram-user-id  # REQUIRED — the orchestrator refuses to start without it (\"*\" = allow anyone)"
