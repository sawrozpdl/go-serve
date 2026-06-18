import { test, expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tenant-side bug/feedback submit flow. Runs as the platform admin from
// auth.setup (also owner of the `booma` tenant), so the in-app launcher in the
// admin shell is reachable. Test reports are titled "E2E …" and purged by
// global-teardown.
const here = path.dirname(fileURLToPath(import.meta.url));
const SHOT = path.join(here, 'fixtures', 'shot.png');

async function openLauncher(page: Page) {
  await page.goto('/admin');
  // storageState carries no active tenant; single-membership auto-login lands
  // on /admin, but click the workspace row if a picker briefly shows.
  try {
    await page.locator('.picker-row').first().click({ timeout: 3000 });
  } catch {
    /* already on /admin */
  }
  await page.getByRole('button', { name: /report a bug/i }).click();
  const modal = page.getByRole('dialog');
  await expect(modal.getByRole('heading', { name: /share feedback/i })).toBeVisible();
  return modal;
}

test.describe('bug report — submit flow', () => {
  test('submit a bug with a screenshot → confetti + reference code', async ({ page }) => {
    const modal = await openLauncher(page);
    await modal.getByRole('radio', { name: 'Bug' }).click();
    await modal.getByPlaceholder('A one-line summary').fill(`E2E screenshot bug ${Date.now()}`);
    await modal.locator('textarea').fill('The settle button does nothing on the tablet floor view.');
    await modal.getByTitle('Furious').click(); // mood buttons expose the emoji as name; target the title

    await modal.locator('input[type="file"]').setInputFiles(SHOT);
    await expect(modal.locator('.bug-thumb img')).toHaveCount(1);

    await modal.getByRole('button', { name: /send it/i }).click();

    await expect(modal.locator('.bug-success')).toBeVisible();
    await expect(modal.locator('.bug-ref')).toHaveText(/^#[A-Z0-9]{6}$/);
    expect(await modal.locator('.bug-confetti-piece').count()).toBeGreaterThan(0);
  });

  test('an idea (no screenshot) appears under "Your reports" as Open', async ({ page }) => {
    const modal = await openLauncher(page);
    const title = `E2E idea ${Date.now()}`;
    await modal.getByRole('radio', { name: 'Idea' }).click();
    await modal.getByPlaceholder('A one-line summary').fill(title);
    await modal.locator('textarea').fill('A dark-mode receipt would be lovely.');
    await modal.getByRole('button', { name: /send it/i }).click();
    await expect(modal.locator('.bug-success')).toBeVisible();

    await modal.getByRole('button', { name: /report another/i }).click();
    await modal.getByRole('tab', { name: /your reports/i }).click();
    const row = modal.locator('.bug-mine-item', { hasText: title });
    await expect(row).toBeVisible();
    await expect(row.getByText('Open')).toBeVisible();
  });

  test('submit is blocked without a description', async ({ page }) => {
    const modal = await openLauncher(page);
    await modal.getByRole('button', { name: /send it/i }).click();
    await expect(modal.locator('.bug-success')).toHaveCount(0);
    await expect(modal.locator('textarea')).toBeVisible();
  });
});
