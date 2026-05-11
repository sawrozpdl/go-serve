#!/usr/bin/env bash
# teardown.sh — release the AWS resources created by bootstrap.sh.
#
# What this DOES delete:
#   - CloudFront distribution
#   - ECS service + cluster + capacity provider
#   - ASG + launch template
#   - Security group
#   - Elastic IP (otherwise it costs ~$3.60/mo unattached)
#   - SSM parameters under /cafe-mgmt/prod/*
#   - CloudWatch log group
#
# What this DOES NOT delete:
#   - ECR repository or any images (data — operator decides)
#   - IAM roles, OIDC provider (might be reused; trivial to delete by hand)
#   - The GitHub OIDC identity provider
#
# Re-run safe. Each step guards on existence first.
#
# Usage:
#     AWS_PROFILE=goserve bash infra/aws/teardown.sh
#
# Requires confirmation before destroying anything.

set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT_ID="${ACCOUNT_ID:-782968043912}"
PROJECT="${PROJECT:-cafe-mgmt}"
ENV_NAME="${ENV_NAME:-prod}"

CLUSTER="${PROJECT}-${ENV_NAME}"
SERVICE="api"
ASG_NAME="${PROJECT}-${ENV_NAME}-asg"
LT_NAME="${PROJECT}-${ENV_NAME}-lt"
CP_NAME="${PROJECT}-${ENV_NAME}-cp"
SG_NAME="${PROJECT}-${ENV_NAME}-api-sg"
EIP_TAG_NAME="${PROJECT}-${ENV_NAME}-eip"
LOG_GROUP="/${PROJECT}/api"
SSM_PREFIX="/${PROJECT}/${ENV_NAME}"

log()  { printf '\033[1;36m[teardown]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[teardown]\033[0m %s\n' "$*" >&2; }
ok()   { printf '\033[1;32m[teardown]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[teardown]\033[0m %s\n' "$*" >&2; exit 1; }

aws_q() { aws --region "$AWS_REGION" "$@"; }

caller_account=$(aws_q sts get-caller-identity --query Account --output text)
[[ "$caller_account" == "$ACCOUNT_ID" ]] || die "Profile bound to ${caller_account}, expected ${ACCOUNT_ID}"

cat <<EOF >&2

