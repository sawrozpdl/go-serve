#!/usr/bin/env bash
# Deploy the API to the VPS: cross-compile (linux/amd64, static) on this machine,
# ship the binaries, run migrations, swap the server binary, restart, smoke-test.
# Requires Go 1.25+ locally. The box needs NO Go toolchain.
#
# Usage:
#   DEPLOY_HOST=cafe@<droplet-ip> ./infra/vps/deploy.sh
#
# Optional overrides:
#   REMOTE_DIR   (default /opt/cafe)
#   HEALTH_URL   (default https://goserve.sarojpaudyal.com.np/healthz)
set -euo pipefail

: "${DEPLOY_HOST:?set DEPLOY_HOST=user@droplet-ip}"
REMOTE_DIR="${REMOTE_DIR:-/opt/cafe}"
HEALTH_URL="${HEALTH_URL:-https://goserve.sarojpaudyal.com.np/healthz}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$SCRIPT_DIR/../../apps/api"
DIST="$SCRIPT_DIR/dist"
mkdir -p "$DIST"

echo "==> Cross-compiling server + migrate (linux/amd64, static)…"
( cd "$API_DIR"
  for bin in server migrate; do
    GOOS=linux GOARCH=amd64 CGO_ENABLED=0 \
      go build -trimpath -ldflags="-s -w" -o "$DIST/$bin" "./cmd/$bin"
  done )
ls -lh "$DIST/server" "$DIST/migrate"

echo "==> Shipping to $DEPLOY_HOST:$REMOTE_DIR …"
scp "$DIST/server" "$DEPLOY_HOST:$REMOTE_DIR/server.staging"
scp "$DIST/migrate" "$DEPLOY_HOST:$REMOTE_DIR/migrate.staging"

echo "==> Migrating + swapping + restarting on the box…"
# shellcheck disable=SC2087
ssh "$DEPLOY_HOST" REMOTE_DIR="$REMOTE_DIR" bash -s <<'REMOTE'
set -euo pipefail
cd "$REMOTE_DIR"
chmod +x server.staging migrate.staging

# migrate runs as a one-shot CLI; APP_ENV=prod disables .env auto-load, so export it.
set -a; . ./.env; set +a
mv migrate.staging migrate
./migrate up

# atomic-ish swap then restart (systemd will relaunch the new binary)
mv server.staging server
sudo systemctl restart cafe-api
sleep 2
if systemctl is-active --quiet cafe-api; then
  echo "cafe-api: active"
else
  echo "cafe-api failed to come up — last 50 log lines:" >&2
  journalctl -u cafe-api -n 50 --no-pager >&2
  exit 1
fi
REMOTE

echo "==> Smoke test $HEALTH_URL"
curl -fsS "$HEALTH_URL" >/dev/null && echo "healthz: OK ✅"
echo "==> Done."
