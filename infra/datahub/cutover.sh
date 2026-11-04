#!/usr/bin/env bash
# One-shot RDS → box database cutover. Run on the box as ubuntu, AFTER the ECS
# service is scaled to 0 (no writes reaching RDS). The RDS admin URL arrives on
# stdin so it never lands on disk:
#
#   aws ssm get-parameter --name /cafe-mgmt/prod/DATABASE_URL --with-decryption \
#     --query Parameter.Value --output text | ssh box 'bash /opt/cutover/cutover.sh'
#
# Steps: stop API → pg_dump RDS (audit_log + ws_tickets data excluded) →
# recreate goserve DB → restore in one transaction as the non-superuser owner →
# rewrite Supabase URLs → migrate up → compare every table's row count with
# RDS → start API → kick off a full pgBackRest backup.
set -euo pipefail
read -r SRC
[ -n "$SRC" ] || { echo "no source URL on stdin" >&2; exit 1; }
cd "$(mktemp -d /tmp/cutover.XXXX)"
owner_url=$(sudo grep '^DATABASE_URL=' /opt/cafe/.env | cut -d"'" -f2)
skip_data="ws_tickets audit_log"   # never copied: ephemeral tickets, audit log dropped by decision

echo "==> stop API"; sudo systemctl stop cafe-api

echo "==> dump RDS"
active=$(psql "$SRC" -X -At -c "select count(*) from pg_stat_activity where datname=current_database() and usename='app_user'")
echo "   app_user connections still open on RDS: $active"
pg_dump "$SRC" -Fp --no-owner --quote-all-identifiers \
  $(for t in $skip_data; do printf -- '--exclude-table-data=public.%s ' "$t"; done) -f dump.sql
grep -v '^COMMENT ON EXTENSION' dump.sql > dump.clean.sql
ls -lh dump.clean.sql

echo "==> recreate goserve DB + restore"
sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS goserve WITH (FORCE)" -c "CREATE DATABASE goserve OWNER goserve"
sudo -u postgres psql -X -q -v ON_ERROR_STOP=1 -d goserve \
  -c "CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS citext;"
psql "$owner_url" -X -q -v ON_ERROR_STOP=1 --single-transaction -f dump.clean.sql > restore.log 2>&1 \
  || { tail -30 restore.log; exit 1; }

echo "==> rewrite storage URLs"
sudo -u postgres psql -X -q -At -d goserve -f /opt/cutover/rewrite-urls.sql

echo "==> migrate up"
sudo -u cafe bash -c 'set -a; . /opt/cafe/.env; set +a; /opt/cafe/current/migrate up' 2>&1 | tail -2

echo "==> row counts (RDS vs box)"
q="select string_agg(format('select %L t, count(*) n from %I', relname, relname), ' union all ' order by relname)
   from pg_class c join pg_namespace s on s.oid=c.relnamespace where s.nspname='public' and c.relkind in ('r','p')"
sql=$(psql "$SRC" -X -At -c "$q")
psql "$SRC" -X -At -F' ' -c "$sql" | sort > rds.counts
sudo -u postgres psql -X -At -F' ' -d goserve -c "$sql" | sort > box.counts
mismatch=0
while read -r t n; do
  b=$(awk -v t="$t" '$1==t{print $2}' box.counts)
  if [ "$n" != "$b" ]; then
    case " $skip_data " in *" $t "*) echo "   $t: rds=$n box=$b (excluded on purpose)";;
      *) echo "   MISMATCH $t: rds=$n box=$b"; mismatch=1;; esac
  fi
done < rds.counts
echo "   tables: $(wc -l < rds.counts) compared, mismatches=$mismatch"
[ "$mismatch" = 0 ] || { echo "!! row counts differ — API left stopped" >&2; exit 1; }

echo "==> start API"
sudo systemctl start cafe-api
for i in $(seq 1 30); do curl -fsS -m 2 -o /dev/null http://127.0.0.1:8080/healthz && break; sleep 1; done
curl -fsS -o /dev/null -w "   healthz %{http_code}\n" http://127.0.0.1:8080/healthz

echo "==> first full backup (background)"
sudo systemctl start --no-block pgbackrest-full.service
echo "cutover done"
