import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ADMIN_EMAIL, E2E_PREFIX, sql } from './bootstrap';

const here = path.dirname(fileURLToPath(import.meta.url));

// Purge everything the E2E run created so the dev DB stays clean:
//   - the seeded throwaway tenant (bare row → plain DELETE; tenant_payments
//     cascades) plus any other e2e-* tenants created via the UI (purged via the
//     SECURITY DEFINER helper so provisioned children go too),
//   - e2e* plans,
//   - the admin's test OTP rows.
export default async function teardown() {
  try {
    // Any tenant we created carries the e2e- slug prefix.
    const ids = sql(`SELECT id FROM tenants WHERE slug LIKE '${E2E_PREFIX}-%';`)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const id of ids) {
      // purge_tenant_data handles both bare and fully-provisioned tenants.
      try {
        sql(`SELECT purge_tenant_data('${id}', ARRAY['everything']);`);
      } catch {
        sql(`DELETE FROM tenants WHERE id = '${id}';`);
      }
    }

    sql(`DELETE FROM plans WHERE key LIKE '${E2E_PREFIX}%';`);
    sql(`DELETE FROM email_otps WHERE email = '${ADMIN_EMAIL.replace(/'/g, "''")}';`);
    // Bug-report specs file reports (titled "E2E …") into an existing tenant, so
    // they aren't covered by the tenant purge above. Attachments cascade.
    sql(`DELETE FROM bug_reports WHERE title LIKE 'E2E %';`);

    const fixtures = path.join(here, '.auth', 'fixtures.json');
    if (fs.existsSync(fixtures)) fs.rmSync(fixtures);
    // eslint-disable-next-line no-console
    console.log(`E2E teardown: purged ${ids.length} tenant(s) + e2e plans + test OTPs.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('E2E teardown failed (manual cleanup may be needed):', err);
  }
}
