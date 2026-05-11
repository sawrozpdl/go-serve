# Deploying cafe-mgmt to production

The production target is:

| Component | Service                                    | Why |
|-----------|--------------------------------------------|-----|
| API (Go)  | **AWS ECS-on-EC2** behind **Caddy + sslip.io** (or CloudFront) | Free-tier eligible (t3.micro). sslip.io + Let's Encrypt = free HTTPS; swap in CloudFront once verified. |
| Postgres  | **AWS RDS** (`go-serve`, db.t4g.micro)     | Same account, single-AZ free tier (750 h/mo for 12 mo), `sslmode=require`. |
| Frontend  | **Vercel** (Git-integrated, auto-deploy)   | Static SPA, free tier, instant global, preview deploys per PR. |
| Image storage | **Supabase Storage** (S3-compatible)  | One bucket today; swap to AWS S3 later by changing SSM `STORAGE_S3_*` only. |

This split keeps the API close to its DB (low latency in `ap-south-1`) and uses Vercel for what it's best at: serving a static Vite bundle globally with edge caching.

> The full operator runbook (bootstrap, secret rotation, manual fallbacks,
> teardown, known caveats) lives in `infra/aws/README.md`. This document is
> the higher-level "what + why".

---

## Architecture

```
GitHub (push to main)
   │  OIDC federation
   ▼
GitHub Actions ──► ECR (go-serve:<sha>) ──► ECS service ──► EC2 (t3.micro + EIP)
                                                                  │
Browser ──HTTPS──► CloudFront ──HTTP──► EIP:8080 ◄────────────────┘
                  (default *.cloudfront.net cert)        (SG ingress: CloudFront only)
```

- **Account**: `782968043912` (`AWS_PROFILE=goserve`, root).
- **Region**: `ap-south-1`.
- **ECR repo**: `go-serve` (already exists; the API image lives here).
- **RDS**: `go-serve.cj6iw4egiytq.ap-south-1.rds.amazonaws.com:5432`, Postgres 18, publicly accessible at the VPC level but SG-locked to the API SG (`sg-062f9ee6a0a9a3d4a`). `sslmode=require`.
- **CI auth**: GitHub Actions assumes a scoped IAM role via OIDC — no long-lived keys in repo secrets.
- **Secrets**: SSM Parameter Store under `/cafe-mgmt/prod/*`. Loaded into the container by the ECS execution role at task start.

For the gritty list of resources (IAM roles, log group, capacity provider, etc.), see `infra/aws/README.md`.

---

## One-time bootstrap

From the repo root with the `goserve` profile configured:

```bash
AWS_PROFILE=goserve bash infra/aws/bootstrap.sh
```

The script is idempotent and interactive — it prompts for each SSM SecureString (DB URLs, Google OAuth secrets, Supabase Storage keys, etc.). On exit it prints:

- The CloudFront domain (e.g. `d12abc3def45.cloudfront.net`).
- The Elastic IP public DNS (CloudFront origin).
- The IAM role ARN for GitHub Actions.

Take the CloudFront domain and:

1. Paste it into `.github/workflows/deploy-api.yml` → `env.CLOUDFRONT_HOST`.
2. Add `https://<cf-host>/auth/google/callback` to Google Cloud Console → Credentials → your OAuth client → Authorized redirect URIs.
3. Add `https://<vercel-app>.vercel.app` to the same client's Authorized JavaScript origins.
4. Set Vercel's `VITE_API_BASE_URL` to `https://<cf-host>` and redeploy the FE.

Push to `main` once (any change in `apps/api/**` triggers the deploy workflow). The first build will take ~3-5 min (cold cache).

---

## Domain topology and cookies (read this once)

The session cookie's `Domain` attribute is driven by `ROOT_DOMAIN` (`apps/api/internal/auth/session.go`). Three deployment modes:

### A. CloudFront default domain (current setup)

```
FE: https://<vercel>.vercel.app
API: https://<dxxx>.cloudfront.net
```

`*.cloudfront.net` is on the Public Suffix List, so a cookie with `Domain=.dxxx.cloudfront.net` is rejected by browsers. We set `ROOT_DOMAIN=localhost` as a sentinel to force a host-only cookie. Cross-site so `SESSION_COOKIE_SAMESITE=none` (which auto-enables `Secure`).

```
ROOT_DOMAIN=localhost
CORS_ORIGINS=https://<vercel-app-url>
SESSION_COOKIE_SAMESITE=none
```

