# Deploying cafe-mgmt to production

This guide walks you from a clean AWS account to a running production
deployment with the **API** and **frontend** living on independent
services. Each app builds and ships on its own — you can redeploy one
without touching the other.

The recommended path is:

| Component | Service | Why |
|-----------|---------|-----|
| API (Go)  | **AWS App Runner** from ECR | Container in, HTTPS out. Autoscale + zero VPC plumbing. |
| Postgres  | **AWS RDS** (single AZ, Postgres 16) | Managed backups, point-in-time recovery, easy upgrades. |
| Frontend  | **S3 + CloudFront** | Static SPA, cheap, instantly global. |
| DNS       | **Route 53**          | Same account, easy ACM cert validation. |

If you'd rather not run AWS for the FE, **Vercel**, **Netlify**, or
**Cloudflare Pages** all work — point them at this repo's `apps/web` and
set `VITE_API_BASE_URL` in their build env.

> ECS Fargate + ALB is the more "industrial" alternative for the API and
> gives you VPC integration, blue/green deploys, and finer scaling
> controls. Use it once you've outgrown App Runner — not before.

---

## 1. Pick your domain topology

This decision drives cookie config, CORS, and the OAuth redirect URL. **Pick
one before you start clicking in AWS.**

### A. Sister subdomains under one registrable domain (recommended)

```
https://app.cafe.com   →  CloudFront / FE bucket
https://api.cafe.com   →  App Runner   / API
                         (cookie domain: .cafe.com)
```

Same-site cookies (`SameSite=Lax`) work because both hosts share the
registrable domain `cafe.com`. This is the cleanest setup — fewer browser
quirks, no `SameSite=None; Secure` complications. Use this unless you
have a reason not to.

API env:
```
ROOT_DOMAIN=cafe.com
CORS_ORIGINS=https://app.cafe.com
SESSION_COOKIE_SAMESITE=lax
```

### B. Fully cross-site (FE on Vercel / different registrable domain)

```
https://cafe-app.vercel.app     →  Vercel (FE)
https://api.cafe.com            →  App Runner (API)
```

Cookies must be `SameSite=None; Secure` (the API auto-forces `Secure` when
SameSite is None). The cookie's Domain is host-only on the API host.

API env:
```
ROOT_DOMAIN=api.cafe.com
CORS_ORIGINS=https://cafe-app.vercel.app
SESSION_COOKIE_SAMESITE=none
```

> All examples below assume topology **A**. Where it matters, the topology
> **B** override is called out.

---

## 2. Provision Postgres (RDS)

1. RDS Console → **Create database** → Postgres 16 → "Production" template
   for prod, or "Dev/Test" for an MVP.
2. Master username `admin`, password from a fresh `openssl rand -hex 24`.
3. Storage: 20 GiB gp3 is plenty to start; enable storage autoscaling.
4. **VPC**: default VPC is fine. Public access **Yes** initially so you can
   run migrations from your laptop. Disable later (see §6).
5. Initial DB name `cafe`. Backups: 7 days minimum. Enable automated minor
   version upgrades.
6. Once status is "Available", grab the endpoint, e.g.
   `cafe-prod.abc123.us-east-1.rds.amazonaws.com`.

Stash these for later:

```
DATABASE_URL=postgresql://admin:<password>@cafe-prod.abc123.us-east-1.rds.amazonaws.com:5432/cafe?sslmode=require
APP_DATABASE_URL=postgresql://app_user:<app_password>@cafe-prod.abc123.us-east-1.rds.amazonaws.com:5432/cafe?sslmode=require
```

`app_user` doesn't exist yet — migration `0001_initial.sql` creates it
(via `CREATE ROLE`) the first time you migrate. Set `app_password` to
match what you put in `APP_DATABASE_URL`; you'll set it as part of step 3.

---

## 3. Apply migrations from your laptop (one time)

