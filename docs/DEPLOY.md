# Deploying cafe-mgmt to production

> **Everything below was verified against the running system on 2026-08-08**
> (`aws --profile goserve --region ap-south-1`), not copied forward from intent.
> If you change the topology, re-verify rather than editing prose — an earlier
> version of this file described a CloudFront distribution that has never
> existed, which cost a real debugging session. When in doubt the source of
> truth is CloudWatch `/cafe-mgmt/api` and `ecs describe-services`.

| Component | Service | Notes |
|-----------|---------|-------|
| API (Go)  | **AWS ECS-on-EC2**, `cafe-mgmt-prod` / service `api` | Single t3.micro. Container `:8080` published on **host `:80`**. |
| Edge      | **Cloudflare** (proxied DNS) | Terminates TLS. Origin is plain HTTP. No CloudFront, no Caddy. |
| Postgres  | **AWS RDS** `go-serve`, Postgres 18.3, db.t4g.micro | Single-AZ. ⚠️ see *Security* below. |
| Frontend  | **Vercel** (Git-integrated, auto-deploy on `main`) | Static Vite SPA. |
| Landing   | **GitHub Pages** | `apps/landing`, separate workflow. |
| Image storage | **Supabase Storage** (S3-compatible) | `STORAGE_DRIVER=s3`, endpoint in SSM. |

---

## Architecture

```
GitHub (push to main, paths apps/api/**)
   │  OIDC federation (no long-lived keys)
   ▼
GitHub Actions ─► ECR go-serve:<sha> ─► one-shot migrate task ─► ECS service update
                                                                        │
                                                                        ▼
Browser ──HTTPS──► Cloudflare ──HTTP──► EIP 35.154.3.43 : 80 ──► container :8080
   │                (proxied DNS,                                  (t3.micro,
   │                 TLS at the edge)                               bridge net)
   │                                                                    │
   └── SPA assets ── Vercel (goserve.vercel.app)                        ▼
                                                        RDS go-serve : 5432
```

- **Account**: `782968043912` (`AWS_PROFILE=goserve`).
- **Region**: `ap-south-1`.
- **Public API origin**: `https://goserve.sarojpaudyal.com.np` — this is what the
  SPA calls directly (`apps/web/.env.production` → `VITE_API_BASE_URL`).
- **DNS**: Cloudflare nameservers (`irma`/`elmo.ns.cloudflare.com`), record proxied
  (resolves to Cloudflare `104.21.x` / `172.67.x`, never to the EIP).
- **Cluster**: `cafe-mgmt-prod`, service `api`, capacity provider `cafe-mgmt-prod-cp`,
  instance `cafe-mgmt-prod-host` (`i-07c1c9627ee4349ad`).
- **Secrets**: SSM Parameter Store, `/cafe-mgmt/prod/*` (23 parameters), injected by
  the ECS execution role at task start.

### Vercel does NOT proxy `/api/*`

`apps/web/vercel.json` contains exactly one rewrite — the SPA catch-all
`/(.*) → /index.html`. There is no API proxy and there never was. The SPA talks to
`VITE_API_BASE_URL` directly, and WebSockets go to `VITE_WS_BASE_URL`.

This matters because `https://goserve.vercel.app/api/anything` returns
`index.html` with a **200**. The deploy smoke test used to curl exactly that and
therefore could never fail; it passed for months on `healthz: <!doctype html>`.
Any health check must hit the API origin and **assert the body**, not the status.

---

## Deploying

**Pushing to `main` is the deploy.** There is no other step and no manual runbook.

| Push touches | What happens |
|---|---|
| `apps/api/**`, `infra/Dockerfile.api`, `infra/aws/*task-definition.json` | `deploy-api.yml`: build → push ECR → **run migrations** → update ECS → smoke test |
| anything in `apps/web/**` | Vercel rebuilds and deploys the SPA automatically |
| `apps/landing/**` | `deploy-landing.yml` → GitHub Pages |

`ci.yml` runs in parallel and **does not gate** `deploy-api.yml`. A red test suite
will not stop a production deploy. Treat a red CI on `main` as an incident.

Migrations run **before** the service is updated, so during the rollover the old
binary is briefly live against the new schema. Keep migrations backward-compatible
with the previous release, or accept a short window of errors on any endpoint that
touches changed tables.

### Rollback

Re-point the service at the previous task definition revision:

```bash
aws --profile goserve --region ap-south-1 ecs update-service \
  --cluster cafe-mgmt-prod --service api \
  --task-definition cafe-mgmt-api:<previous-revision> --force-new-deployment
```

This does **not** roll back the database. Write a down migration if you need that.
The deployment circuit breaker (`enable: true, rollback: true`) already reverts a
task that fails to reach a steady state on its own.

---

## Configuration that is easy to get wrong

Current live values (`ecs describe-task-definition` + SSM):

| Key | Value | Why it is that |
|---|---|---|
| `HTTP_ADDR` | `:8080` | Container port; published on host `:80`. |
| `APP_ENV` | `prod` | Gates the dev-login route and error verbosity. |
| `ROOT_DOMAIN` | `localhost` | Sentinel forcing a **host-only** cookie. |
| `SESSION_COOKIE_SAMESITE` | `none` | FE and API are different registrable domains. |
| `CORS_ORIGINS` | `https://goserve.vercel.app` | Exact match; no regex, so **preview URLs fail CORS**. |
| `GOOGLE_OAUTH_REDIRECT_URL` | `https://goserve.sarojpaudyal.com.np/auth/google/callback` | Must also be registered in Google Cloud Console. |
| `POST_LOGIN_REDIRECT_URL` | `https://goserve.vercel.app/login/callback` | Where the API bounces back to after Google. |
| `STORAGE_DRIVER` | `s3` | Supabase Storage, S3-compatible. |

