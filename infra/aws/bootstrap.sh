#!/usr/bin/env bash
# bootstrap.sh — idempotent AWS provisioner for cafe-mgmt API.
#
# Creates: IAM roles + OIDC provider, security group, Elastic IP,
# launch template, ASG, ECS cluster + capacity provider, SSM params,
# CloudWatch log group, ECS task definition + service, CloudFront
# distribution.
#
# Re-run safely: every step guards on `aws ... describe` first.
#
# Usage:
#     AWS_PROFILE=goserve bash infra/aws/bootstrap.sh
#
# Env overrides (rarely needed):
#     AWS_REGION       (default: ap-south-1)
#     ACCOUNT_ID       (default: 782968043912)
#     PROJECT          (default: cafe-mgmt)
#     ENV_NAME         (default: prod)
#     GITHUB_REPO      (default: sawrozpdl/go-serve)
#     ECR_REPO_NAME    (default: go-serve)

set -euo pipefail

#### configuration ############################################################

AWS_REGION="${AWS_REGION:-ap-south-1}"
ACCOUNT_ID="${ACCOUNT_ID:-782968043912}"
PROJECT="${PROJECT:-cafe-mgmt}"
ENV_NAME="${ENV_NAME:-prod}"
GITHUB_REPO="${GITHUB_REPO:-sawrozpdl/go-serve}"
ECR_REPO_NAME="${ECR_REPO_NAME:-go-serve}"

CLUSTER="${PROJECT}-${ENV_NAME}"
SERVICE="api"
TASK_FAMILY="${PROJECT}-api"
ASG_NAME="${PROJECT}-${ENV_NAME}-asg"
LT_NAME="${PROJECT}-${ENV_NAME}-lt"
CP_NAME="${PROJECT}-${ENV_NAME}-cp"
SG_NAME="${PROJECT}-${ENV_NAME}-api-sg"
EIP_TAG_NAME="${PROJECT}-${ENV_NAME}-eip"
LOG_GROUP="/${PROJECT}/api"
SSM_PREFIX="/${PROJECT}/${ENV_NAME}"

EXECUTION_ROLE="ecsTaskExecutionRole"
TASK_ROLE="ecsTaskRole"
INSTANCE_ROLE="ecsInstanceRole"
INSTANCE_PROFILE="ecsInstanceProfile"
GHA_ROLE="github-oidc-deploy-cafe-mgmt"

TAG_FILTER="Key=Project,Value=${PROJECT} Key=Env,Value=${ENV_NAME} Key=ManagedBy,Value=bootstrap.sh"

#### shell helpers ############################################################

# colored stderr
log()  { printf '\033[1;36m[bootstrap]\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[bootstrap]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[bootstrap]\033[0m %s\n' "$*" >&2; exit 1; }
ok()   { printf '\033[1;32m[bootstrap]\033[0m %s\n' "$*" >&2; }

require_cli() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

aws_q() {
  # short hand: aws with region pre-baked, JSON output by default
  aws --region "$AWS_REGION" "$@"
}

confirm() {
  local prompt="$1"
  read -r -p "$prompt [y/N] " ans
  [[ "$ans" =~ ^[Yy]$ ]]
}

# read a secret value without echoing
read_secret() {
  local var="$1"
  local prompt="$2"
  local val
  printf '%s' "$prompt" >&2
  read -r -s val
  echo >&2
  printf -v "$var" '%s' "$val"
}

require_cli aws
require_cli jq

#### preflight ################################################################

log "Account: ${ACCOUNT_ID}  Region: ${AWS_REGION}  Project: ${PROJECT}/${ENV_NAME}"
log "GitHub repo for OIDC: ${GITHUB_REPO}"

caller_account=$(aws_q sts get-caller-identity --query Account --output text)
if [[ "$caller_account" != "$ACCOUNT_ID" ]]; then
  die "AWS profile is bound to account ${caller_account}, expected ${ACCOUNT_ID}. Did you set AWS_PROFILE=goserve?"
fi

#### resolve dynamic values ###################################################

log "Resolving CloudFront origin-facing prefix list ID in ${AWS_REGION}..."
PREFIX_LIST_ID=$(aws_q ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)
[[ "$PREFIX_LIST_ID" == "None" || -z "$PREFIX_LIST_ID" ]] && die "Could not find CloudFront prefix list in ${AWS_REGION}"
ok "Prefix list: ${PREFIX_LIST_ID}"

log "Resolving latest ECS-optimized Amazon Linux 2023 AMI..."
ECS_AMI=$(aws_q ssm get-parameter \
  --name /aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id \
  --query 'Parameter.Value' --output text)