### B. Custom domain, sister subdomains (recommended once you own a domain)

```
FE: https://app.cafe.app    (Vercel + CNAME)
API: https://api.cafe.app   (CloudFront + ACM + Route 53)
```

Same-site cookies (`SameSite=Lax`) work because both hosts share registrable domain `cafe.app`.

```
ROOT_DOMAIN=cafe.app
CORS_ORIGINS=https://app.cafe.app
SESSION_COOKIE_SAMESITE=lax
```

Migration steps for switching to a custom domain are in `infra/aws/README.md`.

### C. Custom API domain, Vercel FE (fully cross-site)

```
FE: https://<vercel>.vercel.app
API: https://api.cafe.app
```

```
ROOT_DOMAIN=api.cafe.app       # host-only cookie
CORS_ORIGINS=https://<vercel>.vercel.app
SESSION_COOKIE_SAMESITE=none
```

---

## Frontend deploy (Vercel)

Vercel already understands the `apps/web/vercel.json` config. Wire one repo secret:

| Env var               | Value                          |
|-----------------------|--------------------------------|
| `VITE_API_BASE_URL`   | `https://<cloudfront-host>`    |

`VITE_API_BASE_URL` is baked into the bundle at build time, so changing the API URL requires a fresh Vercel deploy.

---

## Migrations

The Go image contains two binaries: `/app/server` (default) and `/app/migrate`. Every API deploy first runs a one-shot ECS task with the `migrate` binary against the same image SHA before updating the service. If migrations fail, the service is not updated and the workflow exits non-zero.

To run migrations manually:

```bash
AWS_PROFILE=goserve aws ecs run-task \
  --region ap-south-1 \
  --cluster cafe-mgmt-prod \
  --capacity-provider-strategy capacityProvider=cafe-mgmt-prod-cp,weight=1 \
  --task-definition cafe-mgmt-api \
  --overrides '{"containerOverrides":[{"name":"api","command":["/app/migrate","up"],"memory":192,"memoryReservation":128}]}'
```

Watch the result in CloudWatch:

```bash
AWS_PROFILE=goserve aws logs tail /cafe-mgmt/api --since 5m --follow --region ap-south-1
```

---

## Common failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `DATABASE_URL required` on boot | SSM parameter empty | `aws ssm put-parameter --name /cafe-mgmt/prod/DATABASE_URL --type SecureString --overwrite --value '...'` and `aws ecs update-service --force-new-deployment` |
| 401 from `/v1/me` after login | Session cookie blocked | Verify `ROOT_DOMAIN=localhost` on CloudFront default domain, or `SESSION_COOKIE_SAMESITE=none` on cross-site |
| CORS error in browser console | Origin missing from allow-list | Update `CORS_ORIGINS` in SSM; redeploy |
| WS connects then closes after 60s | CloudFront idle timeout | Add a server-side keepalive ping in the hub; see `infra/aws/README.md` |
| GitHub Actions `AccessDenied` on `ecs:UpdateService` | OIDC trust policy doesn't match the branch | Check `github-oidc-deploy-cafe-mgmt` trust → `sub` should be `repo:<owner>/<repo>:ref:refs/heads/main` |
| ECS task stuck in `PROVISIONING` | EC2 instance not registered | `aws ecs list-container-instances --cluster cafe-mgmt-prod` should return one; if empty, ASG hasn't launched yet or its user-data failed (check CloudWatch `/var/log/cloud-init-output.log` via SSM Session Manager) |
| First deploy fails: `image not found` | No image pushed to ECR yet | Push a `:bootstrap` tag manually once; see `infra/aws/README.md` |
| Deploy succeeds but `/healthz` 502 | CloudFront not yet `Deployed` | Wait 5-10 min after distribution creation; check status with `aws cloudfront get-distribution --id <id>` |

---

## Known limitations

These are documented in detail in `infra/aws/README.md`. Brief tour:

- **~30-60s downtime per deploy.** Bridge networking + fixed host port + 1 task = sequential rollover.
- **No multi-AZ.** Single t3.micro in one AZ; AZ outage = down.
- **CloudFront 60s WS idle timeout.** Realtime needs a hub keepalive (not yet implemented).
- **Vercel preview URLs won't pass CORS** until `chi/cors` is extended with regex matching.
- **t3.micro free tier expires 12 months from account creation.** Plan for ~$8/mo afterward.
