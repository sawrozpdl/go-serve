# AWS deployment — operator runbook

> **This is the live production environment.** `infra/vps/` and `infra/coolify/`
> are proposals that have never been deployed, despite what their READMEs claim.
>
> **Topology below verified against the running system on 2026-08-08.** The
> sections describing *provisioning* (bootstrap, SSM, IAM) are as originally
> written and have not been re-verified end to end — treat them as a guide, and
> check reality with `aws` before acting on them.

Production target: AWS ECS-on-EC2 (`ap-south-1`), deployed automatically from
GitHub Actions on push to `main`. Frontend on Vercel (Git-integrated). DB on AWS
RDS (`go-serve`, Postgres 18.3, db.t4g.micro, single-AZ).

```
GitHub (push to main, apps/api/**) ──► ECR ──► migrate task ──► ECS service ──► EC2 t3.micro
                                                                                  cafe-mgmt-prod-host
                                                                                  EIP 35.154.3.43
                                                                                       │
Browser ──HTTPS──► Cloudflare ──HTTP──► EIP :80 ──► container :8080 ◄──────────────────┘
                   (proxied DNS,                    (bridge networking,
                    TLS at the edge)                 hostPort 80 → containerPort 8080)
```

**There is no CloudFront distribution** (`aws cloudfront list-distributions` →
`None`) and **no Caddy or sslip.io** in the production path — the edge is
**Cloudflare**, and `goserve.sarojpaudyal.com.np` resolves to Cloudflare IPs, never
to the EIP. `infra/Caddyfile` belongs to the unused VPS proposal. Earlier revisions
of this file described a CloudFront setup that has never existed; every mention of
CloudFront below is likewise historical unless it says otherwise.

Account: `782968043912`. Region: `ap-south-1`. Profile: `goserve`. ECR repo: `go-serve`.
Cluster `cafe-mgmt-prod`, service `api`, capacity provider `cafe-mgmt-prod-cp`,
instance `i-07c1c9627ee4349ad`.

**Ingress reality:** SG `sg-062f9ee6a0a9a3d4a` allows `:80` and `:443` from
`0.0.0.0/0` — not "from CloudFront only". The origin is directly reachable and
Cloudflare can be bypassed; `:443` is open but nothing listens on it. See
`docs/DEPLOY.md` → *Security* for this and for the exposed RDS.

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

> ⚠️ **The CloudFront half of this never happened.** The account has no CloudFront
> distributions. The edge that was actually adopted is **Cloudflare**, configured
> outside this repo (nameservers `irma`/`elmo.ns.cloudflare.com`), proxying
> `goserve.sarojpaudyal.com.np` → the EIP on port **80**.
>
> So: ignore the printed CloudFront domain and the next section. Wherever the rest
> of this file says `<cloudfront-host>`, the live value is
> `goserve.sarojpaudyal.com.np`.

### Wire the public origin into the deploy workflow

`.github/workflows/deploy-api.yml` has **no** `CLOUDFRONT_HOST`. The variable is
`env.API_PUBLIC_URL`, currently `https://goserve.sarojpaudyal.com.np`, used by the
smoke test. It must point at the API's own origin — pointing it at the Vercel app
silently disables the check, because Vercel's SPA catch-all answers any path with
`index.html` and a 200.

### Configure Google OAuth

In Google Cloud Console → APIs & Services → Credentials → your OAuth client:
- Authorized JavaScript origins: `https://goserve.vercel.app`
- Authorized redirect URIs: `https://goserve.sarojpaudyal.com.np/auth/google/callback`

Both match the live SSM values (`GOOGLE_OAUTH_REDIRECT_URL`, and
`POST_LOGIN_REDIRECT_URL=https://goserve.vercel.app/login/callback`). Override any
time:

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
curl -fsS https://goserve.sarojpaudyal.com.np/healthz   # → {"status":"ok"}
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

## Alerting (know before your customers)

Two layers, so an operational failure is never discovered by a customer first:

1. **In-app alerter** (`apps/api/internal/alert`) pushes the failures that matter to a
   webhook the moment they happen — OTP/shift-summary email send failures, handler panics,
   any `5xx`, and OTP rate-limit fail-open. Set the webhook to enable it:

   ```bash
   aws --profile goserve --region ap-south-1 ssm put-parameter \
     --name /cafe-mgmt/prod/ALERT_WEBHOOK_URL --type SecureString --overwrite \
     --value "https://hooks.slack.com/services/XXX/YYY/ZZZ"   # Slack/Mattermost incoming webhook
   # optional: --name /cafe-mgmt/prod/ALERT_THROTTLE --value "5m"  (min gap between same-event alerts)
   ```
   Add `ALERT_WEBHOOK_URL` (and optionally `ALERT_THROTTLE`) to the task definition's `secrets`
   / `environment`, then force a new deployment. Alerts are throttled per event to avoid storms.
   Adding a new alert later is one line: `alert.Fire(ctx, slog.LevelError, "some.event", err, …)`.