About to DESTROY the cafe-mgmt ${ENV_NAME} stack in ${AWS_REGION}:
  - CloudFront distribution
  - ECS service: ${SERVICE} on cluster ${CLUSTER}
  - Capacity provider: ${CP_NAME}
  - ASG: ${ASG_NAME}, Launch template: ${LT_NAME}
  - Security group: ${SG_NAME}
  - Elastic IP tagged Name=${EIP_TAG_NAME}
  - SSM parameters under ${SSM_PREFIX}/*
  - CloudWatch log group: ${LOG_GROUP}

ECR images and IAM roles will be LEFT in place.
EOF
read -r -p "Type the literal word DESTROY to proceed: " ans
[[ "$ans" == "DESTROY" ]] || die "Aborted."

#### CloudFront ###############################################################

# Find distributions tagged Project=cafe-mgmt Env=${ENV_NAME}
log "Locating CloudFront distribution(s) for ${PROJECT}/${ENV_NAME}"
CF_IDS=$(aws_q cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='${PROJECT} API (${ENV_NAME})'].Id" \
  --output text 2>/dev/null || true)

for CF_ID in $CF_IDS; do
  [[ -z "$CF_ID" || "$CF_ID" == "None" ]] && continue
  log "Disabling CloudFront distribution ${CF_ID}"
  ETAG=$(aws_q cloudfront get-distribution-config --id "$CF_ID" --query 'ETag' --output text)
  aws_q cloudfront get-distribution-config --id "$CF_ID" --query 'DistributionConfig' --output json \
    | jq '.Enabled = false' > /tmp/cf-disable.json
  aws_q cloudfront update-distribution --id "$CF_ID" --if-match "$ETAG" \
    --distribution-config "file:///tmp/cf-disable.json" >/dev/null
  warn "Waiting for distribution ${CF_ID} to reach Deployed=true (this can take 10-15 min)..."
  aws_q cloudfront wait distribution-deployed --id "$CF_ID"
  ETAG=$(aws_q cloudfront get-distribution-config --id "$CF_ID" --query 'ETag' --output text)
  aws_q cloudfront delete-distribution --id "$CF_ID" --if-match "$ETAG"
  ok "Deleted CloudFront ${CF_ID}"
done

#### ECS service + cluster ####################################################

if aws_q ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
     --query "services[?status=='ACTIVE'] | length(@)" --output text 2>/dev/null | grep -q '^1$'; then
  log "Scaling ECS service ${SERVICE} to 0"
  aws_q ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --desired-count 0 >/dev/null
  aws_q ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
  log "Deleting ECS service ${SERVICE}"
  aws_q ecs delete-service --cluster "$CLUSTER" --service "$SERVICE" --force >/dev/null
  ok "Deleted service"
fi

# Disassociate capacity provider before deleting it
if aws_q ecs describe-clusters --clusters "$CLUSTER" \
     --query "clusters[?status=='ACTIVE'] | length(@)" --output text 2>/dev/null | grep -q '^1$'; then
  log "Clearing capacity providers on cluster ${CLUSTER}"
  aws_q ecs put-cluster-capacity-providers \
    --cluster "$CLUSTER" \
    --capacity-providers '[]' \
    --default-capacity-provider-strategy '[]' >/dev/null || true
fi

if aws_q ecs describe-capacity-providers --capacity-providers "$CP_NAME" \
     --query "capacityProviders[?status=='ACTIVE'] | length(@)" --output text 2>/dev/null | grep -q '^1$'; then
  log "Deleting capacity provider ${CP_NAME}"
  aws_q ecs delete-capacity-provider --capacity-provider "$CP_NAME" >/dev/null
fi

if aws_q ecs describe-clusters --clusters "$CLUSTER" \
     --query "clusters[?status=='ACTIVE'] | length(@)" --output text 2>/dev/null | grep -q '^1$'; then
  log "Deleting ECS cluster ${CLUSTER}"
  aws_q ecs delete-cluster --cluster "$CLUSTER" >/dev/null
fi

#### ASG + launch template ####################################################

if aws_q autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG_NAME" \
     --query 'AutoScalingGroups | length(@)' --output text 2>/dev/null | grep -q '^1$'; then
  log "Deleting ASG ${ASG_NAME} (force)"
  aws_q autoscaling delete-auto-scaling-group --auto-scaling-group-name "$ASG_NAME" --force-delete
  # wait until instances are terminated
  while aws_q autoscaling describe-auto-scaling-groups --auto-scaling-group-names "$ASG_NAME" \
          --query 'AutoScalingGroups | length(@)' --output text 2>/dev/null | grep -q '^1$'; do
    sleep 10
  done
fi

if aws_q ec2 describe-launch-templates --launch-template-names "$LT_NAME" >/dev/null 2>&1; then
  log "Deleting launch template ${LT_NAME}"
  aws_q ec2 delete-launch-template --launch-template-name "$LT_NAME" >/dev/null
fi

#### Security group + EIP #####################################################

DEFAULT_VPC=$(aws_q ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text 2>/dev/null || echo None)
if [[ "$DEFAULT_VPC" != "None" ]]; then
  SG_ID=$(aws_q ec2 describe-security-groups \
    --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$DEFAULT_VPC \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
  if [[ "$SG_ID" != "None" ]]; then
    log "Deleting security group ${SG_NAME}"
    aws_q ec2 delete-security-group --group-id "$SG_ID"
  fi
fi

EIP_ALLOC_ID=$(aws_q ec2 describe-addresses \
  --filters "Name=tag:Name,Values=${EIP_TAG_NAME}" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo None)
if [[ "$EIP_ALLOC_ID" != "None" && -n "$EIP_ALLOC_ID" ]]; then
  log "Releasing Elastic IP ${EIP_ALLOC_ID}"
  aws_q ec2 release-address --allocation-id "$EIP_ALLOC_ID"
fi

#### SSM + CloudWatch #########################################################

log "Deleting SSM parameters under ${SSM_PREFIX}/"
mapfile -t PARAMS < <(aws_q ssm get-parameters-by-path --path "$SSM_PREFIX" --recursive \
  --query 'Parameters[].Name' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)
for p in "${PARAMS[@]}"; do
  [[ -z "$p" ]] && continue
  aws_q ssm delete-parameter --name "$p" >/dev/null
done

if aws_q logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" \
     --query "logGroups[?logGroupName=='${LOG_GROUP}'] | length(@)" --output text | grep -q '^1$'; then
  log "Deleting log group ${LOG_GROUP}"
  aws_q logs delete-log-group --log-group-name "$LOG_GROUP"
fi

ok "Teardown complete. ECR images, IAM roles, and the OIDC provider were preserved."
