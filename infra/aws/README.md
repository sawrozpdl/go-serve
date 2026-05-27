# AWS deployment — operator runbook

Production target: AWS ECS-on-EC2 (`ap-south-1`) fronted by Caddy + sslip.io (or CloudFront once verified), deployed automatically from GitHub Actions. Frontend on Vercel (Git-integrated). DB on AWS RDS (`go-serve`, Postgres 18, single-AZ free tier).

```
GitHub (push to main) ──► ECR ──► ECS service ──► EC2 (t3.micro + EIP)
                                                       │
                                                       └─ inbound :8080 from CloudFront only

Browser ──► CloudFront (default *.cloudfront.net cert) ──► origin :8080 (HTTP)
```

Account: `782968043912`. Region: `ap-south-1`. Profile: `goserve`. ECR repo: `go-serve`.

## Files in this directory

- `bootstrap.sh` — idempotent one-time provisioner.
- `teardown.sh` — releases everything bootstrap created (except ECR images + IAM roles).
- `task-definition.json` — template referenced by `bootstrap.sh` and the GitHub Actions workflow. `<IMAGE>` is substituted at deploy time.

The GitHub Actions workflow lives at `.github/workflows/deploy-api.yml`.

---

## Prereqs (local)

- AWS CLI v2 installed
- `~/.aws/credentials` profile `goserve` with **root** credentials (or scoped admin) bound to account `782968043912`
- `jq`
- Docker with buildx (only needed for the very first manual image push)

Verify:

```bash
aws --profile goserve sts get-caller-identity   # Account must be 782968043912
```

---

## First-time bootstrap

```bash
cd <repo-root>
AWS_PROFILE=goserve bash infra/aws/bootstrap.sh
```

The script is interactive — it prompts for each SSM SecureString. Skip any you'd like to set later by pressing Enter; you can add them with `aws ssm put-parameter` afterwards.

When it finishes it prints:
- The CloudFront domain (note this down)
- The EIP public DNS
- The GitHub deploy role ARN
- The OIDC trust subject pattern

### Wire CloudFront into the deploy workflow

Open `.github/workflows/deploy-api.yml` and set `env.CLOUDFRONT_HOST` to the printed domain (e.g. `d12abc3def45.cloudfront.net`). Commit.

### Configure Google OAuth

In Google Cloud Console → APIs & Services → Credentials → your OAuth client:
- Authorized JavaScript origins: `https://<your-vercel-app>.vercel.app`
- Authorized redirect URIs: `https://<cloudfront-host>/auth/google/callback`

`bootstrap.sh` already seeded `GOOGLE_OAUTH_REDIRECT_URL` in SSM with the CloudFront domain — but you can override it any time:

```bash
aws --profile goserve ssm put-parameter \
  --name /cafe-mgmt/prod/GOOGLE_OAUTH_REDIRECT_URL \
  --type String --overwrite \
  --value "https://<host>/auth/google/callback"
```

### First image push (manual, one time)

The ECS service needs at least one real image before it can run any task. After bootstrap, push from your laptop:

```bash
aws --profile goserve ecr get-login-password --region ap-south-1 \
  | docker login --username AWS --password-stdin \
    782968043912.dkr.ecr.ap-south-1.amazonaws.com

docker buildx build --platform linux/amd64 \
  -f infra/Dockerfile.api \
  -t 782968043912.dkr.ecr.ap-south-1.amazonaws.com/go-serve:bootstrap \
  --push .
```

Then trigger the deploy workflow once (push a no-op to `main`, or run it via the Actions tab → `deploy-api` → Run workflow). After that, every push to `main` that touches `apps/api/**` or `infra/Dockerfile.api` deploys automatically.

### Smoke test

```bash
curl -fsS https://<cloudfront-host>/healthz
# → {"status":"ok"}
```

CloudFront propagation takes 5–10 min after first creation. The check will return 502/504 until status reaches `Deployed`.

---

## Day-2 operations

### View live logs

```bash
aws --profile goserve --region ap-south-1 logs tail /cafe-mgmt/api --since 10m --follow
```

### SSH into the EC2 host (without opening port 22)

```bash
INSTANCE_ID=$(aws --profile goserve --region ap-south-1 ec2 describe-instances \
  --filters Name=tag:Project,Values=cafe-mgmt Name=tag:Env,Values=prod Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)

aws --profile goserve --region ap-south-1 ssm start-session --target "$INSTANCE_ID"
```

Requires the AWS SSM Session Manager plugin: `brew install --cask session-manager-plugin`.

### Rotate a secret

```bash
aws --profile goserve --region ap-south-1 ssm put-parameter \
  --name /cafe-mgmt/prod/SESSION_SECRET \
  --type SecureString --overwrite \
  --value "$(openssl rand -hex 32)"

# Force the running service to pick up the new value (env is read at container start)
aws --profile goserve --region ap-south-1 ecs update-service \
  --cluster cafe-mgmt-prod --service api --force-new-deployment
```

Rotating `SESSION_SECRET` invalidates every active session.

### List all parameters