**On cookies:** session auth is **JWT** (access + rotating refresh, migration 0020) —
cookies are no longer how a session is carried. The only remaining `http.SetCookie`
is the Google OAuth handoff (`internal/auth/google.go`), which is why `ROOT_DOMAIN`
and `SESSION_COOKIE_SAMESITE` still matter at all. Do not reason about auth from
the cookie settings; read `internal/auth/jwt.go`.

---

## Migrations

The image ships two binaries: `/app/server` (default) and `/app/migrate`. Every API
deploy runs `/app/migrate up` as a one-shot ECS task on the same image SHA before
the service is updated. Non-zero exit fails the workflow and the service is left
alone.

Run them by hand:

```bash
aws --profile goserve --region ap-south-1 ecs run-task \
  --cluster cafe-mgmt-prod \
  --capacity-provider-strategy capacityProvider=cafe-mgmt-prod-cp,weight=1 \
  --task-definition cafe-mgmt-migrate \
  --started-by manual-$(whoami)
```

Confirm the result — goose prints the version it reached:

```bash
aws --profile goserve --region ap-south-1 logs tail /cafe-mgmt/api \
  --since 10m --format short --log-stream-name-prefix migrate
# → OK   0061_lead_pipeline.sql
# → goose: successfully migrated database to version: 61
```

---

## Verifying a deploy

```bash
# 1. The running image should be the commit you pushed.
aws --profile goserve --region ap-south-1 ecs describe-services \
  --cluster cafe-mgmt-prod --services api --query 'services[0].taskDefinition'

# 2. Health, with the body asserted — a 200 alone proves nothing.
curl -fsS https://goserve.sarojpaudyal.com.np/healthz   # → {"status":"ok"}

# 3. Real traffic is the only proof that this stack is the live one.
aws --profile goserve --region ap-south-1 logs tail /cafe-mgmt/api --since 15m --format short
```

Note that `/v1/*` returns **401 for unknown paths too** — `RequireAuth` runs before
routing, so a 401 does *not* prove an endpoint exists. Use `/healthz`, or diff the
served SPA bundle.

---

## Security

- ⚠️ **The production database is reachable from the open internet.** RDS
  `go-serve` is `PubliclyAccessible: true` with an Elastic IP (`15.207.143.87`) on
  its ENI, and it uses the **default VPC security group**
  (`sg-0d5c084d149806f7d`), which carries an `IpProtocol: -1` (all ports, all
  protocols) rule from `0.0.0.0/0` alongside the intended `tcp/5432` from the API
  SG. `nc -z <rds-endpoint> 5432` succeeds from an arbitrary host. Only the
  password stands in front of production data. Earlier revisions of this file
  claimed the RDS was "SG-locked to the API SG" — that has not been true.
  **Fix:** revoke the allow-all rule; the specific `5432 ← sg-062f9ee6a0a9a3d4a`
  rule is what the API actually uses, and nothing else lives in that SG.
- **Cloudflare → origin is plain HTTP.** TLS terminates at the Cloudflare edge and
  the hop to `35.154.3.43:80` is unencrypted. Acceptable only while the origin IP
  stays unpublished; "Full (strict)" mode would need a cert on the origin.
- **The origin is directly reachable.** SG `sg-062f9ee6a0a9a3d4a` allows `80` and
  `443` from `0.0.0.0/0`, so `http://35.154.3.43/healthz` answers and Cloudflare
  can be bypassed. Restricting ingress to Cloudflare's published ranges would close
  that. Port `443` is open but nothing listens on it.

---

## Known limitations (verified, not assumed)

- **~30-60s downtime per deploy.** `minimumHealthyPercent: 0`, `maximumPercent: 100`,
  one task, bridge networking on a fixed host port — the old task must stop before
  the new one starts. This is structural, not a tuning oversight.
- **60s WebSocket lifetime, and the existing mitigation does not work.** Every
  `/ws` request in CloudWatch logs `dur_ms ≈ 60000`, so clients reconnect once a
  minute. The hub *does* ping every 25s (`internal/realtime/hub.go:178`) — that is
  not enough, so something enforces a hard cap rather than an idle one. Previous
  revisions blamed a CloudFront idle timeout; there is no CloudFront. See
  `infra/aws/README.md` → *Known caveats §3* before touching the ticker.
- **No multi-AZ.** One t3.micro in one AZ. An AZ outage is an outage.
- **Vercel preview URLs fail CORS.** `CORS_ORIGINS` is an exact-match list.
- **CI does not gate deploys.** See *Deploying* above.

---

## Other environments in this repo

`infra/aws/` is production. Two other paths exist and **neither has ever run**:

| Path | Status |
|---|---|
| `infra/vps/` | Planned move to a DigitalOcean droplet. `deploy.sh` never executed. |
| `infra/coolify/` | Planned Coolify box. `deploy-coolify.yml` triggers on a `prod` branch that does not exist. |

Both of their READMEs assert that the AWS path is "unused". That is false and has
caused a real incident — see the banners at the top of each.
