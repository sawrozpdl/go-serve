#!/usr/bin/env bash
# Manual API deploy to the DataHub box — same path as CI, different transport.
#
#   infra/datahub/deploy.sh        # from anywhere in the repo, with admin SSH access
#
# Builds linux/amd64 binaries locally (never on the 2 GB box) and streams them
# to /usr/local/bin/goserve-deploy-ssh on the box, which runs migrate → switch →
# health check → automatic rollback (see goserve-deploy). CI does the same over
# the Cloudflare Tunnel as the `deploy` user (.github/workflows/deploy-api.yml).
set -euo pipefail

HOST=${DEPLOY_HOST:-ubuntu@202.51.83.57}
KEY=${DEPLOY_KEY:-$HOME/.ssh/goserve.pem}

root=$(git rev-parse --show-toplevel)
sha=$(git -C "$root" rev-parse --short HEAD)
git -C "$root" diff --quiet HEAD -- apps/api || sha="$sha-dirty"
rel="$(date -u +%Y%m%d%H%M%S)-$sha"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

echo "==> build $rel"
(cd "$root/apps/api" &&
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$out/server" ./cmd/server &&
  CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o "$out/migrate" ./cmd/migrate)

echo "==> deploy"
COPYFILE_DISABLE=1 tar -C "$out" -cz server migrate |
  ssh -i "$KEY" -o BatchMode=yes "$HOST" "SSH_ORIGINAL_COMMAND='deploy $rel' /usr/local/bin/goserve-deploy-ssh"
