#!/usr/bin/env bash
# Per-visit, per-taxpayer, read-only database access for an IRD officer
# (procedure 2082 §11(क)–(घ); see docs/ird/IRD_ACCESS.md). Run ON the box:
#
#   sudo infra/datahub/ird-access.sh grant  <officer> <slug[,slug…]> <days> "<IRD letter / reason>"
#   sudo infra/datahub/ird-access.sh revoke <officer>
#   sudo infra/datahub/ird-access.sh list
#
# grant creates login ird_<officer> (member of ird_auditor, VALID UNTIL now +
# days, 3 connections), records one ird_access_grants row per café, and prints
# a random password ONCE — hand it over on a separate channel. The login can
# read only the ird_audit_* views, filtered to the granted cafés, until the
# grant expires or is revoked. Nothing it does can change data.
set -euo pipefail

DB=${IRD_DB:-goserve}
# IRD_PSQL overrides the superuser psql (e.g. for a dry run on a dev database:
# IRD_PSQL="psql postgresql://me@localhost/cafe" IRD_DB=cafe).
PSQL=${IRD_PSQL:-"sudo -u postgres psql -d $DB"}
psql_su() { $PSQL -X -v ON_ERROR_STOP=1 "$@"; }

ensure_role() {
  psql_su -q <<'SQL'
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ird_auditor') THEN
    CREATE ROLE ird_auditor NOLOGIN;
  END IF;
END $$;
SQL
  psql_su -q -c "GRANT CONNECT ON DATABASE \"$DB\" TO ird_auditor;" \
             -c "GRANT USAGE ON SCHEMA public TO ird_auditor;" \
             -c "GRANT SELECT ON ird_audit_standard_view, ird_audit_credit_notes, ird_audit_purchase_book, ird_audit_trail, ird_audit_print_log TO ird_auditor;" \
             -c "GRANT EXECUTE ON FUNCTION ird_can_see(uuid) TO ird_auditor;"
}

valid_name() { [[ $1 =~ ^[a-z][a-z0-9_]{1,30}$ ]] || { echo "officer name: lower-case letters, digits, _" >&2; exit 2; }; }

cmd=${1:-}
case "$cmd" in
  grant)
    [[ $# -eq 5 ]] || { echo "usage: $0 grant <officer> <slug[,slug…]> <days 1-30> \"<reason>\"" >&2; exit 2; }
    officer=$2; slugs=$3; days=$4; reason=$5
    valid_name "$officer"
    [[ $days =~ ^[0-9]+$ && $days -ge 1 && $days -le 30 ]] || { echo "days must be 1–30" >&2; exit 2; }
    login="ird_${officer}"
    pass=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)
    ensure_role
    psql_su -q -v login="$login" -v pass="$pass" -v days="$days" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L VALID UNTIL %L CONNECTION LIMIT 3 IN ROLE ird_auditor',
              :'login', :'pass', (now() + make_interval(days => :'days'::int))::text) \gexec
SQL
    IFS=',' read -ra list <<<"$slugs"
    for slug in "${list[@]}"; do
      psql_su -q -v login="$login" -v slug="$slug" -v days="$days" -v reason="$reason" <<'SQL'
INSERT INTO ird_access_grants (login, tenant_id, expires_at, reason)
SELECT :'login', t.id, now() + make_interval(days => :'days'::int), :'reason'
FROM tenants t
WHERE t.slug = :'slug'
  AND EXISTS (SELECT 1 FROM fiscal_profiles f WHERE f.tenant_id = t.id AND f.fiscal_mode_enabled_at IS NOT NULL)
RETURNING (SELECT slug FROM tenants WHERE id = tenant_id) AS granted, expires_at;
SQL
    done
    echo
    echo "login:    $login"
    echo "password: $pass        (shown once — give it on a separate channel)"
    echo "expires:  in $days day(s); revoke earlier with: $0 revoke $officer"
    ;;
  revoke)
    [[ $# -eq 2 ]] || { echo "usage: $0 revoke <officer>" >&2; exit 2; }
    valid_name "$2"
    login="ird_$2"
    psql_su -q -v login="$login" <<'SQL'
UPDATE ird_access_grants SET revoked_at = now() WHERE login = :'login' AND revoked_at IS NULL;
SELECT format('DROP ROLE IF EXISTS %I', :'login') \gexec
SQL
    echo "revoked $login"
    ;;
  list)
    psql_su -c "SELECT g.login, t.slug, g.granted_at, g.expires_at, g.revoked_at, g.granted_by, g.reason
                FROM ird_access_grants g JOIN tenants t ON t.id = g.tenant_id ORDER BY g.granted_at DESC"
    ;;
  *)
    sed -n '2,15p' "$0"; exit 2 ;;
esac
