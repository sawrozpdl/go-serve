# Operations runbook

Practical procedures for running cafe-mgmt. v1 is small enough that most of these are manual; if/when we hit serious scale, automate.

## Local development

```bash
make compose-up   # postgres + api in Docker
make migrate      # apply pending migrations (pure Go, reads DATABASE_URL)
make seed         # demo tenants
make web-dev      # web on host (HMR)
```

`make compose-logs` to tail container output. `make compose-down` to stop
(volumes persist). For host Postgres or RDS just skip `compose-up` — the
migrate / seed / api-dev targets only need `DATABASE_URL` in `.env`.

## Database backups

The Docker dev volume is `infra/.volumes/pg`; production should target a managed Postgres (RDS / Cloud SQL) and use its native backup. For self-hosted:

```bash
# Backup
docker compose -f infra/docker-compose.yml exec -T postgres \
  pg_dump -U cafe -Fc cafe > backup-$(date +%Y%m%d-%H%M).dump

# Restore (DESTRUCTIVE — wipes target DB)
docker compose -f infra/docker-compose.yml exec -T postgres \
  pg_restore -U cafe -d cafe --clean --if-exists < backup.dump
```

For long-term retention, push dumps to S3-compatible storage nightly via cron.

## Adding a migration

```bash
# Pick the next number, write a goose-formatted SQL file:
touch apps/api/migrations/000N_<short_name>.sql

# Apply locally:
make migrate

# Inspect status:
make migrate-status

# Roll back one step (only when really needed):
make migrate-down
```

Always include the matching grants for the runtime role:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON <new_table> TO app;
```

…and RLS scaffolding if the table is tenant-scoped (see `docs/schema.md`).

## Onboarding a new tenant

There's no self-serve flow yet — adding a workspace is a manual SQL step. Run as the admin (`DATABASE_URL`):

```sql
INSERT INTO tenants (slug, name, timezone)
VALUES ('newcafe', 'New Cafe', 'Asia/Kathmandu');

-- Then upsert the owner:
INSERT INTO users (email, name) VALUES ('owner@newcafe.test', 'Owner')
  ON CONFLICT (email) DO NOTHING;

-- Grant ownership in the right tenant context (RLS requires it):
DO $$
DECLARE tid uuid; uid uuid;
BEGIN
  SELECT id INTO tid FROM tenants WHERE slug = 'newcafe';
  SELECT id INTO uid FROM users WHERE email = 'owner@newcafe.test';
  PERFORM set_config('app.tenant_id', tid::text, true);
  INSERT INTO tenant_members (tenant_id, user_id, role)
  VALUES (tid, uid, 'owner');
END $$;
```

Then point them at `https://newcafe.app.com` (or `X-Tenant-ID: newcafe` in dev).

## Troubleshooting

### "tenant_required" 400

Either no subdomain resolved and no `X-Tenant-ID` header, or the slug doesn't match an active tenant. Confirm the slug exists, status='active', deleted_at IS NULL.

### "shift_required" 409 on cash payment

A cash payment was attempted with no open shift for the tenant. Open one in **Operations → Shift**, then retry.

### "approval_required" 403 on void/discount

The actor isn't owner/manager. Either log in as one, or include `approver_email` + `approver_pin` in the body. Manager PINs are set via the sidebar footer **Approval PIN** modal.

### A query returns 0 rows when you know data exists

Likely RLS — the request didn't set `app.tenant_id` for the tx (the `TxMiddleware` sets it from the resolved tenant). Check that the route is mounted *after* `tenant.Middleware` and `RequireMember`. As a debug check, run as admin: `SELECT current_setting('app.tenant_id', true);` inside a sample query.

### Web port collision

Some dev tools / port forwarders grab `5173`+. Pass `WEB_PORT=<something free>` to the dev command. Update `CORS_ORIGINS` in `.env` to match if you hit CORS errors.

### WebSocket disconnect loop

The client reconnects with exponential backoff (1s → 30s). If it never sticks, check:
1. Browser is sending the session cookie (DevTools → Network → /ws → Request Cookies)
2. The `?tenant=<slug>` query param is present
3. `CORS_ORIGINS` env on the API includes the FE origin (used as `OriginPatterns`)

## Smoke test before shipping

Manual checklist on a fresh DB (`make compose-clean && make compose-up && make migrate && make seed`):

1. Log in as `owner@sahan.test` → see Sahan dashboard.
2. **Settings** → flip the brand colour → buttons recolour without reload.
3. **Menu** → add a category and a menu item.
4. **Tables** → add at least one table.
5. **Floor** → click the new table → add the menu item → **Send to kitchen**.
6. **Kitchen** (open in second browser tab) → ticket appears live → mark ready, then served.
7. Back on the tab → **Settle** → record cash → **Close**. Table flips to dirty.
8. **Inventory** → add an item, record a purchase, link a menu item → sell it → ledger shows the sale movement.
9. **Expenses** → log a cost with a menu_category allocation.
10. **Profitability** → drill into the category → confirm revenue and COGS line up.
11. **Shift** → open with a float → confirm cash-required guard releases → close with exact count → variance 0.
12. Sign out → log in as `waiter@sahan.test` → try to void → see manager-PIN prompt.
13. Run `cd apps/api && go test ./...` — multi-tenant isolation suite passes.

## What's intentionally NOT in v1

The original [plan](../README.md) lists deferred milestones D1–D11. Among them: receipt printing, eSewa/Khalti API integration, recipe/BOM, restaurant features (courses, splits, kitchen routing), per-cafe public storefronts, custom domains, mobile-native, full P&L, server-performance reports. These are documented seams, not blockers — the schema and event taxonomy already accommodate them.
