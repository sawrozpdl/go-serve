import { test as setup, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_URL, BASE_URL, sql } from '../bootstrap';

// Signs in as the owner of the seeded demo cafe and writes a Playwright
// storageState for the money specs.
//
// Why a separate setup from auth.setup.ts: that one authenticates a PLATFORM
// ADMIN for the /super console, which is not a member of any cafe and therefore
// cannot open a Dashboard. These specs need a real cafe session — tokens plus
// the active-tenant slug the SPA persists after workspace selection.
//
// The data comes from `make seed` (apps/api/cmd/seed): 90 days of trading for
// `sahan` with discounts, half portions, voids, credit charges and collections,
// shift variances and transfers with fees. Asserting against a real trading
// history is the point — an empty cafe reconciles trivially.

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(here, '..', '.auth');
const STATE_FILE = path.join(AUTH_DIR, 'cafe.json');

export const CAFE_SLUG = process.env.E2E_CAFE_SLUG ?? 'sahan';
const OWNER_EMAIL = process.env.E2E_CAFE_OWNER ?? 'owner@sahan.test';

setup('sign in to the seeded cafe', async () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  // Fail with instructions, not with a mystery 401 three specs later.
  const tenantId = sql(`SELECT id FROM tenants WHERE slug = '${CAFE_SLUG}' LIMIT 1;`);
  expect(
    tenantId,
    `no tenant with slug "${CAFE_SLUG}" — run \`make seed\` first (it creates the demo cafes these specs read)`,
  ).toMatch(/^[0-9a-f-]{36}$/);

  const orders = Number(
    sql(`SELECT count(*) FROM orders WHERE tenant_id = '${tenantId}' AND status = 'closed';`),
  );
  expect(orders, `"${CAFE_SLUG}" has no closed orders — run \`make seed --reset\``).toBeGreaterThan(50);

  // Same OTP-injection trick as auth.setup.ts: write a single-use code, then
  // exchange it for genuine tokens through the real endpoint.
  const code = '123456';
  const hash = createHash('sha256').update(code).digest('hex');
  sql(
    `INSERT INTO email_otps (email, code_hash, expires_at, max_attempts) VALUES ('${OWNER_EMAIL}', '${hash}', now() + interval '15 min', 5);`,
  );

  const res = await fetch(`${API_URL}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: OWNER_EMAIL, code }),
  });
  expect(res.ok, `verify-otp for ${OWNER_EMAIL} failed: ${res.status} ${await res.clone().text()}`).toBeTruthy();
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  expect(tokens.access_token, 'no access_token').toBeTruthy();

  const origin = new URL(BASE_URL).origin;
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      cookies: [],
      origins: [
        {
          origin,
          localStorage: [
            {
              name: 'cafe-auth',
              value: JSON.stringify({
                state: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
                version: 0,
              }),
            },
            // The slug the SPA sends as X-Tenant-ID, so specs land straight on
            // the cafe instead of the workspace picker.
            {
              name: 'cafe-active-tenant',
              value: JSON.stringify({ state: { slug: CAFE_SLUG }, version: 0 }),
            },
          ],
        },
      ],
    }),
  );
});
