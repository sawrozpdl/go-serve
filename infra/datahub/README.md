# DataHub (Kathmandu) — production runbook

> **This is the live production environment since 2026-11-04.** It replaced
> AWS (ECS + RDS), which was deleted the same night — see *AWS is gone* below.
> `infra/vps/` and `infra/coolify/` were never deployed.

```
Browser / app ──HTTPS──► Cloudflare (KTM edge) ══ tunnel goserve-ktm ══► cloudflared ──► 127.0.0.1:8080 cafe-api
                                                    (outbound only,               │
                                                     no open web ports)           ├─► 127.0.0.1:5432 Postgres 18 (/data)
                                                                                  └─► /data/uploads/{public,private}
```

| | |
|---|---|
| Box | DataHub cloud, `ubuntu-kathmandu-01`, GENERAL_C2_2R (2 vCPU, 2 GB), Ubuntu 24.04 x86_64 |
| SSH | `ssh -i ~/.ssh/goserve.pem ubuntu@202.51.83.57` — DataHub firewall allows 22 from one IP; port forwarding 22→VM is a separate panel rule |
| Disks | 10 GB root (`/`), 10 GB `db` volume at `/data` (Postgres data dir + uploads) |
| API | systemd `cafe-api`, binary `/opt/cafe/current/server` (symlink into `/opt/cafe/releases/`), env `/opt/cafe/.env` (600, owner `cafe`) |
| DB | `goserve` database. Owner role `goserve` = NOSUPERUSER **BYPASSRLS** (mirrors RDS's master, which SECURITY DEFINER functions rely on); runtime `app_user` (member of `app`, RLS applies) |
| Edge | Cloudflare Tunnel `goserve-ktm` (`e0802f26-…`), remotely managed; DNS `goserve` CNAME → `<id>.cfargotunnel.com` (proxied) |
| Files | `STORAGE_DRIVER=local`. `public/` = logos, menu photos, receipt logos (served at `/uploads/*`, cached by Cloudflare); `private/` = staff docs, expense docs, bug screenshots (only via the permission-checked proxy endpoints) |

## Deploy

**Pushing `main` deploys the API** (`.github/workflows/deploy-api.yml`, on
changes under `apps/api/**`), and `workflow_dispatch` re-deploys on demand.
Both CI and the manual script end in the same root script on the box:

```
goserve-deploy-ssh "deploy <rel>"  < tar(server, migrate)
  └─ sudo goserve-deploy <rel> <dir>:  install → migrate up → switch symlink → restart
                                        → /healthz 200 within 30 s, else roll back
                                        → prune to 5 releases → Discord message
```

- **CI transport:** runner → `cloudflared access ssh` → tunnel hostname
  `ssh-goserve.sarojpaudyal.com.np` → box sshd. sshd admits only `deploy` on
  loopback (tunnel) connections; the key in GitHub secret `DEPLOY_SSH_KEY` is
  pinned by `command="/usr/local/bin/goserve-deploy-ssh",restrict`, so it can
  run `deploy <rel>` / `status` and nothing else (no shell, no forwarding —
  both verified). Host key pinned in `infra/datahub/known_hosts`.
- **Manual:** `infra/datahub/deploy.sh` (admin key over the DataHub port-22 rule).
- Migrations are forward-only; a failed health check rolls back the binary, not the schema.
- `ssh -i ~/.ssh/goserve.pem ubuntu@202.51.83.57 'SSH_ORIGINAL_COMMAND=status /usr/local/bin/goserve-deploy-ssh'` shows the live release.

To rotate the CI key: new ed25519 pair → replace the line in
`/home/deploy/.ssh/authorized_keys` (keep the `command=…,restrict` prefix) →
`gh secret set DEPLOY_SSH_KEY`.

## Backups (`gs://goserve-backups-hearth`, GCP project `hearth-500309`, asia-south1)

| What | How | When |
|---|---|---|
| Postgres WAL | pgBackRest `archive-push` (async) — point-in-time recovery | continuous (≤5 min) |
| Postgres full | `pgbackrest-full.timer` | Sun 21:30 UTC (03:15 NPT) |
| Postgres diff | `pgbackrest-diff.timer` | Mon–Sat 21:30 UTC |
| `/data/uploads` | `restic-uploads.timer` (keep 14 daily / 8 weekly / 12 monthly) | daily 21:50 UTC |

Service account `goserve-backup@hearth-500309` has objectAdmin on that bucket
only; its key is `/etc/pgbackrest/gcs-key.json`. Both repos are encrypted with
passphrases in `/etc/goserve-secrets/` — **copy them to Secret Manager**
(`goserve-pgbackrest-cipher`, `goserve-restic-password`); without them the
backups are unreadable.

```bash
sudo -u postgres pgbackrest --stanza=goserve info      # backups + WAL range
sudo -u postgres pgbackrest --stanza=goserve verify
sudo bash -c 'set -a; . /etc/goserve-secrets/restic.env; set +a; restic snapshots'
```

**Restore drill** (done 2026-11-04, all rows back): restore into a scratch dir,
start it on another port with a minimal `postgresql.conf`, count, delete.
Full-box loss: new Ubuntu box → `provision` steps → copy key + passphrases →
`pgbackrest --stanza=goserve restore` → `restic restore latest --target /` →
reinstall cloudflared with the tunnel token.

## Monitoring

`goserve-watchdog.timer` (every 5 min) checks `/healthz`, cloudflared, WAL
archiving, disk ≥85 %, RAM; every backup unit has `OnFailure=` → both post to
the Discord `ALERT_WEBHOOK_URL`. Nothing alerts if the **whole box** is down —
add an external uptime check on `https://goserve.sarojpaudyal.com.np/healthz`.

## AWS is gone

The AWS stack (ECS, EC2, RDS, ECR, EIPs, SSM, logs, IAM deploy roles) was
deleted on 2026-11-04 after the cutover. What was kept, encrypted in the restic
repo (`restic snapshots --tag aws-final`, host `aws-archive`):

- `aws-rds-final-20261104.dump` — `pg_dump -Fc` of RDS at shutdown, **including
  `audit_log`** (not migrated by decision). `restic dump <id> /aws-rds-final-20261104.dump | pg_restore -l`
- `aws-ssm-cafe-mgmt-prod.json` — the 24 SSM parameters (old prod secrets).

Only the free SES identities remain in the account. `infra/aws/` was removed
from the repo (git history has it); `deploy-api` now targets this box.

## Config / env vars

Runtime config lives only in `/opt/cafe/.env` on the box (600, owner `cafe`;
values single-quoted — `BILL_READ_SA_JSON` is compact one-line JSON). There is
no SSM any more. To add or change a variable:

```bash
ssh -i ~/.ssh/goserve.pem ubuntu@202.51.83.57
sudoedit /opt/cafe/.env && sudo systemctl restart cafe-api
```

Do this **before** pushing code that requires the new variable — the deploy's
health check rolls back a binary that refuses to boot, but it can't add the
variable for you. `PLATFORM_JOBS_ENABLED` is deliberately unset (as it was on AWS).
