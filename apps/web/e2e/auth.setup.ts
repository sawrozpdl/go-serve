import { test as setup, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN_EMAIL, API_URL, BASE_URL, DB_URL, E2E_PREFIX, sql } from './bootstrap';

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(here, '.auth');
const STATE_FILE = path.join(AUTH_DIR, 'state.json');
const FIXTURES_FILE = path.join(AUTH_DIR, 'fixtures.json');

// Programmatic platform-admin login that bypasses email: inject an email_otps
// row whose hash is sha256('123456'), then call /auth/verify-otp to mint real
// tokens. Writes a Playwright storageState seeding localStorage['cafe-auth'].
// Also seeds a throwaway tenant (on the standard, no-trial plan) for the
// subscription/payment spec.
setup('authenticate + seed', async () => {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const code = '123456';
  const hash = createHash('sha256').update(code).digest('hex');
  const escEmail = ADMIN_EMAIL.replace(/'/g, "''");

  // Fresh single-use OTP for the admin email.
  execSync(
    `psql ${JSON.stringify(DB_URL)} -v ON_ERROR_STOP=1 -c ${JSON.stringify(
      `INSERT INTO email_otps (email, code_hash, expires_at, max_attempts) VALUES ('${escEmail}', '${hash}', now() + interval '15 min', 5);`,
    )}`,
    { stdio: 'ignore' },
  );

  // Verify → tokens. This also creates the user and syncs platform-admin from
  // PLATFORM_ADMIN_EMAILS.
  const res = await fetch(`${API_URL}/auth/verify-otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, code }),
  });
  expect(res.ok, `verify-otp failed: ${res.status} ${await res.clone().text()}`).toBeTruthy();
  const tokens = (await res.json()) as { access_token: string; refresh_token: string };
  expect(tokens.access_token, 'no access_token').toBeTruthy();

  // zustand persist shape for localStorage['cafe-auth'].
  const cafeAuth = JSON.stringify({
    state: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token },
    version: 0,
  });
  const origin = new URL(BASE_URL).origin;
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      cookies: [],
      origins: [{ origin, localStorage: [{ name: 'cafe-auth', value: cafeAuth }] }],
    }),
  );

  // Seed a bare tenant on the standard (no-trial) plan for the payment spec.
  const slug = `${E2E_PREFIX}-sub-${Date.now().toString(36)}`;
  const tenantId = sql(
    `INSERT INTO tenants (slug, name, plan_id) VALUES ('${slug}', 'E2E Subscription Cafe', (SELECT id FROM plans WHERE key = 'standard')) RETURNING id;`,
  );
  expect(tenantId, 'failed to seed tenant').toMatch(/^[0-9a-f-]{36}$/);

  fs.writeFileSync(FIXTURES_FILE, JSON.stringify({ tenantId, slug }));
});