2. **CloudWatch → SNS email backstop** catches anything logged at ERROR even if the webhook
   path isn't hit — no code required. One-time setup:

   ```bash
   AWS_PROFILE=goserve ALERT_EMAIL=you@example.com bash infra/aws/setup-alerts.sh
   ```
   Creates an SNS topic + email subscription (confirm the email!), metric filters on the
   `/cafe-mgmt/api` JSON logs (`level=ERROR`, `otp.send_failed`, `shift_summary.send_failed`),
   and alarms → SNS. Idempotent; re-run any time.

## Cost expectations

While the t3.micro free-tier (12 months from account creation) is active:

| Item                              | Free? | Notes |
|-----------------------------------|-------|-------|
| EC2 t3.micro (750 h/mo)           | yes   | t3.micro free-tier covers one always-on instance |
| EBS 30 GiB gp3                    | yes   | up to 30 GiB free for 12 mo |
| Elastic IP (attached)             | yes   | $3.60/mo if you stop/detach |
| ECR storage (≤500 MiB)            | yes   | larger after 12 mo costs ~$0.10/GB-mo |
| ~~CloudFront 1 TB/mo + 10M req/mo~~ | n/a | **not used** — the edge is Cloudflare (free plan), outside AWS billing |
| SSM Parameter Store (Standard)    | yes   | unlimited Standard params |
| CloudWatch Logs                   | mostly | 5 GB ingest free; ours is tiny |
| ECS (service-level)               | yes   | only pay for the underlying compute |

Post-free-tier (after 12 months): ~$8/mo for compute + EBS, plus pennies for everything else.

---

## Known caveats

### 1. `ROOT_DOMAIN=localhost` is a deliberate sentinel

Live value: `ROOT_DOMAIN=localhost`, `SESSION_COOKIE_SAMESITE=none`.

The original reasoning cited `internal/auth/session.go:143` and a `cookieDomain`
helper — **neither exists any more**; migration 0020 replaced cookie sessions with
JWTs (access + rotating refresh). `RootDomain` now feeds exactly two things
(`internal/httpx/router.go`):

- `auth.NewGoogle(...)` — the Google OAuth handoff cookie, the only `http.SetCookie`
  left in the codebase (`internal/auth/google.go`).
- `tenant.Middleware` / `tenant.OptionalMiddleware` — subdomain tenant resolution,
  which `localhost` disables. Harmless: the FE sends `X-Tenant-ID`.

So the sentinel still does something, but do not reason about session auth from it —
read `internal/auth/jwt.go`. If a real registrable domain is ever shared by the FE
and API, set `ROOT_DOMAIN` to it and reconsider `SameSite`.

### 2. Deploys have ~30-60s of downtime

Confirmed live: `minimumHealthyPercent: 0`, `maximumPercent: 100`, `desiredCount: 1`,
bridge networking on a fixed host port (`80`, not `8080` — the container listens on
`8080` and publishes to host `80`). The old task must stop before the new one starts,
so users see errors from Cloudflare during the rollover. Structural, not a tuning
oversight. Fix: `awsvpc` + ALB + multi-task scheduling.

The deployment circuit breaker is enabled with `rollback: true`, so a task that never
reaches a steady state reverts automatically.

### 3. WebSocket connections die at 60s — the mitigation is not working

`internal/realtime/hub.go:178` does tick a 25 s `pingTicker` per client, as
previously documented. **It is not achieving the goal.** Every `/ws` request in
CloudWatch closes at `dur_ms ≈ 60000`:

```
28 "dur_ms":60000     5 "dur_ms":60002     4 "dur_ms":60004
```

Something enforces a hard ~60 s cap that a 25 s application-level ping does not
reset — most likely the Cloudflare edge for this plan/config, since there is no
CloudFront and the origin is a bare Go server. Clients reconnect once a minute,
which works but is wasteful and shows up as constant `/ws` + `/v1/ws-ticket`
churn in the logs.

Not diagnosed further. Anyone picking this up: confirm whether the cap is at
Cloudflare (compare against `http://35.154.3.43` directly, bypassing the edge)
before changing the ticker, because the ticker is not the variable that matters.

