#!/usr/bin/env bash
# Nightly Postgres backup → OFF-box bucket. Single box = single point of failure,
# so this is mandatory. Ship to a DIFFERENT provider than the R2 image bucket
# (Backblaze B2 recommended) so one account compromise can't lose both.
#
# Install (as root on the box):
#   apt install -y rclone postgresql-client-16
#   rclone config            # create a remote named "offsite" → B2 (or S3/R2)
#   cp infra/vps/backup.sh /opt/cafe/backup.sh && chmod +x /opt/cafe/backup.sh
#   crontab -e  →  15 2 * * *  /opt/cafe/backup.sh >> /var/log/cafe-backup.log 2>&1
set -euo pipefail

ENV_FILE="${ENV_FILE:-/opt/cafe/.env}"
REMOTE="${BACKUP_REMOTE:-offsite:cafe-backups}"   # rclone remote:path
RETAIN_DAYS="${RETAIN_DAYS:-14}"

set -a; . "$ENV_FILE"; set +a   # for DATABASE_URL
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="/tmp/cafe-${STAMP}.sql.gz"

echo "[$(date -u)] dumping → $FILE"
pg_dump "$DATABASE_URL" | gzip -9 > "$FILE"

echo "[$(date -u)] uploading → $REMOTE"
rclone copy "$FILE" "$REMOTE/"
rm -f "$FILE"

echo "[$(date -u)] pruning backups older than ${RETAIN_DAYS}d"
rclone delete --min-age "${RETAIN_DAYS}d" "$REMOTE/" || true
echo "[$(date -u)] done"
