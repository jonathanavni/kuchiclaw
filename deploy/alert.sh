#!/usr/bin/env bash
# Telegram alert for a failed systemd unit. Triggered by OnFailure on
# kuchiclaw.service when systemd's StartLimit gives up restarting.
# Talks to Telegram directly via the bot token — does NOT depend on the
# kuchiclaw process being alive, which is the whole point.
set -euo pipefail

unit="${1:-kuchiclaw.service}"
chat_id="${MAIN_CHAT_ID#tg-}"  # Strip the "tg-<id>" channel-qualified prefix

# Last 20 log lines for context. Telegram caps messages at 4096 chars; trim
# to keep the prefix + log under that with headroom.
log_tail=$(journalctl -u "$unit" -n 20 --no-pager 2>&1 | tail -c 3000)

text="ALERT: ${unit} entered failed state on $(hostname).

systemd gave up after repeated crashes (StartLimit hit). Last logs:

${log_tail}"

# --fail-with-body makes curl exit non-zero on an HTTP error (400/401/etc.), so
# the caller (systemd OnFailure, or the circuit breaker) can tell a real delivery
# from a rejected one and retry instead of assuming success. Requires curl >= 7.76
# (fine on a modern Hetzner box); an older curl rejects the flag and the alert is
# then treated as failed — safe (retries), just never delivers until curl is updated.
curl -sS --fail-with-body --max-time 10 \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${chat_id}" \
  --data-urlencode "text=${text}" \
  > /dev/null