ok "AMI: ${ECS_AMI}"

log "Resolving default VPC and a public subnet..."
DEFAULT_VPC=$(aws_q ec2 describe-vpcs --filters Name=is-default,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
[[ "$DEFAULT_VPC" == "None" ]] && die "No default VPC in ${AWS_REGION}. Create one or set up a custom VPC manually."
SUBNET_ID=$(aws_q ec2 describe-subnets --filters Name=vpc-id,Values=$DEFAULT_VPC Name=default-for-az,Values=true \
  --query 'Subnets[0].SubnetId' --output text)
SUBNET_AZ=$(aws_q ec2 describe-subnets --subnet-ids "$SUBNET_ID" \
  --query 'Subnets[0].AvailabilityZone' --output text)
ok "VPC: ${DEFAULT_VPC}  Subnet: ${SUBNET_ID} (${SUBNET_AZ})"

#### CloudWatch log group #####################################################

if aws_q logs describe-log-groups --log-group-name-prefix "$LOG_GROUP" \
     --query "logGroups[?logGroupName=='${LOG_GROUP}'] | length(@)" --output text | grep -q '^1$'; then
  ok "Log group ${LOG_GROUP} already exists"
else
  log "Creating log group ${LOG_GROUP}"
  aws_q logs create-log-group --log-group-name "$LOG_GROUP" \
    --tags "Project=${PROJECT},Env=${ENV_NAME},ManagedBy=bootstrap.sh"
  aws_q logs put-retention-policy --log-group-name "$LOG_GROUP" --retention-in-days 30
  ok "Log group created with 30-day retention"
fi

#### IAM: GitHub OIDC provider ################################################

OIDC_URL="token.actions.githubusercontent.com"
OIDC_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_URL}"

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$OIDC_ARN" >/dev/null 2>&1; then
  ok "GitHub OIDC provider already exists"
else
  log "Creating GitHub OIDC provider"
  aws iam create-open-id-connect-provider \
    --url "https://${OIDC_URL}" \
    --client-id-list "sts.amazonaws.com" \
    --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aec5" \
    >/dev/null
  ok "OIDC provider created"
fi

#### IAM: roles ###############################################################

create_role_if_absent() {
  local role="$1" trust_file="$2"
  if aws iam get-role --role-name "$role" >/dev/null 2>&1; then
    ok "Role ${role} already exists"
  else
    log "Creating role ${role}"
    aws iam create-role --role-name "$role" \
      --assume-role-policy-document "file://${trust_file}" \
      --tags "Key=Project,Value=${PROJECT}" "Key=Env,Value=${ENV_NAME}" \
      >/dev/null
  fi
}

attach_managed() {
  local role="$1" policy_arn="$2"
  # idempotent attach
  if aws iam list-attached-role-policies --role-name "$role" \
       --query "AttachedPolicies[?PolicyArn=='${policy_arn}'] | length(@)" --output text | grep -q '^1$'; then
    return 0
  fi
  aws iam attach-role-policy --role-name "$role" --policy-arn "$policy_arn"
}

put_inline() {
  local role="$1" name="$2" doc_file="$3"
  aws iam put-role-policy --role-name "$role" --policy-name "$name" \
    --policy-document "file://${doc_file}"
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat >"$WORK/trust-ecs-tasks.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Principal": { "Service": "ecs-tasks.amazonaws.com" },
      "Action": "sts:AssumeRole" }
  ]
}
EOF

cat >"$WORK/trust-ec2.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Principal": { "Service": "ec2.amazonaws.com" },
      "Action": "sts:AssumeRole" }
  ]
}
EOF

cat >"$WORK/trust-gha.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Principal": { "Federated": "${OIDC_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": { "${OIDC_URL}:aud": "sts.amazonaws.com" },
        "StringLike":   { "${OIDC_URL}:sub": "repo:${GITHUB_REPO}:ref:refs/heads/main" }
      }
    }
  ]
}
EOF

# ecsTaskExecutionRole
create_role_if_absent "$EXECUTION_ROLE" "$WORK/trust-ecs-tasks.json"
attach_managed "$EXECUTION_ROLE" "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"

cat >"$WORK/ssm-read.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["ssm:GetParameters", "ssm:GetParameter"],
      "Resource": "arn:aws:ssm:${AWS_REGION}:${ACCOUNT_ID}:parameter${SSM_PREFIX}/*" },
    { "Effect": "Allow",
      "Action": ["kms:Decrypt"],
      "Resource": "arn:aws:kms:${AWS_REGION}:${ACCOUNT_ID}:alias/aws/ssm" }
  ]
}
EOF
put_inline "$EXECUTION_ROLE" "cafe-mgmt-ssm-read" "$WORK/ssm-read.json"

