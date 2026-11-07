#!/usr/bin/env bash
# Proof for IRD checklist item 11(झ): try to delete / change an issued bill as
# the APPLICATION's database role and print the database's refusals.
#
#   APP_DATABASE_URL=postgresql://app_user:…@host/db scripts/ird/delete-refusal.sh <café-slug>
#
# Every attempt runs in its own transaction and is rolled back, so nothing can
# change even if a refusal were missing (which would print "ALLOWED").
set -uo pipefail
slug=${1:?usage: $0 <café-slug>}
url=${APP_DATABASE_URL:?set APP_DATABASE_URL to the application role connection string}

tenant=$(printf "SELECT id FROM tenants WHERE slug = :'slug';\n" | psql "$url" -X -Atq -v slug="$slug")
[[ -n $tenant ]] || { echo "no café with slug $slug" >&2; exit 2; }

try() {
  local label=$1 stmt=$2 out
  out=$(printf "BEGIN;\nSELECT set_config('app.tenant_id', :'tenant', true);\n%s;\nROLLBACK;\n" "$stmt" |
    psql "$url" -X -q -v ON_ERROR_STOP=1 -v tenant="$tenant" 2>&1)
  if [[ $? -eq 0 ]]; then
    printf '%-30s ALLOWED  <-- must never happen\n' "$label"
  else
    printf '%-30s REFUSED: %s\n' "$label" "$(printf '%s\n' "$out" | grep -m1 ERROR | sed 's/^.*ERROR: *//')"
  fi
}

latest="(SELECT id FROM invoices ORDER BY issued_at DESC LIMIT 1)"
latest_order="(SELECT order_id FROM invoices ORDER BY issued_at DESC LIMIT 1)"

echo "Go Serve — refusal of changes to issued bills ($(date -u +%Y-%m-%dT%H:%M:%SZ), café $slug)"
echo
try "DELETE invoice"           "DELETE FROM invoices WHERE id = $latest"
try "UPDATE invoice total"     "UPDATE invoices SET total_cents = 1 WHERE id = $latest"
try "DELETE invoice lines"     "DELETE FROM invoice_lines WHERE invoice_id = $latest"
try "UPDATE order behind bill" "UPDATE orders SET total_cents = 1 WHERE id = $latest_order"
try "DELETE payment of bill"   "DELETE FROM payments WHERE order_id = $latest_order"