```bash
# From the repo root, with .env set or env vars exported:
export DATABASE_URL=postgresql://admin:<pw>@<rds-endpoint>:5432/cafe?sslmode=require

# The migrate command reads APP_DB_PASSWORD if present and uses it when
# creating app_user. Otherwise the role gets a placeholder password.
export APP_DB_PASSWORD=<app_password>

cd apps/api
go run ./cmd/migrate up
go run ./cmd/migrate status      # confirms every migration applied
```

If you'd rather not expose RDS publicly, run migrations from an EC2 jump
host inside the same VPC, or temporarily attach an IGW + open the SG to
your IP.

---

## 4. Deploy the API to App Runner (via ECR)

### 4a. Build & push the image

App Runner needs a container image in ECR or a public registry. Build
from the repo root so the Dockerfile's `COPY apps/api ./apps/api` works.

```bash
# One-time: create the repo
aws ecr create-repository --repository-name cafe-mgmt-api

# Auth Docker to ECR
aws ecr get-login-password --region us-east-1 \
  | docker login --username AWS --password-stdin <acct>.dkr.ecr.us-east-1.amazonaws.com

# Build for linux/amd64 (App Runner is x86_64)
docker buildx build \
  --platform linux/amd64 \
  -f infra/Dockerfile.api \
  -t <acct>.dkr.ecr.us-east-1.amazonaws.com/cafe-mgmt-api:latest \
  --push \
  .
```

### 4b. Create the App Runner service

Console → **App Runner** → **Create service** →

- **Source**: ECR, image you just pushed, "Automatic" deployments.
- **Service settings**: 1 vCPU / 2 GB is plenty to start. Min/max instances
  1 / 2 — App Runner scales by concurrent requests; bump max once you
  have traffic.