# ecsTaskRole — empty for now (placeholder)
create_role_if_absent "$TASK_ROLE" "$WORK/trust-ecs-tasks.json"

# ecsInstanceRole + instance profile
create_role_if_absent "$INSTANCE_ROLE" "$WORK/trust-ec2.json"
attach_managed "$INSTANCE_ROLE" "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
attach_managed "$INSTANCE_ROLE" "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"

if aws iam get-instance-profile --instance-profile-name "$INSTANCE_PROFILE" >/dev/null 2>&1; then
  ok "Instance profile ${INSTANCE_PROFILE} already exists"
else
  log "Creating instance profile ${INSTANCE_PROFILE}"
  aws iam create-instance-profile --instance-profile-name "$INSTANCE_PROFILE" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$INSTANCE_PROFILE" --role-name "$INSTANCE_ROLE"
  # IAM is eventually consistent — give it a beat before launch template references it
  sleep 8
fi

# Inline policy on instance role: allow self-EIP-associate (added after EIP allocation below).

# github-oidc-deploy-cafe-mgmt
create_role_if_absent "$GHA_ROLE" "$WORK/trust-gha.json"

cat >"$WORK/gha-policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Sid": "EcrLogin",
      "Effect": "Allow",
      "Action": ["ecr:GetAuthorizationToken"],
      "Resource": "*" },
    { "Sid": "EcrPushPull",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:PutImage",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:BatchGetImage",
        "ecr:DescribeRepositories",
        "ecr:DescribeImages"
      ],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${ACCOUNT_ID}:repository/${ECR_REPO_NAME}" },
    { "Sid": "EcsRegisterTaskDef",
      "Effect": "Allow",
      "Action": ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition"],
      "Resource": "*" },
    { "Sid": "EcsTagResource",
      "Effect": "Allow",
      "Action": ["ecs:TagResource", "ecs:UntagResource"],
      "Resource": [
        "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task-definition/${TASK_FAMILY}:*",
        "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task-definition/${PROJECT}-migrate:*",
        "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task/${CLUSTER}/*",
        "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:service/${CLUSTER}/${SERVICE}"
      ] },
    { "Sid": "EcsServiceMutate",
      "Effect": "Allow",
      "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
      "Resource": "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:service/${CLUSTER}/${SERVICE}" },
    { "Sid": "EcsRunTask",
      "Effect": "Allow",
      "Action": ["ecs:RunTask"],
      "Resource": [
        "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task-definition/${TASK_FAMILY}:*",
        "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task-definition/${PROJECT}-migrate:*"
      ] },
    { "Sid": "EcsDescribeTasks",
      "Effect": "Allow",
      "Action": ["ecs:DescribeTasks"],
      "Resource": "arn:aws:ecs:${AWS_REGION}:${ACCOUNT_ID}:task/${CLUSTER}/*" },
    { "Sid": "PassRoleToEcsTasks",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "arn:aws:iam::${ACCOUNT_ID}:role/${EXECUTION_ROLE}",
        "arn:aws:iam::${ACCOUNT_ID}:role/${TASK_ROLE}"
      ],
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } } },
    { "Sid": "LogsRead",
      "Effect": "Allow",
      "Action": ["logs:DescribeLogStreams", "logs:GetLogEvents", "logs:FilterLogEvents"],
      "Resource": "arn:aws:logs:${AWS_REGION}:${ACCOUNT_ID}:log-group:${LOG_GROUP}:*" }
  ]
}
EOF
put_inline "$GHA_ROLE" "cafe-mgmt-deploy" "$WORK/gha-policy.json"

ok "IAM roles ready"

#### Elastic IP ###############################################################

EIP_ALLOC_ID=$(aws_q ec2 describe-addresses \
  --filters "Name=tag:Name,Values=${EIP_TAG_NAME}" \
  --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo None)

if [[ "$EIP_ALLOC_ID" == "None" || -z "$EIP_ALLOC_ID" ]]; then
  log "Allocating Elastic IP ${EIP_TAG_NAME}"
  EIP_ALLOC_ID=$(aws_q ec2 allocate-address --domain vpc \
    --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=${EIP_TAG_NAME}},{Key=Project,Value=${PROJECT}},{Key=Env,Value=${ENV_NAME}}]" \
    --query AllocationId --output text)
