# cafe-mgmt

Multi-tenant SaaS POS + admin tool for cafes. Sahan Cafe is the first tenant; the system is built so additional cafes onboard as new workspaces sharing one deployment.

**Stack** Vite + React + TypeScript (web) · Go 1.25 + chi + pgx (api) · PostgreSQL 16 · WebSockets · pnpm + Turborepo · Docker Compose dev stack

**Locale** Nepal-only in v1: NPR (paisa) · 13% VAT · cash + eSewa/Khalti QR (manual reconciliation)

---

## Quick start

Migrations and the API itself are pure Go and only need `DATABASE_URL` in
`.env`. Docker is optional — use it for a one-command Postgres if you
don't already have one.

### Option A — Docker (Postgres + API in containers)

```bash
git clone <repo>
cd cafe-mgmt
cp .env.example .env

# 1. install deps
make install

# 2. bring up Postgres + the API in Docker
make compose-up

# 3. apply the schema + seed two demo tenants (sahan + brews)
make migrate
make seed

# 4. run the web dev server on the host (separate terminal)
make web-dev
```

Open **http://localhost:5891** → log in with `owner@sahan.test` (any name).

### Option B — no Docker (host Postgres + host Go)

Use this if you already have Postgres running locally.

```bash
git clone <repo>
cd cafe-mgmt
cp .env.example .env
make install

# 1. create a dedicated DB owned by a local superuser
createdb cafe   # or: psql postgres -c 'CREATE DATABASE cafe;'

# 2. point .env at it. The admin URL must connect as a SUPERUSER (it
#    runs DDL + CREATE ROLE in migration 0001). The runtime URL uses the
#    auto-created `app_user` (NOBYPASSRLS).
#
#    .env:
#      DATABASE_URL=postgresql://<your-superuser>@localhost:5432/cafe?sslmode=disable
#      APP_DATABASE_URL=postgresql://app_user:app_user@localhost:5432/cafe?sslmode=disable
#      HTTP_ADDR=:8081      # so the host-run server binds to 8081

# 3. apply schema + seed (uses DATABASE_URL from .env, no Docker)
make migrate
make seed

# 4. start the API on the host (terminal 1)
make api-dev

# 5. start the web dev server on the host (terminal 2)
make web-dev
```

> **Hybrid:** want a dockerized Postgres but the API running on the host
> for fast iteration? `make compose-db` brings up only the DB; then
> `make migrate && make api-dev`.

Open **http://localhost:5891**.

> **Port collisions on this machine?** Pass `WEB_PORT=5892` (or any free port). The defaults in `.env.example` already use `5433` for Postgres-via-Docker and `8081` for the API to avoid clashing with system services.

> **Go version?** The repo pins Go 1.25 in `go.mod`. Go ≥ 1.24 is required (`pgx/v5` imports `crypto/pbkdf2` from stdlib). On Mac, `brew install go` is the easiest path; the official installer at https://go.dev/dl/ also works.

### What you should see

1. **Login** — dev-login form pre-filled with the seeded owner email.
2. **Workspace pick** — auto-picks Sahan if you have only one membership.
3. **Admin dashboard** — KPIs, daily-sales chart (empty until you ring some orders), low-stock alerts.
4. **Floor** — tile grid of service tables. Click a free table to open a tab; tap menu items to add; **Send to kitchen** when ready.
5. **Kitchen** — second-screen view: tickets land in real time, advance with `Mark ready` → `Mark served`.
6. **Settle** — once items are served, the tab footer button flips to **Settle tab**; record cash/eSewa/Khalti and close.
7. **Settings** *(owner only)* — flip the brand colour, upload a logo, change VAT.

---

## Stack layout