### 4. Vercel preview URLs won't pass CORS

`chi/cors` does exact match against `CORS_ORIGINS`. Preview deploys (`https://cafe-mgmt-git-<branch>-<team>.vercel.app`) won't match a single literal. To support previews, extend `apps/api/internal/httpx/router.go` with `AllowOriginFunc` and regex-match `*.vercel.app` for a known team slug.

### 5. `iam:PassRole` is in the deploy role

The GitHub Actions deploy role has `iam:PassRole` on `ecsTaskExecutionRole` and `ecsTaskRole` scoped to `iam:PassedToService=ecs-tasks.amazonaws.com`. Anyone with write access to `.github/workflows/deploy-api.yml` can change the task definition. Keep `main` branch protected.

### 6. OIDC trust is pinned to `refs/heads/main`

If you rename `main` (e.g. to `master`), deploys silently 403 until you update the role's trust policy. Find it in IAM → Roles → `github-oidc-deploy-cafe-mgmt` → Trust relationships.

### 7. SSM parameter deletion has no AWS-managed backup

SSM versions parameters (rollback to v3 with `--version 3`), but a full `delete-parameter` removes all versions. Keep an out-of-band copy of `SESSION_SECRET` and the two DB URLs (1Password, `pass`, etc.).

### 8. ⚠️ The production database is reachable from the internet

Verified 2026-08-08. RDS `go-serve` is `PubliclyAccessible: true` and has an
Elastic IP (`15.207.143.87`) on its ENI. It sits in the **default VPC security
group** `sg-0d5c084d149806f7d`, whose ingress is:

| Rule | Source | Intent |
|---|---|---|
| `tcp/5432` | `sg-062f9ee6a0a9a3d4a` (API SG) | what the API actually uses |
| **`-1` (all ports, all protocols)** | **`0.0.0.0/0`** | ⚠️ the problem |

`nc -z go-serve.cj6iw4egiytq.ap-south-1.rds.amazonaws.com 5432` succeeds from an
arbitrary host on the internet. Only the database password protects production
data. Earlier revisions of these docs asserted the RDS was "SG-locked to the API
SG"; it is not, and has not been.

**Fix** — nothing but the RDS ENI uses that SG, and the specific 5432 rule is what
the API relies on, so revoking the allow-all is safe:

```bash
aws --profile goserve --region ap-south-1 ec2 revoke-security-group-ingress \
  --group-id sg-0d5c084d149806f7d --protocol -1 --port -1 --cidr 0.0.0.0/0
```

Verify afterwards that `/healthz` still returns `{"status":"ok"}` and that `nc` to
5432 now hangs. Consider also setting `PubliclyAccessible: false` and releasing the
RDS Elastic IP.

### 9. No multi-AZ, no DR

Single t3.micro in one AZ. An `ap-south-1a` outage takes us down. Acceptable for this stage; upgrade to ALB + multi-AZ ASG + `awsvpc` if/when traffic warrants the ~$16/mo extra.

---

## Custom domain — already done, via Cloudflare

This section used to describe bringing a domain online with ACM + CloudFront +
Route 53. **None of that was used.** The custom domain is already live on
**Cloudflare**, which is not managed from this repo:

- DNS is hosted at Cloudflare (`irma`/`elmo.ns.cloudflare.com`).
- `goserve.sarojpaudyal.com.np` is a **proxied** record pointing at the EIP
  `35.154.3.43`; it resolves to Cloudflare addresses, never to the origin.
- Cloudflare terminates TLS and talks to the origin over **plain HTTP on :80**.
  There is no cert on the origin, so Cloudflare SSL mode cannot be
  "Full (strict)" as configured today.

To change the API's hostname, do it in the Cloudflare dashboard, then update in
this repo / AWS:

1. `env.API_PUBLIC_URL` in `.github/workflows/deploy-api.yml` (the smoke test).
2. SSM `GOOGLE_OAUTH_REDIRECT_URL`, and the matching entry in Google Console.
3. SSM `CORS_ORIGINS` if the **frontend** origin changed (it lists the SPA's
   origin, not the API's).
4. `VITE_API_BASE_URL` / `VITE_WS_BASE_URL` in `apps/web/.env.production`, then
   redeploy the SPA — these are baked into the bundle at build time.
5. `ROOT_DOMAIN` **only** if the FE and API come to share a registrable domain;
   see *Known caveats §1* for what it actually controls now.
6. `aws ecs update-service --force-new-deployment` to pick up new env.

HSTS, if wanted, is a Cloudflare setting.
