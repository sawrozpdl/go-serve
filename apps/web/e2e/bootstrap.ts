// Shared bootstrap constants/helpers for the E2E auth + DB seeding.
// All DB access is via the local `psql` CLI against the dev database — no extra
// node pg dependency. Test artifacts (plans/tenants) use the E2E_PREFIX so the
// global teardown can purge exactly what we created.
import { execSync } from 'node:child_process';

export const DB_URL = process.env.E2E_DB_URL ?? 'postgresql://pewssh@localhost:5432/cafe?sslmode=disable';
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:9090';
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5891';
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'sarojpaudyal53@gmail.com';
export const E2E_PREFIX = 'e2e';

/** Run a SQL statement via psql, returning trimmed stdout (use -t -A queries).
 *  -q suppresses command tags (e.g. "INSERT 0 1") so RETURNING output is clean. */
export function sql(statement: string): string {
  return execSync(`psql ${JSON.stringify(DB_URL)} -q -t -A -v ON_ERROR_STOP=1 -c ${JSON.stringify(statement)}`, {
    encoding: 'utf8',
  }).trim();
}
