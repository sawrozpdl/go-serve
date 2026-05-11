#!/usr/bin/env bash
# setup-ssm.sh — seed SSM Parameter Store with cafe-mgmt prod secrets.
#
# Idempotent: skips any parameter that already exists. To rotate a value,
# use `aws ssm put-parameter --overwrite` directly.
#
# Values are read from environment variables. To run interactively without
# exporting, source `setup-ssm.env` (gitignored) which exports the same
# variables, e.g.:
#
#     cp infra/aws/setup-ssm.env.example infra/aws/setup-ssm.env
#     # fill in values
#     set -a; source infra/aws/setup-ssm.env; set +a
#     AWS_PROFILE=goserve bash infra/aws/setup-ssm.sh
#
# This script never contains literal secret values — they live only on the
# operator's machine and in SSM.

set -euo pipefail

export AWS_PROFILE="${AWS_PROFILE:-goserve}"
export AWS_REGION="${AWS_REGION:-ap-south-1}"
SSM_PREFIX="${SSM_PREFIX:-/cafe-mgmt/prod}"

caller=$(aws sts get-caller-identity --query Account --output text)
[[ "$caller" == "782968043912" ]] || { echo "Wrong AWS account: $caller (expected 782968043912)"; exit 1; }

# Required env vars. Fail fast with a clear list rather than dribbling errors.
require() {
  local missing=()
  for v in "$@"; do
    [[ -z "${!v:-}" ]] && missing+=("$v")
  done
  if (( ${#missing[@]} > 0 )); then
    echo "Missing required env vars: ${missing[*]}" >&2
    echo "Set them or source infra/aws/setup-ssm.env (gitignored)." >&2
    exit 1
  fi
}

require \
  DATABASE_URL \
  GOOGLE_OAUTH_CLIENT_ID \
  GOOGLE_OAUTH_CLIENT_SECRET \
  POST_LOGIN_REDIRECT_URL \
  CORS_ORIGINS \
  STORAGE_S3_ENDPOINT \
  STORAGE_S3_REGION \
  STORAGE_S3_BUCKET \
  STORAGE_S3_ACCESS_KEY_ID \
  STORAGE_S3_SECRET_ACCESS_KEY \
  STORAGE_S3_PUBLIC_URL_BASE

# Optional with safe defaults.
APP_DATABASE_URL="${APP_DATABASE_URL:-$DATABASE_URL}"
SESSION_SECRET="${SESSION_SECRET:-$(openssl rand -hex 32)}"
GOOGLE_OAUTH_REDIRECT_URL="${GOOGLE_OAUTH_REDIRECT_URL:-https://REPLACE_AFTER_FRONTEND_DEPLOYED.example/api/auth/google/callback}"

put() {
  local name="$1" type="$2" value="$3"
  if aws ssm get-parameter --name "${SSM_PREFIX}/${name}" >/dev/null 2>&1; then
    echo "  [skip] ${name} already exists (use 'aws ssm put-parameter --overwrite' to rotate)"
    return 0
  fi
  aws ssm put-parameter --name "${SSM_PREFIX}/${name}" --type "$type" --value "$value" \
    --tags "Key=Project,Value=cafe-mgmt" "Key=Env,Value=prod" >/dev/null
  echo "  [set]  ${name} (${type})"
}

echo "Seeding SSM parameters under ${SSM_PREFIX}/..."

put DATABASE_URL                 SecureString "$DATABASE_URL"
put APP_DATABASE_URL             SecureString "$APP_DATABASE_URL"
put SESSION_SECRET               SecureString "$SESSION_SECRET"

put GOOGLE_OAUTH_CLIENT_ID       SecureString "$GOOGLE_OAUTH_CLIENT_ID"
put GOOGLE_OAUTH_CLIENT_SECRET   SecureString "$GOOGLE_OAUTH_CLIENT_SECRET"
put GOOGLE_OAUTH_REDIRECT_URL    String       "$GOOGLE_OAUTH_REDIRECT_URL"

put POST_LOGIN_REDIRECT_URL      String       "$POST_LOGIN_REDIRECT_URL"
put CORS_ORIGINS                 String       "$CORS_ORIGINS"

put STORAGE_S3_ENDPOINT          String       "$STORAGE_S3_ENDPOINT"
put STORAGE_S3_REGION            String       "$STORAGE_S3_REGION"
put STORAGE_S3_BUCKET            String       "$STORAGE_S3_BUCKET"
put STORAGE_S3_ACCESS_KEY_ID     SecureString "$STORAGE_S3_ACCESS_KEY_ID"
put STORAGE_S3_SECRET_ACCESS_KEY SecureString "$STORAGE_S3_SECRET_ACCESS_KEY"
put STORAGE_S3_PUBLIC_URL_BASE   String       "$STORAGE_S3_PUBLIC_URL_BASE"

echo ""
echo "Verifying:"
aws ssm get-parameters-by-path --path "$SSM_PREFIX" --recursive \
  --query 'Parameters[].[Name,Type]' --output table

cat <<EOF

Next step: run the main bootstrap (or re-run if already started):

    AWS_PROFILE=goserve bash infra/aws/bootstrap.sh

bootstrap.sh detects that every SSM parameter already exists and skips its
own prompts.
EOF