fi
EIP_PUBLIC_IP=$(aws_q ec2 describe-addresses --allocation-ids "$EIP_ALLOC_ID" \
  --query 'Addresses[0].PublicIp' --output text)
# Public DNS for a given public IP: ec2-A-B-C-D.region.compute.amazonaws.com
EIP_PUBLIC_DNS="ec2-${EIP_PUBLIC_IP//./-}.${AWS_REGION}.compute.amazonaws.com"
ok "EIP: ${EIP_ALLOC_ID}  IP: ${EIP_PUBLIC_IP}  DNS: ${EIP_PUBLIC_DNS}"

# Now add the EIP self-associate inline policy to the instance role
cat >"$WORK/eip-associate.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow",
      "Action": ["ec2:DescribeAddresses"],
      "Resource": "*" },
    { "Effect": "Allow",
      "Action": ["ec2:AssociateAddress", "ec2:DisassociateAddress"],
      "Resource": [
        "arn:aws:ec2:${AWS_REGION}:${ACCOUNT_ID}:elastic-ip/${EIP_ALLOC_ID}",
        "arn:aws:ec2:${AWS_REGION}:${ACCOUNT_ID}:instance/*",
        "arn:aws:ec2:${AWS_REGION}:${ACCOUNT_ID}:network-interface/*"
      ] }
  ]
}
EOF
put_inline "$INSTANCE_ROLE" "eip-self-associate" "$WORK/eip-associate.json"

#### Security group ###########################################################

SG_ID=$(aws_q ec2 describe-security-groups \
  --filters Name=group-name,Values=$SG_NAME Name=vpc-id,Values=$DEFAULT_VPC \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)

if [[ "$SG_ID" == "None" ]]; then
  log "Creating security group ${SG_NAME}"
  SG_ID=$(aws_q ec2 create-security-group \
    --group-name "$SG_NAME" \
    --description "${PROJECT} API: ingress 8080 from CloudFront only" \
    --vpc-id "$DEFAULT_VPC" \
    --tag-specifications "ResourceType=security-group,Tags=[{Key=Project,Value=${PROJECT}},{Key=Env,Value=${ENV_NAME}},{Key=Name,Value=${SG_NAME}}]" \
    --query GroupId --output text)
fi
ok "Security group: ${SG_ID}"

# Ingress: TCP 8080 from CloudFront prefix list. Idempotent — check first.
has_cf_ingress=$(aws_q ec2 describe-security-groups --group-ids "$SG_ID" \
  --query "SecurityGroups[0].IpPermissions[?ToPort==\`8080\` && contains(PrefixListIds[].PrefixListId, '${PREFIX_LIST_ID}')] | length(@)" \
  --output text)
if [[ "$has_cf_ingress" == "0" ]]; then
  log "Adding ingress 8080 from CloudFront prefix list to SG"
  aws_q ec2 authorize-security-group-ingress --group-id "$SG_ID" \
    --ip-permissions "IpProtocol=tcp,FromPort=8080,ToPort=8080,PrefixListIds=[{PrefixListId=${PREFIX_LIST_ID},Description=CloudFront-origin-facing}]" \
    >/dev/null
fi
ok "SG ingress wired (CloudFront → :8080)"

#### Launch template + ASG ####################################################

