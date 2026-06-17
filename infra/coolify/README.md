# Coolify deployment (API + Postgres + S3 on one box)

This runbook deploys the **API + Postgres + MinIO (S3)** to a single self-hosted
Linux box running [Coolify](https://coolify.io). The **SPA stays on Vercel** and
the **landing site stays on GitHub Pages** — neither is touched.

## How it deploys

- Branch **`prod`** → Coolify (this setup). Branch **`main`** → existing AWS ECS
  deploy (`.github/workflows/deploy-api.yml`), unchanged.
- Push to `prod` → `ci.yml` runs the test gate → on success,
  `.github/workflows/deploy-coolify.yml` (a `workflow_run` job, guarded to the
  `prod` branch) curls Coolify's deploy webhook.
- Coolify then: `git pull` → `docker build` (`infra/Dockerfile.api`) →
  pre-deploy command `/app/migrate up` → container swap → health check.

```
push to prod ─▶ ci.yml (vet/build/test, typecheck/build/test) ─▶ deploy-coolify.yml ─▶ Coolify webhook
                                                                                          │
                                          git pull → docker build → /app/migrate up → swap → /healthz
```

> Why the API needs its own public domain: the Vercel SPA calls the API
> **directly** (`apps/web/src/lib/api.ts` → `VITE_API_BASE_URL`) and opens
> WebSockets directly (`apps/web/src/lib/ws.ts` → `VITE_WS_BASE_URL`). Vercel
> never proxied `/api/*`. Coolify's Traefik proxies `wss://` upgrades natively
> (Vercel could not), so REST + WS + OAuth callbacks all live on one API domain.

## GitHub config (one-time)

| Kind   | Name                  | Value |
|--------|-----------------------|-------|
| secret | `COOLIFY_API_WEBHOOK` | `https://<coolify-host>/api/v1/deploy?uuid=<api-resource-uuid>` |
| secret | `COOLIFY_TOKEN`       | Coolify API token (Settings → Keys & Tokens) |
| var    | `COOLIFY_HEALTHZ_URL` | *(optional)* `https://goserve.sarojpaudyal.com.np/healthz` — set only **after** DNS cutover so the post-deploy smoke test hits the box, not the old ECS endpoint |

## Coolify resources (create in this order)

### 1. PostgreSQL (managed, one-click)
- Note the admin connection string → this becomes `DATABASE_URL`.
- `app_user` (the RLS runtime role) is created by migration `0001_initial.sql`
  with the default password `app_user`. **After the first deploy runs `migrate
  up`**, rotate it: `ALTER ROLE app_user PASSWORD '<strong>';` and use that in
  `APP_DATABASE_URL`.

### 2. MinIO (service template)
- Create bucket `cafe` (or set your own — see the bucket-name note below).
- Expose MinIO's S3 API (port 9000) on a public domain, e.g.
  `s3.sarojpaudyal.com.np`, via Traefik with HTTPS. The browser fetches public
  images from here.
- Apply the anonymous-read policy so **only** public images are world-readable
  and staff docs stay private:
  ```sh
  mc alias set local https://s3.sarojpaudyal.com.np <key> <secret>
  mc anonymous set-json infra/coolify/minio-public-policy.json local/cafe
  ```
  (Or paste the JSON in the MinIO console → bucket → Access Policy → Custom.)
- The API↔MinIO traffic uses the **internal** endpoint `http://minio:9000` (no
  TLS needed inside the Coolify network); only `STORAGE_S3_PUBLIC_URL_BASE` is
  the public HTTPS URL.

### 3. API (Application from Git)
- Source: this repo, branch `prod`. Build pack: **Dockerfile** =
  `infra/Dockerfile.api`, build context = repo root.
- **Pre-deployment command:** `/app/migrate up` (the image builds both `server`
  and `migrate` — `infra/Dockerfile.api`).
- **Domain:** `goserve.sarojpaudyal.com.np`, HTTPS on, **WebSocket enabled** (for `/ws`).
- **Auto-deploy on push: OFF.** Enable **deploy via webhook** — that webhook URL
  is what goes in the `COOLIFY_API_WEBHOOK` secret.
- Health check path: `/healthz` (also `/readyz`).
- Env vars: see the matrix below.

## API environment matrix

Validated against `apps/api/internal/config/config.go`. Anything marked
**required** fails boot in prod (`APP_ENV=prod`).

```sh
APP_ENV=prod                                   # prod validation + secure cookies
HTTP_ADDR=0.0.0.0:8080
ROOT_DOMAIN=sarojpaudyal.com.np

# --- DB: BOTH roles are mandatory (RLS model) ---
# required
DATABASE_URL=postgres://<admin>:<pw>@<pg-host>:5432/<db>?sslmode=disable        # admin; migrate + fallback
# REQUIRED to set explicitly — if unset it falls back to DATABASE_URL and the
# API runs as the BYPASSRLS admin, silently disabling tenant isolation.
APP_DATABASE_URL=postgres://app_user:<pw>@<pg-host>:5432/<db>?sslmode=disable   # runtime, NOBYPASSRLS

# --- auth ---
SESSION_SECRET=<>=32 bytes — openssl rand -hex 32>     # required, hard-checked >=32 in prod
CORS_ORIGINS=https://<vercel-spa-origin>               # exact origin(s), comma-separated; NO wildcard in prod
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_REDIRECT_URL=https://goserve.sarojpaudyal.com.np/auth/google/callback   # API domain
POST_LOGIN_REDIRECT_URL=https://<vercel-spa-origin>/login/callback                   # SPA domain

# --- storage: MinIO ---
STORAGE_DRIVER=s3
STORAGE_S3_ENDPOINT=http://minio:9000                  # internal network
STORAGE_S3_REGION=us-east-1                             # any non-empty value; MinIO ignores it
STORAGE_S3_BUCKET=cafe
STORAGE_S3_ACCESS_KEY_ID=<minio key>
STORAGE_S3_SECRET_ACCESS_KEY=<minio secret>
STORAGE_S3_PUBLIC_URL_BASE=https://s3.sarojpaudyal.com.np/cafe   # browser-facing (path-style + bucket)
STORAGE_S3_FORCE_PATH_STYLE=true                       # required for MinIO

# --- mail (optional; no-op if blank) ---
SENDGRID_API_KEY=...
MAIL_FROM=...
MAIL_FROM_NAME=...

# LOG_FORMAT defaults to json in prod. OTP_*, RATE_LIMIT_*, DB_* timeouts default sensibly.
```

> **Bucket-name note:** `infra/coolify/minio-public-policy.json` hardcodes the
> bucket `cafe` in its resource ARNs. If you change `STORAGE_S3_BUCKET`, update
> the ARNs in that file to match, or the public-image policy won't apply.

## Public vs private storage (no code change)

The S3 layer marks public objects with a per-object `public-read` ACL
(`apps/api/internal/storage/s3.go`), but **MinIO governs anonymous access by
bucket policy, not per-object ACLs**, so the policy file replaces the ACL.
Verified key shapes:

- Public (anon-readable): `<slug>/logo-*`, `<slug>/menu/*`
- Private: `<slug>/staff/<id>/*` — served only through the `staff:read`-gated
  proxy (`DownloadStaffDocument`), which reads MinIO server-side over the
  credentialed internal endpoint, so the anon policy never applies to it.

MinIO tolerates the `x-amz-acl: public-read` header the app still sends (no
PutObject error); the bucket policy is what actually grants read.

## DNS cutover (the only user-facing switch)

1. Stand up all three resources; deploy the API; confirm `migrate up` ran and
   `/healthz` is green on Coolify's temporary URL.
2. Restore data: `pg_dump` from the current prod DB → restore into the new Postgres.
3. Copy objects: `mc mirror` from the old S3 bucket into MinIO `cafe`.
4. Repoint `goserve.sarojpaudyal.com.np` A record → box IP; wait for Traefik to
   issue the Let's Encrypt cert.
5. Set the `COOLIFY_HEALTHZ_URL` repo var; verify the SPA on Vercel works
   end-to-end (login, orders, image upload, live WS updates) — no FE redeploy.

## Backups (single box = single point of failure — do not skip)

- Coolify **scheduled Postgres backup** shipped **off-box** to an external
  bucket (Backblaze B2 / real S3), **not** to the local MinIO.
- Back up the MinIO data volume off-box too (scheduled `mc mirror` to B2/S3).

## Notes

- Coolify's Traefik must own ports 80/443 — **disable Apache** on the box if
  present; do not front Coolify with Apache.
- `fly.toml`, `.github/workflows/deploy-api.yml`, and `infra/aws/` remain for the
  `main`→ECS path. Retire them only if/when ECS is decommissioned.
