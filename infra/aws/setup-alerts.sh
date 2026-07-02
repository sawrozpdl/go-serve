#!/usr/bin/env bash
# setup-alerts.sh — idempotent CloudWatch → SNS alerting for the cafe-mgmt API.
#
# This is the AWS-native backstop for the in-app alerter (apps/api/internal/alert):
# even code paths that don't push a webhook alert still log at ERROR, and those
# logs trip a CloudWatch alarm that emails you. So you learn about failures
# before customers do — with zero code changes for future issues.
#
# Creates (all guarded / overwrite-safe):
#   - SNS topic  ${PROJECT}-${ENV_NAME}-alerts  + an email subscription
#   - CloudWatch metric filters on the ${LOG_GROUP} JSON logs:
#       * every ERROR record            -> ApiErrorLogs
#       * otp.send_failed               -> OtpSendFailed
#       * shift_summary.send_failed     -> ShiftSummarySendFailed
#   - CloudWatch alarms on each metric -> the SNS topic
#
# Usage:
#     AWS_PROFILE=goserve ALERT_EMAIL=you@example.com bash infra/aws/setup-alerts.sh
#
# Env overrides (rarely needed):
#     AWS_REGION   (default: ap-south-1)
#     PROJECT      (default: cafe-mgmt)
#     ENV_NAME     (default: prod)
#     ALERT_EMAIL  (default: spaudyal@supercare.com)

set -euo pipefail

AWS_REGION="${AWS_REGION:-ap-south-1}"
PROJECT="${PROJECT:-cafe-mgmt}"
ENV_NAME="${ENV_NAME:-prod}"
ALERT_EMAIL="${ALERT_EMAIL:-spaudyal@supercare.com}"

LOG_GROUP="/${PROJECT}/api"
TOPIC_NAME="${PROJECT}-${ENV_NAME}-alerts"
METRIC_NS="CafeMgmt/API"

log()  { printf '\033[36m▸ %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m! %s\033[0m\n' "$*"; }
aws_q() { aws --region "$AWS_REGION" "$@"; }

#### SNS topic + email subscription ###########################################

log "Ensuring SNS topic ${TOPIC_NAME}"
TOPIC_ARN=$(aws_q sns create-topic --name "$TOPIC_NAME" \
  --tags "Key=Project,Value=${PROJECT}" "Key=Env,Value=${ENV_NAME}" "Key=ManagedBy,Value=setup-alerts.sh" \
  --query 'TopicArn' --output text)
ok "Topic: ${TOPIC_ARN}"

# Subscribe the email only if it isn't already subscribed (confirmed or pending).
EXISTING=$(aws_q sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
  --query "Subscriptions[?Endpoint=='${ALERT_EMAIL}'] | length(@)" --output text 2>/dev/null || echo 0)
if [ "$EXISTING" != "0" ]; then
  ok "Email ${ALERT_EMAIL} already subscribed"
else
  log "Subscribing ${ALERT_EMAIL}"
  aws_q sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
  warn "Confirmation email sent to ${ALERT_EMAIL} — click the link or no alerts will arrive."
fi

#### Metric filters ###########################################################
# slog JSON emits {"level":"ERROR","msg":"<event>", ...}. defaultValue=0 keeps
# the metric populated so alarms evaluate instead of sitting INSUFFICIENT_DATA.

put_filter() {
  local name="$1" pattern="$2" metric="$3"
  log "Metric filter ${name} -> ${metric}"
  aws_q logs put-metric-filter \
    --log-group-name "$LOG_GROUP" \
    --filter-name "$name" \
    --filter-pattern "$pattern" \
    --metric-transformations \
      "metricName=${metric},metricNamespace=${METRIC_NS},metricValue=1,defaultValue=0"
  ok "Filter ${name} set"
}

put_filter "${PROJECT}-${ENV_NAME}-error-logs"     '{ $.level = "ERROR" }'                 "ApiErrorLogs"
put_filter "${PROJECT}-${ENV_NAME}-otp-failed"     '{ $.msg = "otp.send_failed" }'         "OtpSendFailed"
put_filter "${PROJECT}-${ENV_NAME}-shift-failed"   '{ $.msg = "shift_summary.send_failed" }' "ShiftSummarySendFailed"

#### Alarms ###################################################################

put_alarm() {
  local name="$1" metric="$2" period="$3" desc="$4"
  log "Alarm ${name}"
  aws_q cloudwatch put-metric-alarm \
    --alarm-name "$name" \
    --alarm-description "$desc" \
    --namespace "$METRIC_NS" \
    --metric-name "$metric" \
    --statistic Sum \
    --period "$period" \
    --evaluation-periods 1 \
    --threshold 1 \
    --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching \
    --alarm-actions "$TOPIC_ARN" \
    --ok-actions "$TOPIC_ARN"
  ok "Alarm ${name} set"
}

put_alarm "${PROJECT}-${ENV_NAME}-api-errors"    "ApiErrorLogs"           300 "Any ERROR-level API log in the last 5 min"
put_alarm "${PROJECT}-${ENV_NAME}-otp-failed"    "OtpSendFailed"          300 "OTP login email failed to send — users may be locked out"
put_alarm "${PROJECT}-${ENV_NAME}-shift-failed"  "ShiftSummarySendFailed" 900 "Shift-summary email failed to send"

echo
ok "Alerting configured. Topic: ${TOPIC_ARN}"
warn "If you just subscribed, confirm the email before relying on alarms."
