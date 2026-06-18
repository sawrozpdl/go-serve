# VPS deploy (lean, no Coolify) — API + Postgres + Caddy on one box

Runs the whole backend on a single small Linux box (start: **DigitalOcean BLR1,
1 GB / 1 vCPU, ~$6/mo**) with **no container orchestrator**. The box only *runs* a
pre-built Go binary, co-located Postgres, and Caddy (TLS + WebSocket). The **SPA stays
on Vercel** and the **landing site on GitHub Pages** — neither is touched.

> Supersedes the Coolify path (`infra/coolify/`) and the AWS ECS path (`infra/aws/`),
> which remain in the tree but are unused. `.github/workflows/deploy-coolify.yml` is dead.

```
your laptop                                  droplet (1 GB, Bangalore)
┌──────────────────────────┐  scp binary    ┌─────────────────────────────────────┐
│ go build (linux/amd64)   │ ─────────────▶ │ Caddy :443  ──▶  cafe-api :8080      │
│ infra/vps/deploy.sh      │  ssh restart   │ (systemd)         (systemd)          │
└──────────────────────────┘                │ Postgres :5432 (localhost only)      │
                                             │ swap 1–2 GB · nightly pg_dump → B2   │
SPA → Vercel (free)   Landing → GH Pages     │ images → Cloudflare R2 (off-box)     │
                                             └─────────────────────────────────────┘
```

## ⚠️ Never build on the box
`go build` (hundreds of MB) and a Vite SPA build (~1–2 GB) will OOM a 1 GB box.
- **Go binary** → cross-compiled on your laptop and `scp`'d (see `deploy.sh`). ~15 MB, static.
- **SPA** → built on Vercel.  **Landing** → built on GitHub Pages.
The box has **no Go toolchain and no Node**.

---

## One-time box setup

1. **Create the droplet** (DO BLR1, 1 GB, Ubuntu LTS). Add an SSH key. Then on the box:
   ```sh
   adduser cafe && usermod -aG sudo cafe        # deploy/runtime user
   ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
   ```
2. **Swapfile (non-negotiable on 1 GB):**
   ```sh
   fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
   echo '/swapfile none swap sw 0 0' >> /etc/fstab
   sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' >> /etc/sysctl.conf
   ```
3. **Postgres 16 (co-located):**
   ```sh
   apt install -y postgresql-16
   sudo -u postgres createdb cafe
   sudo -u postgres psql -c "ALTER ROLE postgres PASSWORD '<admin-pw>';"
   # Append the 1 GB tuning include, then restart:
   cp postgres-tuning.conf /etc/postgresql/16/main/conf.d/zz-cafe.conf
   systemctl restart postgresql
   ```
   `app_user` (the NOBYPASSRLS runtime role) is created by migration `0001_initial.sql`
   on the first `migrate up`. **After that first deploy**, rotate its default password:
   `ALTER ROLE app_user PASSWORD '<strong>';` and put it in `APP_DATABASE_URL`.
4. **Caddy:**
   ```sh
   apt install -y caddy
   cp Caddyfile /etc/caddy/Caddyfile     # edit the ACME email + domain first
   systemctl restart caddy
   ```
5. **App dir + env + service:**
   ```sh
   mkdir -p /opt/cafe && chown cafe:cafe /opt/cafe
   cp env.example /opt/cafe/.env         # then fill it in (see below); chmod 600
   cp cafe-api.service /etc/systemd/system/ && systemctl daemon-reload
   ```
6. **Passwordless restart for the deploy user** (so `deploy.sh` can restart over SSH):
   ```sh
   echo 'cafe ALL=(root) NOPASSWD: /bin/systemctl restart cafe-api' > /etc/sudoers.d/cafe-api
   ```
7. **Cloudflare R2:** create a bucket, an R2 API token, and a public bucket URL
   (`r2.dev` or a custom domain). Fill the `STORAGE_*` values in `/opt/cafe/.env`.

## Env file (`/opt/cafe/.env`)
Start from `env.example` here (var names validated against `apps/api/internal/config/config.go`).
Critical, easy to get wrong:
- **`APP_DATABASE_URL`** must be the `app_user` role. If unset it falls back to the admin
  `DATABASE_URL` and **silently disables tenant RLS isolation.**
- `SESSION_SECRET` ≥32 bytes — generate **on the box**: `openssl rand -hex 32`.
- `CORS_ORIGINS` = your exact Vercel origin (no wildcard in prod).
- `DB_MAX_CONNS=10` (keeps Postgres connection memory bounded on 1 GB).

## First deploy & every deploy after
From the repo root on your laptop:
```sh
DEPLOY_HOST=cafe@<droplet-ip> ./infra/vps/deploy.sh
```
It cross-compiles `server` + `migrate`, ships them, runs `./migrate up`, swaps the binary,
`systemctl restart cafe-api`, and smoke-tests `/healthz`. (First time, also
`systemctl enable --now cafe-api` on the box.)

## DNS cutover
Point `goserve.sarojpaudyal.com.np` A record at the droplet IP. Caddy issues the
Let's Encrypt cert on first HTTPS request. The SPA needs **no redeploy** — `.env.production`
already targets that host for both REST and `wss://`.

## Backups (single box = single point of failure — do not skip)
- `backup.sh` → nightly `pg_dump` → **off-box** bucket (Backblaze B2 recommended — a
  *different* provider than R2, so one account compromise can't lose both). Cron it as root.
- R2 holds the images; that's already off-box.
- Optional: weekly DO **droplet snapshot** for fast whole-box restore.

## Verify end-to-end
1. `curl https://goserve.sarojpaudyal.com.np/healthz` and `/readyz` → green.
2. On the SPA (no FE redeploy): **login (Google + OTP)**, **create/settle an order**,
   **upload a menu image** (confirms R2 public read), **open a 2nd device → live WS update**.
3. Confirm a backup landed in the off-box bucket.
4. Tenant isolation: a second tenant's data is invisible — confirms `APP_DATABASE_URL`
   is the RLS role, not admin.

## Scaling
Resize the droplet in place (DO: power off → resize RAM/CPU → boot) when you outgrow it —
nothing to rebuild, you ship a binary. ~$6 (1 GB) → $12 (2 GB) → $24 (4 GB). Going
*multi-instance* (thousands of cafes) needs a Redis refactor for the WS hub + RBAC cache
+ rate limiter — see the hosting plan.