```bash
aws --profile goserve --region ap-south-1 ssm get-parameters-by-path \
  --path /cafe-mgmt/prod --recursive \
  --query 'Parameters[].Name'
```

### Manual deploy fallback (if GitHub Actions is down)

```bash
SHA=$(git rev-parse HEAD)

aws --profile goserve ecr get-login-password --region ap-south-1 \
  | docker login --username AWS --password-stdin 782968043912.dkr.ecr.ap-south-1.amazonaws.com

docker buildx build --platform linux/amd64 \
  -f infra/Dockerfile.api \
  -t 782968043912.dkr.ecr.ap-south-1.amazonaws.com/go-serve:$SHA \
  --push .

sed "s|<IMAGE>|782968043912.dkr.ecr.ap-south-1.amazonaws.com/go-serve:$SHA|" \
  infra/aws/task-definition.json > /tmp/td.json

NEW_TD=$(aws --profile goserve --region ap-south-1 ecs register-task-definition \
  --cli-input-json file:///tmp/td.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)

# Migrate
TASK=$(aws --profile goserve --region ap-south-1 ecs run-task \
  --cluster cafe-mgmt-prod \
  --capacity-provider-strategy capacityProvider=cafe-mgmt-prod-cp,weight=1 \
  --task-definition "$NEW_TD" \
  --overrides '{"containerOverrides":[{"name":"api","command":["/app/migrate","up"],"memory":192,"memoryReservation":128}]}' \
  --query 'tasks[0].taskArn' --output text)
aws --profile goserve --region ap-south-1 ecs wait tasks-stopped --cluster cafe-mgmt-prod --tasks "$TASK"

# Deploy
aws --profile goserve --region ap-south-1 ecs update-service \
  --cluster cafe-mgmt-prod --service api --task-definition "$NEW_TD" --force-new-deployment
aws --profile goserve --region ap-south-1 ecs wait services-stable \
  --cluster cafe-mgmt-prod --services api
```

### Rollback to the previous image

```bash
PREV=$(aws --profile goserve --region ap-south-1 ecs list-task-definitions \
  --family-prefix cafe-mgmt-api --sort DESC --max-items 2 \
  --query 'taskDefinitionArns[1]' --output text)

aws --profile goserve --region ap-south-1 ecs update-service \
  --cluster cafe-mgmt-prod --service api --task-definition "$PREV" --force-new-deployment
```

### Tear it all down

```bash
AWS_PROFILE=goserve bash infra/aws/teardown.sh
# Prompts; type DESTROY to proceed.
```

ECR images and IAM roles are left in place so you can rebuild without re-uploading or re-trusting GitHub.

---

## Transactional email (SES via SMTP)

Shift-end summaries and OTP login codes go through AWS SES (`ap-south-1`).
The Go mailer speaks vanilla SMTP, so switching providers later only needs
new env values — never a code change.

**Prod wiring lives in SSM:**

```
/cafe-mgmt/prod/MAIL_SMTP_HOST       (SecureString) — email-smtp.ap-south-1.amazonaws.com
/cafe-mgmt/prod/MAIL_SMTP_USERNAME   (SecureString) — IAM access key ID of cafe-mgmt-ses-smtp
/cafe-mgmt/prod/MAIL_SMTP_PASSWORD   (SecureString) — SES SMTP password derived from that key's secret
/cafe-mgmt/prod/MAIL_FROM            (String)       — verified sender
```

`cafe-mgmt-ses-smtp` is a least-privilege IAM user with one inline policy
granting `ses:SendRawEmail`. Rotate by generating a second access key,
deriving its SMTP password (`AWS4` HMAC-SHA256 v4 — see commit 0017 history
for the script), updating SSM, force-new-deployment, then deleting the old
key.

### SES sandbox vs production access

New SES accounts start in **sandbox**: only verified recipients receive
mail. While in sandbox the only people who can OTP-in are those you've
verified in the SES console under "Verified identities". To unlock global
delivery, request production access from the SES console — usually granted
within 24h.

### Switching providers (Resend, Postmark, Mailgun, SendGrid, …)

Update the four SSM params to point at the new relay; no code change. The
Go runtime reads `SENDGRID_API_KEY` first then falls back to
`MAIL_SMTP_PASSWORD`, so either path works:

```bash
aws --profile goserve --region ap-south-1 ssm put-parameter \
  --name /cafe-mgmt/prod/MAIL_SMTP_HOST --type SecureString --overwrite \
  --value "smtp.resend.com"  # or smtp.sendgrid.net, smtp.postmarkapp.com, etc.

aws --profile goserve --region ap-south-1 ssm put-parameter \
  --name /cafe-mgmt/prod/MAIL_SMTP_USERNAME --type SecureString --overwrite \
  --value "resend"  # provider-specific username

aws --profile goserve --region ap-south-1 ssm put-parameter \
  --name /cafe-mgmt/prod/MAIL_SMTP_PASSWORD --type SecureString --overwrite \
  --value "re_xxxxxxxxxxxx"  # provider-specific password/API key

aws --profile goserve --region ap-south-1 ecs update-service \
  --cluster cafe-mgmt-prod --service api --force-new-deployment
```