USER_DATA=$(cat <<UD
#!/bin/bash
set -euxo pipefail
echo "ECS_CLUSTER=${CLUSTER}" >> /etc/ecs/ecs.config
echo "ECS_ENABLE_CONTAINER_METADATA=true" >> /etc/ecs/ecs.config
TOKEN=\$(curl -s -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
INSTANCE_ID=\$(curl -sH "X-aws-ec2-metadata-token: \$TOKEN" http://169.254.169.254/latest/meta-data/instance-id)
aws --region ${AWS_REGION} ec2 associate-address \\
    --instance-id "\$INSTANCE_ID" \\
    --allocation-id ${EIP_ALLOC_ID} \\
    --allow-reassociation
UD
)
USER_DATA_B64=$(printf '%s' "$USER_DATA" | base64 | tr -d '\n')

LT_EXISTS=$(aws_q ec2 describe-launch-templates \
  --launch-template-names "$LT_NAME" \
  --query 'LaunchTemplates[0].LaunchTemplateId' --output text 2>/dev/null || echo None)

cat >"$WORK/lt-data.json" <<EOF
{
  "ImageId": "${ECS_AMI}",
  "InstanceType": "t3.micro",
  "IamInstanceProfile": { "Name": "${INSTANCE_PROFILE}" },
  "NetworkInterfaces": [
    {
      "DeviceIndex": 0,
      "AssociatePublicIpAddress": true,
      "Groups": ["${SG_ID}"]
    }
  ],
  "BlockDeviceMappings": [
    {
      "DeviceName": "/dev/xvda",
      "Ebs": { "VolumeSize": 30, "VolumeType": "gp3", "DeleteOnTermination": true }
    }
  ],
  "UserData": "${USER_DATA_B64}",
  "TagSpecifications": [
    {
      "ResourceType": "instance",
      "Tags": [
        { "Key": "Project",   "Value": "${PROJECT}" },
        { "Key": "Env",       "Value": "${ENV_NAME}" },
        { "Key": "ManagedBy", "Value": "bootstrap.sh" },
        { "Key": "Name",      "Value": "${PROJECT}-${ENV_NAME}-host" }
      ]
    }
  ],
  "MetadataOptions": {
    "HttpTokens": "required",
    "HttpEndpoint": "enabled",
    "HttpPutResponseHopLimit": 2
  }
}
EOF

if [[ "$LT_EXISTS" == "None" || -z "$LT_EXISTS" ]]; then
  log "Creating launch template ${LT_NAME}"
  aws_q ec2 create-launch-template \
    --launch-template-name "$LT_NAME" \
    --launch-template-data "file://${WORK}/lt-data.json" \
    --tag-specifications "ResourceType=launch-template,Tags=[{Key=Project,Value=${PROJECT}},{Key=Env,Value=${ENV_NAME}}]" \
    >/dev/null
else
  log "Launch template ${LT_NAME} exists — creating a new default version"
  NEW_LT_VERSION=$(aws_q ec2 create-launch-template-version \
    --launch-template-name "$LT_NAME" \
    --launch-template-data "file://${WORK}/lt-data.json" \
    --source-version 1 \
    --query 'LaunchTemplateVersion.VersionNumber' --output text)
  aws_q ec2 modify-launch-template \
    --launch-template-name "$LT_NAME" \
    --default-version "$NEW_LT_VERSION" >/dev/null
  ok "Launch template default → version ${NEW_LT_VERSION}"
fi
ok "Launch template ready"

# ASG
ASG_EXISTS=$(aws_q autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$ASG_NAME" \
  --query 'AutoScalingGroups[0].AutoScalingGroupName' --output text 2>/dev/null || echo None)

if [[ "$ASG_EXISTS" == "None" || -z "$ASG_EXISTS" ]]; then
  log "Creating ASG ${ASG_NAME} (min=1, max=1, desired=1)"
  aws_q autoscaling create-auto-scaling-group \
    --auto-scaling-group-name "$ASG_NAME" \
    --launch-template "LaunchTemplateName=${LT_NAME},Version=\$Default" \
    --min-size 1 --max-size 1 --desired-capacity 1 \
    --vpc-zone-identifier "$SUBNET_ID" \
    --health-check-type EC2 \
    --tags \
      "Key=Project,Value=${PROJECT},PropagateAtLaunch=true" \
      "Key=Env,Value=${ENV_NAME},PropagateAtLaunch=true" \
      "Key=ManagedBy,Value=bootstrap.sh,PropagateAtLaunch=true" \
      "Key=AmazonECSManaged,Value=true,PropagateAtLaunch=true"
else
  ok "ASG ${ASG_NAME} already exists"
fi

ASG_ARN=$(aws_q autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "$ASG_NAME" \
  --query 'AutoScalingGroups[0].AutoScalingGroupARN' --output text)

#### ECS cluster + capacity provider ##########################################

# ECS needs an account-level service-linked role before capacity providers work.
# Normally auto-created on first ECS use; create explicitly so the script works
# on a brand-new account. Idempotent — ignores "already exists" error.
if ! aws iam get-role --role-name AWSServiceRoleForECS >/dev/null 2>&1; then
  log "Creating ECS service-linked role (AWSServiceRoleForECS)"
  aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com >/dev/null 2>&1 || true
  # IAM eventually consistent — give it a moment to propagate before the next call
  sleep 5
fi

if aws_q ecs describe-clusters --clusters "$CLUSTER" \
     --query "clusters[?status=='ACTIVE'] | length(@)" --output text | grep -q '^1$'; then
  ok "ECS cluster ${CLUSTER} already active"
else
  log "Creating ECS cluster ${CLUSTER}"
  aws_q ecs create-cluster --cluster-name "$CLUSTER" \
    --settings "name=containerInsights,value=disabled" \
    --tags key=Project,value=$PROJECT key=Env,value=$ENV_NAME \
    >/dev/null
fi

CP_EXISTS=$(aws_q ecs describe-capacity-providers --capacity-providers "$CP_NAME" \
  --query 'capacityProviders[0].name' --output text 2>/dev/null || echo None)
if [[ "$CP_EXISTS" == "None" || -z "$CP_EXISTS" ]]; then
  log "Creating capacity provider ${CP_NAME}"
  aws_q ecs create-capacity-provider --name "$CP_NAME" \
    --auto-scaling-group-provider "autoScalingGroupArn=${ASG_ARN},managedScaling={status=DISABLED},managedTerminationProtection=DISABLED" \
    --tags key=Project,value=$PROJECT key=Env,value=$ENV_NAME \
    >/dev/null
else
  ok "Capacity provider ${CP_NAME} already exists"
fi

# Associate capacity provider as default strategy (idempotent)
aws_q ecs put-cluster-capacity-providers \
  --cluster "$CLUSTER" \
  --capacity-providers "$CP_NAME" \
  --default-capacity-provider-strategy "capacityProvider=${CP_NAME},weight=1,base=1" \
  >/dev/null
ok "Capacity provider attached to cluster"

#### SSM Parameter Store ######################################################

put_param() {
  local name="$1" type="$2" value="$3"
  local full="${SSM_PREFIX}/${name}"
  if aws_q ssm get-parameter --name "$full" >/dev/null 2>&1; then
    return 0   # exists — do not overwrite silently
  fi
  log "Seeding SSM param ${full} (${type})"
  aws_q ssm put-parameter --name "$full" --type "$type" --value "$value" \
    --tags "Key=Project,Value=${PROJECT}" "Key=Env,Value=${ENV_NAME}" \
    >/dev/null
}

put_param_prompt() {
  local name="$1" type="$2" prompt="$3"
  local full="${SSM_PREFIX}/${name}"
  if aws_q ssm get-parameter --name "$full" >/dev/null 2>&1; then
    ok "SSM param ${full} already set (skipping; use 'aws ssm put-parameter --overwrite' to rotate)"
    return 0
  fi
  local val
  if [[ "$type" == "SecureString" ]]; then
    read_secret val "${prompt}: "
  else
    read -r -p "${prompt}: " val
  fi
  if [[ -z "$val" ]]; then
    warn "Empty value for ${name} — skipping. Set it later with 'aws ssm put-parameter --name ${full} --type ${type} --value ...'"
    return 0
  fi
  aws_q ssm put-parameter --name "$full" --type "$type" --value "$val" \
    --tags "Key=Project,Value=${PROJECT}" "Key=Env,Value=${ENV_NAME}" \
    >/dev/null
  ok "SSM param ${full} set"
}

CLOUDFRONT_DOMAIN_PLACEHOLDER="REPLACE_AFTER_CLOUDFRONT_CREATED.cloudfront.net"

log "Seeding SSM parameters. Press Enter to skip any you'd like to set later."

put_param_prompt DATABASE_URL             SecureString "DATABASE_URL (admin DSN, sslmode=require)"
put_param_prompt APP_DATABASE_URL         SecureString "APP_DATABASE_URL (non-superuser DSN)"
put_param_prompt SESSION_SECRET           SecureString "SESSION_SECRET (run: openssl rand -hex 32)"
put_param_prompt GOOGLE_OAUTH_CLIENT_ID   SecureString "GOOGLE_OAUTH_CLIENT_ID"
put_param_prompt GOOGLE_OAUTH_CLIENT_SECRET SecureString "GOOGLE_OAUTH_CLIENT_SECRET"
# The redirect URL needs the CloudFront domain; we seed a placeholder and
# print instructions to update it once CloudFront is up.
put_param GOOGLE_OAUTH_REDIRECT_URL   String "https://${CLOUDFRONT_DOMAIN_PLACEHOLDER}/auth/google/callback"
put_param_prompt POST_LOGIN_REDIRECT_URL  String       "POST_LOGIN_REDIRECT_URL (e.g. https://your-app.vercel.app/)"
put_param_prompt CORS_ORIGINS             String       "CORS_ORIGINS (comma-sep, e.g. https://your-app.vercel.app)"
# Bootstraps the site-wide super admin(s). Anyone logging in with one of these
# emails gains /super console access. Comma-separated.
put_param_prompt PLATFORM_ADMIN_EMAILS    String       "PLATFORM_ADMIN_EMAILS (comma-sep super-admin emails)"

put_param_prompt STORAGE_S3_ENDPOINT          String       "STORAGE_S3_ENDPOINT (Supabase S3 endpoint)"
put_param_prompt STORAGE_S3_REGION            String       "STORAGE_S3_REGION (e.g. ap-south-1)"
put_param_prompt STORAGE_S3_BUCKET            String       "STORAGE_S3_BUCKET"
put_param_prompt STORAGE_S3_ACCESS_KEY_ID     SecureString "STORAGE_S3_ACCESS_KEY_ID"
put_param_prompt STORAGE_S3_SECRET_ACCESS_KEY SecureString "STORAGE_S3_SECRET_ACCESS_KEY"
put_param_prompt STORAGE_S3_PUBLIC_URL_BASE   String       "STORAGE_S3_PUBLIC_URL_BASE (public base URL for stored objects)"

#### initial task definition ##################################################

# Use a placeholder image tag for the first revision so the ECS service can be
# created. The first GitHub Actions run will register a real revision.
PLACEHOLDER_IMAGE="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}:bootstrap"
TD_TEMPLATE="$(cd "$(dirname "$0")" && pwd)/task-definition.json"
[[ -f "$TD_TEMPLATE" ]] || die "task-definition.json not found at ${TD_TEMPLATE}"

sed "s|<IMAGE>|${PLACEHOLDER_IMAGE}|g" "$TD_TEMPLATE" > "$WORK/td-rendered.json"

# Only register the initial revision if there is no existing revision yet.
EXISTING_TD=$(aws_q ecs list-task-definitions --family-prefix "$TASK_FAMILY" \
  --max-items 1 --query 'taskDefinitionArns[0]' --output text 2>/dev/null || echo None)

if [[ "$EXISTING_TD" == "None" || -z "$EXISTING_TD" ]]; then
  log "Registering initial task definition revision (placeholder image)"
  TD_ARN=$(aws_q ecs register-task-definition \
    --cli-input-json "file://${WORK}/td-rendered.json" \
    --query 'taskDefinition.taskDefinitionArn' --output text)
  ok "Task definition: ${TD_ARN}"
else
  TD_ARN="$EXISTING_TD"
  ok "Task definition family already has revisions: ${TD_ARN}"
fi

#### ECS service ##############################################################

SVC_STATUS=$(aws_q ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].status' --output text 2>/dev/null || echo MISSING)

if [[ "$SVC_STATUS" == "ACTIVE" ]]; then
  ok "ECS service ${SERVICE} already active"
elif [[ "$SVC_STATUS" == "INACTIVE" ]]; then
  warn "ECS service ${SERVICE} is INACTIVE (deleted). Recreating."
  SVC_STATUS=MISSING
fi

if [[ "$SVC_STATUS" == "MISSING" || "$SVC_STATUS" == "None" ]]; then
  log "Creating ECS service ${SERVICE} on cluster ${CLUSTER}"
  aws_q ecs create-service \
    --cluster "$CLUSTER" \
    --service-name "$SERVICE" \
    --task-definition "$TD_ARN" \
    --desired-count 1 \
    --capacity-provider-strategy "capacityProvider=${CP_NAME},weight=1,base=1" \
    --deployment-configuration "minimumHealthyPercent=0,maximumPercent=100,deploymentCircuitBreaker={enable=true,rollback=true}" \
    --scheduling-strategy REPLICA \
    --tags key=Project,value=$PROJECT key=Env,value=$ENV_NAME \
    >/dev/null
  ok "ECS service created"
fi

#### CloudFront distribution ##################################################

CF_CALLER_REF="${PROJECT}-${ENV_NAME}-bootstrap"
existing_cf=$(aws_q cloudfront list-distributions \
  --query "DistributionList.Items[?Origins.Items[0].DomainName=='${EIP_PUBLIC_DNS}'] | [0].{Id:Id,Domain:DomainName}" \
  --output json 2>/dev/null || echo '{}')
CF_ID=$(echo "$existing_cf" | jq -r '.Id // "None"')
CF_DOMAIN=$(echo "$existing_cf" | jq -r '.Domain // "None"')

if [[ "$CF_ID" == "None" || -z "$CF_ID" ]]; then
  log "Creating CloudFront distribution (origin ${EIP_PUBLIC_DNS}:8080)"
  cat >"$WORK/cf-dist.json" <<EOF
{
  "CallerReference": "${CF_CALLER_REF}-$(date +%s)",
  "Comment": "${PROJECT} API (${ENV_NAME})",
  "Enabled": true,
  "IsIPV6Enabled": true,
  "PriceClass": "PriceClass_100",
  "HttpVersion": "http2and3",
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "ec2-origin",
        "DomainName": "${EIP_PUBLIC_DNS}",
        "CustomOriginConfig": {
          "HTTPPort": 8080,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "http-only",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
          "OriginReadTimeout": 30,
          "OriginKeepaliveTimeout": 60
        },
        "ConnectionAttempts": 3,
        "ConnectionTimeout": 10
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "ec2-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 7,
      "Items": ["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET","HEAD"] }
    },
    "Compress": false,
    "CachePolicyId": "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
    "OriginRequestPolicyId": "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  },
  "ViewerCertificate": {
    "CloudFrontDefaultCertificate": true
  },
  "Restrictions": { "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 } },
  "WebACLId": ""
}
EOF
  CF_OUT=$(aws_q cloudfront create-distribution-with-tags --distribution-config-with-tags "{
    \"DistributionConfig\": $(cat "$WORK/cf-dist.json"),
    \"Tags\": { \"Items\": [
      {\"Key\":\"Project\",\"Value\":\"${PROJECT}\"},
      {\"Key\":\"Env\",\"Value\":\"${ENV_NAME}\"},
      {\"Key\":\"ManagedBy\",\"Value\":\"bootstrap.sh\"}
    ]}
  }")
  CF_ID=$(echo "$CF_OUT" | jq -r '.Distribution.Id')
  CF_DOMAIN=$(echo "$CF_OUT" | jq -r '.Distribution.DomainName')
  ok "CloudFront distribution: ${CF_ID}  (domain: ${CF_DOMAIN})"
  warn "CloudFront propagation takes 5-10 minutes. The /healthz check from the runbook will fail until status=Deployed."
else
  ok "CloudFront distribution already exists: ${CF_ID}  (domain: ${CF_DOMAIN})"
fi

# Now that we know the CloudFront domain, fix up the GOOGLE_OAUTH_REDIRECT_URL
# placeholder in SSM if it still points at the placeholder.
current_redirect=$(aws_q ssm get-parameter --name "${SSM_PREFIX}/GOOGLE_OAUTH_REDIRECT_URL" \
  --query 'Parameter.Value' --output text 2>/dev/null || echo "")
if [[ "$current_redirect" == *"REPLACE_AFTER_CLOUDFRONT_CREATED"* ]]; then
  log "Updating GOOGLE_OAUTH_REDIRECT_URL with real CloudFront domain"
  aws_q ssm put-parameter --name "${SSM_PREFIX}/GOOGLE_OAUTH_REDIRECT_URL" \
    --type String --value "https://${CF_DOMAIN}/auth/google/callback" \
    --overwrite >/dev/null
fi

#### outputs ##################################################################

cat <<OUT

================================================================
 cafe-mgmt bootstrap complete
================================================================
Region:                ${AWS_REGION}
Cluster:               ${CLUSTER}
Service:               ${SERVICE}
Task family:           ${TASK_FAMILY}
ECR repo:              ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}
EIP allocation:        ${EIP_ALLOC_ID}
EIP public IP:         ${EIP_PUBLIC_IP}
EIP public DNS:        ${EIP_PUBLIC_DNS}
CloudFront ID:         ${CF_ID}
CloudFront domain:     https://${CF_DOMAIN}
Log group:             ${LOG_GROUP}
GitHub deploy role:    arn:aws:iam::${ACCOUNT_ID}:role/${GHA_ROLE}
OIDC trust subject:    repo:${GITHUB_REPO}:ref:refs/heads/main

NEXT STEPS:

1. Add the CloudFront domain to .github/workflows/deploy-api.yml
   (env var CLOUDFRONT_HOST). The workflow already references
   ${GHA_ROLE} and the cluster/service names above.

2. In Google Cloud Console, add to your OAuth 2.0 Client:
     Authorized JavaScript origins:
       <your-vercel-app-url>
     Authorized redirect URIs:
       https://${CF_DOMAIN}/auth/google/callback

3. Build and push the first image from your laptop so the ECS
   service has something real to run:

     aws --profile goserve ecr get-login-password --region ${AWS_REGION} \\
       | docker login --username AWS --password-stdin \\
         ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

     docker buildx build --platform linux/amd64 \\
       -f infra/Dockerfile.api \\
       -t ${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}:bootstrap \\
       --push .

4. Trigger the deploy workflow (push to main, or run
   workflow_dispatch). Watch logs:

     aws logs tail ${LOG_GROUP} --since 10m --follow --region ${AWS_REGION}

5. Smoke test (after CloudFront status = Deployed, ~5-10 min):

     curl -fsS https://${CF_DOMAIN}/healthz

OUT