```
apps/
  web/          Vite + React + TS — admin shell, floor, KDS, settle, reports
  api/          Go 1.25 — chi router, pgx, goose migrations, WS hub
packages/
  ui/           (placeholder) shared React components
  api-client/   typed fetch wrapper
  design-tokens/ ink/amber/lime scales, font stacks, brandingToCss()
infra/
  docker-compose.yml   postgres + api (web runs on host for HMR)
  Caddyfile            dev wildcard subdomain proxy
migrations/     SQL migrations (goose), embedded into the migrate cmd
docs/
  schema.md     ER overview + RLS notes
  runbook.md    ops procedures
```

---

## How the multi-tenant pieces fit

- **Tenant resolution** — every request resolves a tenant via subdomain (`sahan.app.com`) or `X-Tenant-ID` header (the dev default; cookie-on-localhost subdomain sharing is broken by curl/PSL).
- **RLS-enforced isolation** — Postgres row-level security on every tenant-scoped table with a `current_tenant_id() = tenant_id` policy. The runtime API connects as **`app_user`** (NOBYPASSRLS), so even an app bug can't read another tenant's rows. Migrations and seed run as the `cafe` superuser (separate `DATABASE_URL` env).
- **Two GUCs** — `app.tenant_id` and `app.user_id` set per-request via `SET LOCAL` inside the request transaction. `tenant_members` policy uses both so the workspace-pick flow can read user-scoped rows without a tenant set.
- **Manager-PIN approval** — voids and discounts require a manager-role approver. Owner|Manager actors approve themselves; Waiter|Kitchen must include `approver_email` + `approver_pin` in the request. Failures are written to `audit_events`.
- **Cost-center accounting** — `expense_allocations.menu_category_id` ties expenses to revenue buckets so M9 can roll up gross profit per category (e.g., "how much profit on momo this month").
- **Cash drawer** — one open shift per tenant (partial unique index). Cash payments require a shift; non-cash payments still get tagged with the open shift's id for variance reporting.

---

## Common make targets

| Target | Description |
|---|---|
| `make help` | List all targets |
| `make install` | pnpm install + go mod download |
| **Migrations & seeds (host-only, no Docker)** | |
| `make migrate` | Apply pending migrations against `DATABASE_URL` |
| `make migrate-status` / `migrate-down` / `migrate-reset` | Migration controls |
| `make seed` | Seed Sahan + Brews demo tenants |
| **Run on host** | |
| `make api-dev` | Run the Go API on the host (loads `.env`) |
| `make web-dev` | Run the Vite dev server on the host |
| **Build / quality** | |
| `make build` | Build Go binary + Vite production bundle |
| `make test` | Go test (incl. multi-tenant isolation) + Vitest |
| `make lint` / `make typecheck` / `make format` | Quality |
| **Docker compose (optional dev stack)** | |
| `make compose-up` | Start Postgres + API in Docker |
| `make compose-db` | Start only Postgres in Docker (run API on host) |
| `make compose-down` | Stop containers (volumes persist) |
| `make compose-logs` | Tail container logs |
| `make compose-psql` | psql into the dockerized DB |
| `make compose-clean` | **Destructive** — wipe volumes + dist |

---

## Seeded test users

All in tenant `sahan` unless noted. Use `POST /auth/dev-login {email,name}` to get a session.

| Email | Role |
|---|---|
| `owner@sahan.test` | owner |
| `manager@sahan.test` | manager |
| `waiter@sahan.test` | waiter |
| `kitchen@sahan.test` | kitchen |
| `owner@brews.test` | owner (brews) |

Sign in as the owner first to set an Approval PIN (sidebar footer → **Approval PIN**) before testing voids/discounts as the waiter.

---

## Further reading

- [`docs/usage.md`](docs/usage.md) — day-to-day walkthrough: login → take orders → KDS → settle → close shift, plus reports, inventory, and onboarding a second cafe
- [`docs/schema.md`](docs/schema.md) — table-by-table overview with RLS notes
- [`docs/runbook.md`](docs/runbook.md) — backup, restore, migration, support procedures
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — production deploy: API to AWS App Runner + RDS, FE to S3/CloudFront, with cookie/CORS topology guidance
