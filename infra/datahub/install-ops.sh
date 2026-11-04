#!/usr/bin/env bash
# Backups, alerting and a watchdog for the DataHub box. Idempotent; run as root.
#
#   Postgres  → pgBackRest → gs://goserve-backups-hearth/pgbackrest
#               continuous WAL archive (PITR) + weekly full (Sun) + daily diff
#   /data/uploads → restic → gs://goserve-backups-hearth/restic   (nightly)
#   Failures of any of these, and the watchdog's checks, post to the Discord
#   ALERT_WEBHOOK_URL from /opt/cafe/.env.
#
# Passphrases live in /etc/goserve-secrets (root-only). Losing them makes the
# backups unreadable — keep a copy off the box (see infra/datahub/README.md).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
command -v restic >/dev/null || apt-get -qq install -y restic >/dev/null

# --- alert helper ------------------------------------------------------------
cat > /usr/local/bin/goserve-alert <<'EOF'
#!/usr/bin/env bash
# goserve-alert "message" — post to the Discord webhook in /opt/cafe/.env.
url=$(grep -E '^ALERT_WEBHOOK_URL=' /opt/cafe/.env | cut -d"'" -f2)
[ -n "$url" ] || { echo "no ALERT_WEBHOOK_URL" >&2; exit 0; }
msg="[$(hostname)] $*"
curl -fsS -m 10 -H 'Content-Type: application/json' \
  -d "$(jq -n --arg c "${msg:0:1900}" '{content:$c}')" "$url" >/dev/null
EOF
chmod 755 /usr/local/bin/goserve-alert

cat > /etc/systemd/system/goserve-alert@.service <<'EOF'
[Unit]
Description=Alert: %i failed
[Service]
Type=oneshot
ExecStart=/bin/bash -c '/usr/local/bin/goserve-alert ":rotating_light: %i failed — journalctl -u %i -n 50"'
EOF

# --- restic env --------------------------------------------------------------
cat > /etc/goserve-secrets/restic.env <<'EOF'
RESTIC_REPOSITORY=gs:goserve-backups-hearth:/restic
RESTIC_PASSWORD_FILE=/etc/goserve-secrets/restic-password
GOOGLE_PROJECT_ID=hearth-500309
GOOGLE_APPLICATION_CREDENTIALS=/etc/pgbackrest/gcs-key.json
RESTIC_CACHE_DIR=/var/cache/restic
EOF
chmod 600 /etc/goserve-secrets/restic.env
set -a; . /etc/goserve-secrets/restic.env; set +a
restic cat config >/dev/null 2>&1 || restic init

# --- units -------------------------------------------------------------------
unit() { # name, description, user, command, OnCalendar
cat > /etc/systemd/system/$1.service <<EOF
[Unit]
Description=$2
OnFailure=goserve-alert@%n.service
After=postgresql@18-main.service
[Service]
Type=oneshot
User=$3
Nice=10
IOSchedulingClass=idle
ExecStart=$4
EOF
cat > /etc/systemd/system/$1.timer <<EOF
[Unit]
Description=$2 (schedule)
[Timer]
OnCalendar=$5
Persistent=true
RandomizedDelaySec=5min
[Install]
WantedBy=timers.target
EOF
}
# 21:30 UTC = 03:15 Kathmandu, well after every café closes.
unit pgbackrest-full "pgBackRest full backup"  postgres "/usr/bin/pgbackrest --stanza=goserve --type=full backup" "Sun *-*-* 21:30:00"
unit pgbackrest-diff "pgBackRest diff backup"  postgres "/usr/bin/pgbackrest --stanza=goserve --type=diff backup" "Mon..Sat *-*-* 21:30:00"
unit restic-uploads  "restic snapshot of /data/uploads" root \
  "/bin/bash -c 'set -a; . /etc/goserve-secrets/restic.env; set +a; restic backup --quiet --host goserve /data/uploads && restic forget --quiet --host goserve --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune'" \
  "*-*-* 21:50:00"

# --- watchdog ----------------------------------------------------------------
cat > /usr/local/bin/goserve-watchdog <<'EOF'
#!/usr/bin/env bash
# Every 5 min: API health, WAL archiving, disk, memory. Alerts once per problem
# per hour (state in /run/goserve-watchdog) and says when it recovers.
set -u
S=/run/goserve-watchdog; mkdir -p $S
problem() { # key, message
  local f=$S/$1
  if [ ! -f $f ] || [ $(( $(date +%s) - $(stat -c %Y $f) )) -gt 3600 ]; then
    /usr/local/bin/goserve-alert ":warning: $2"; touch $f
  fi
}
ok() { [ -f $S/$1 ] && { /usr/local/bin/goserve-alert ":white_check_mark: recovered: $1"; rm -f $S/$1; }; true; }

if curl -fsS -m 5 -o /dev/null http://127.0.0.1:8080/healthz; then ok api; else problem api "API /healthz failing on 127.0.0.1:8080 (systemctl status cafe-api)"; fi
if [ -f /etc/systemd/system/cloudflared.service ]; then
  if systemctl is-active -q cloudflared; then ok tunnel; else problem tunnel "cloudflared is not running — the site is unreachable"; fi
fi

# WAL archiving: alert if the last failure is newer than the last success.
read -r last_ok last_fail < <(sudo -u postgres psql -X -At -F' ' -c "select coalesce(extract(epoch from last_archived_time)::bigint,0), coalesce(extract(epoch from last_failed_time)::bigint,0) from pg_stat_archiver" 2>/dev/null || echo "0 1")
if [ "${last_fail:-0}" -gt "${last_ok:-0}" ]; then problem archive "WAL archiving to GCS is failing (pg_stat_archiver) — point-in-time recovery is degraded"; else ok archive; fi

for m in / /data; do
  use=$(df --output=pcent $m | tail -1 | tr -dc 0-9)
  k=disk$(echo $m | tr / _)
  if [ "$use" -ge 85 ]; then problem $k "disk $m at ${use}%"; else ok $k; fi
done
avail=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
if [ "$avail" -lt 150 ]; then problem mem "only ${avail} MiB RAM available"; else ok mem; fi
EOF
chmod 755 /usr/local/bin/goserve-watchdog
cat > /etc/systemd/system/goserve-watchdog.service <<'EOF'
[Unit]
Description=goserve watchdog
[Service]
Type=oneshot
ExecStart=/usr/local/bin/goserve-watchdog
EOF
cat > /etc/systemd/system/goserve-watchdog.timer <<'EOF'
[Unit]
Description=goserve watchdog (every 5 min)
[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF

# --- SSH: keys only ------------------------------------------------------------
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' > /etc/ssh/sshd_config.d/10-goserve.conf
sshd -t && systemctl reload ssh

systemctl daemon-reload
systemctl enable --now pgbackrest-full.timer pgbackrest-diff.timer restic-uploads.timer goserve-watchdog.timer >/dev/null
systemctl list-timers --no-pager | grep -E 'pgbackrest|restic|watchdog'