---

## Cost expectations

While the t3.micro free-tier (12 months from account creation) is active:

| Item                              | Free? | Notes |
|-----------------------------------|-------|-------|
| EC2 t3.micro (750 h/mo)           | yes   | t3.micro free-tier covers one always-on instance |
| EBS 30 GiB gp3                    | yes   | up to 30 GiB free for 12 mo |
| Elastic IP (attached)             | yes   | $3.60/mo if you stop/detach |
| ECR storage (≤500 MiB)            | yes   | larger after 12 mo costs ~$0.10/GB-mo |
| CloudFront 1 TB/mo + 10M req/mo   | yes   | free tier for 12 mo |
| SSM Parameter Store (Standard)    | yes   | unlimited Standard params |
| CloudWatch Logs                   | mostly | 5 GB ingest free; ours is tiny |
| ECS (service-level)               | yes   | only pay for the underlying compute |

Post-free-tier (after 12 months): ~$8/mo for compute + EBS, plus pennies for everything else.

---

## Known caveats

### 1. `ROOT_DOMAIN=localhost` is a deliberate sentinel

`apps/api/internal/auth/session.go:143` sets the session cookie's `Domain` attribute to `."+ROOT_DOMAIN` whenever `ROOT_DOMAIN` contains a dot. `cloudfront.net` is on the Public Suffix List, so setting `ROOT_DOMAIN=dxxx.cloudfront.net` would make browsers silently drop the cookie. Workaround: set `ROOT_DOMAIN=localhost` in prod so `cookieDomain` returns `""` and the cookie is host-only. Subdomain-based tenant resolution is silently disabled — the FE already sends `X-Tenant-ID` so it doesn't matter on the default CloudFront domain.

When/if a custom domain is brought online, change `ROOT_DOMAIN` to the real registrable domain (e.g. `cafe.app`) in the task definition.

### 2. Deploys have ~30-60s of downtime

The service uses bridge networking with fixed `hostPort=8080` and `desiredCount=1`. With `minimumHealthyPercent=0` the old task must stop before the new one can start. Real users will see a CloudFront 502/504 during the rollover. Acceptable for this stage. Fix later: switch to `awsvpc` + ALB + multi-task scheduling.

### 3. WebSocket idle timeouts

CDNs drop idle WS connections (CloudFront at 60 s, Cloudflare at ~100 s). The hub already mitigates this — `apps/api/internal/realtime/hub.go` ticks a 25 s `pingTicker` per client and sends a protocol-level ping with a 5 s timeout. If you swap CDNs to one with a tighter idle window, shorten the ticker accordingly.

### 4. Vercel preview URLs won't pass CORS

`chi/cors` does exact match against `CORS_ORIGINS`. Preview deploys (`https://cafe-mgmt-git-<branch>-<team>.vercel.app`) won't match a single literal. To support previews, extend `apps/api/internal/httpx/router.go` with `AllowOriginFunc` and regex-match `*.vercel.app` for a known team slug.

### 5. `iam:PassRole` is in the deploy role

The GitHub Actions deploy role has `iam:PassRole` on `ecsTaskExecutionRole` and `ecsTaskRole` scoped to `iam:PassedToService=ecs-tasks.amazonaws.com`. Anyone with write access to `.github/workflows/deploy-api.yml` can change the task definition. Keep `main` branch protected.

### 6. OIDC trust is pinned to `refs/heads/main`

If you rename `main` (e.g. to `master`), deploys silently 403 until you update the role's trust policy. Find it in IAM → Roles → `github-oidc-deploy-cafe-mgmt` → Trust relationships.

### 7. SSM parameter deletion has no AWS-managed backup

SSM versions parameters (rollback to v3 with `--version 3`), but a full `delete-parameter` removes all versions. Keep an out-of-band copy of `SESSION_SECRET` and the two DB URLs (1Password, `pass`, etc.).

### 8. No multi-AZ, no DR

Single t3.micro in one AZ. An `ap-south-1a` outage takes us down. Acceptable for this stage; upgrade to ALB + multi-AZ ASG + `awsvpc` if/when traffic warrants the ~$16/mo extra.

---

## Upgrading to a custom domain

When you bring a real domain (e.g. `api.cafe.app`):

1. Request an ACM cert in **us-east-1** (CloudFront only reads from us-east-1). DNS-validate via Route 53 (or your registrar).
2. Edit the CloudFront distribution: add the domain as an Alternate Domain Name (CNAME), attach the cert, deploy.
3. Add a Route 53 ALIAS (or CNAME at your registrar) from `api.cafe.app` → CloudFront distribution domain.
4. Update SSM:
   - `ROOT_DOMAIN=cafe.app` (no leading dot)
   - `GOOGLE_OAUTH_REDIRECT_URL=https://api.cafe.app/auth/google/callback` (and update Google Console)
5. `aws ecs update-service --force-new-deployment` to pick up new env.
6. Optionally enable HSTS via a CloudFront response headers policy after you've verified end-to-end.