- **Port**: `8080` (matches the API's `EXPOSE 8080` and default `HTTP_ADDR=:8080`).
- **Health check**: HTTP, path `/healthz`, interval 10s, timeout 5s,
  healthy threshold 1, unhealthy threshold 3.
- **Environment variables** (paste from your `apps/api/.env.example`):
  ```
  APP_ENV=prod
  HTTP_ADDR=:8080
  DATABASE_URL=postgresql://admin:...@<rds-endpoint>:5432/cafe?sslmode=require
  APP_DATABASE_URL=postgresql://app_user:...@<rds-endpoint>:5432/cafe?sslmode=require
  ROOT_DOMAIN=cafe.com
  CORS_ORIGINS=https://app.cafe.com
  SESSION_COOKIE_SAMESITE=lax
  GOOGLE_OAUTH_CLIENT_ID=...
  GOOGLE_OAUTH_CLIENT_SECRET=...
  GOOGLE_OAUTH_REDIRECT_URL=https://api.cafe.com/auth/google/callback
  SESSION_SECRET=<openssl rand -hex 32>
  ```
  Mark `DATABASE_URL`, `APP_DATABASE_URL`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  and `SESSION_SECRET` as **Secrets** (App Runner stores them in
  Secrets Manager).
- **Networking**:
  - *Outgoing*: VPC connector if RDS is private (recommended once you
    flip RDS to private). Otherwise default.
  - *Incoming*: Public.
- **Custom domain**: add `api.cafe.com` after the service is healthy.
  App Runner provisions a free ACM cert and gives you a CNAME to put in
  Route 53.

### 4c. Smoke test

```
curl https://api.cafe.com/healthz
# → {"status":"ok"}
```

---

## 5. Deploy the frontend (S3 + CloudFront)

### 5a. Build the static bundle

Build env vars are **baked into the bundle** — there is no FE runtime
config. To deploy a new API URL you must rebuild.

```bash
# From repo root
export VITE_API_BASE_URL=https://api.cafe.com

pnpm install
pnpm --filter @cafe-mgmt/web build
# → apps/web/dist/{index.html,assets/*}
```

### 5b. Upload to S3

```bash
aws s3 mb s3://cafe-mgmt-web-prod
aws s3 sync apps/web/dist/ s3://cafe-mgmt-web-prod/ \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude index.html

aws s3 cp apps/web/dist/index.html s3://cafe-mgmt-web-prod/index.html \
  --cache-control "no-cache"
```

`assets/*` are content-hashed and safe to cache for a year. `index.html`
is the deployment manifest — never cache it, or users get half the new
build and half the old one.

### 5c. CloudFront

Console → **CloudFront** → **Create distribution** →

- **Origin**: the S3 bucket (use **OAC**, not OAI; let CloudFront update
  the bucket policy).
- **Default root object**: `index.html`.
- **Custom error responses**: `403 → /index.html (200)`, `404 → /index.html (200)`
  — required for SPA client-side routing.
- **Custom domain**: `app.cafe.com`. Provision an ACM cert in **us-east-1**
  (CloudFront only reads from us-east-1).
- **Default cache behavior**: redirect HTTP→HTTPS, no cache key on
  cookies/headers/queries.

After every deploy:

```bash
aws cloudfront create-invalidation \
  --distribution-id <dist-id> \
  --paths "/index.html"
```

### 5d. DNS

In Route 53, create:
- `app.cafe.com` → ALIAS → CloudFront distribution domain.
- `api.cafe.com` → CNAME (or ALIAS) → App Runner default domain.

---

## 6. Hardening — once it works

These can wait until you've shipped, but don't forget them.

- **RDS private**: flip "Publicly accessible" to **No**, attach App Runner
  via a VPC Connector, restrict the SG ingress to that connector. Run
  future migrations from an EC2 bastion or the App Runner shell.
- **Secrets Manager rotation** for `SESSION_SECRET` and DB passwords.
  Rotating `SESSION_SECRET` invalidates every session — schedule it.
- **CloudWatch Logs retention**: App Runner defaults to "Never". Set to
  30 or 90 days; logs aren't free.
- **Backups**: confirm RDS automated backups + a periodic logical dump
  (`pg_dump`) to S3 in case of catastrophic account loss.
- **Image signing & ECR scan-on-push**: enable scan-on-push, fail builds
  on Critical CVEs.
- **IAM**: stop using your root account. Create a `deploy` IAM user with
  scoped policies (ECR push, App Runner deploy, S3 sync, CloudFront
  invalidate). Use that for CI.

---

## 7. CI/CD (next step, not in this guide)

Once the manual deploy works end-to-end, automate it:

- **API**: GitHub Actions on push to `main` → `docker buildx build --push`
  to ECR → `aws apprunner start-deployment`.
- **FE**: GitHub Actions on push to `main` → `pnpm build` with prod env →
  `aws s3 sync` + CloudFront invalidation.

Use **OIDC federation** between GitHub and AWS so you don't have to store
a long-lived `AWS_ACCESS_KEY_ID` in repo secrets — that's the modern
default.

---

## 8. Configuring Google OAuth for prod

In Google Cloud Console → APIs & Services → Credentials → your OAuth
client → **Authorized redirect URIs**, add:

```
https://api.cafe.com/auth/google/callback
```

(Topology B: it's still your API origin, just a different host.)

The "Authorized JavaScript origins" should include `https://app.cafe.com`.

---

## 9. Common failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `DATABASE_URL required` on boot | env not injected into the platform | Re-check App Runner env vars; remember Secrets need to be mapped, not just defined. |
| 401 from `/v1/me` after login | cookie blocked by browser | Topology A: ROOT_DOMAIN must be the registrable domain (no leading dot). Topology B: SESSION_COOKIE_SAMESITE=none. |
| CORS error in browser console | origin missing from allow-list | Add the FE origin (with scheme) to `CORS_ORIGINS`. |
| WS connects then closes immediately | Origin header rejected | The realtime handler reuses `CORS_ORIGINS`; same fix. |
| `migrate up` hangs | RDS SG blocking your IP | Add an inbound 5432 rule for your laptop IP, or run from a bastion. |
