#!/usr/bin/env bash
# CI guard for IRD release discipline (docs/ird/RELEASES.md).
#   scripts/ird/check-fiscal-change.sh <base-ref>
# Lists the fiscal files the change touches. From version 1.0.0 on, fails when
# fiscal files change but apps/api/internal/version/VERSION does not.
set -euo pipefail
base=${1:-origin/main}
changed=$(git diff --name-only "$base"...HEAD)
fiscal=$(printf '%s\n' "$changed" | grep -E '^(apps/api/internal/fiscal/|packages/receipt-format/|apps/web/src/lib/invoicePrint\.ts|apps/web/src/pages/admin/fiscal/|apps/api/migrations/0(089|09[0-9])_)' || true)
if [[ -z $fiscal ]]; then
  echo "No fiscal change."
  exit 0
fi
version=$(cat apps/api/internal/version/VERSION)
echo "Fiscal files changed (version $version):"
printf '  %s\n' $fiscal
if printf '%s\n' "$changed" | grep -qx 'apps/api/internal/version/VERSION'; then
  echo "VERSION bumped — remember the docs/ird/RELEASES.md row."
  exit 0
fi
major=${version%%.*}
if [[ $major -ge 1 ]]; then
  echo "::error::Fiscal change without a VERSION bump. IRD lists software by version (procedure 2082 §3(घ)); see docs/ird/RELEASES.md."
  exit 1
fi
echo "::warning::Fiscal change without a VERSION bump (allowed before 1.0.0)."
