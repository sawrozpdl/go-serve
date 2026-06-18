import { test, expect, type Page } from '@playwright/test';

// Super-admin triage of bug reports. Runs as the platform admin from auth.setup.
// Seeds a report through the in-app launcher (admin is owner of `booma`), then
// resolves it from the /super console. "E2E …" titles are purged by teardown.
async function submitReport(page: Page, title: string) {
  await page.goto('/admin');
  try {
    await page.locator('.picker-row').first().click({ timeout: 3000 });
  } catch {
    /* already on /admin */
  }
  await page.getByRole('button', { name: /report a bug/i }).click();
  const modal = page.getByRole('dialog');
  await modal.getByRole('radio', { name: 'Bug' }).click();
  await modal.getByPlaceholder('A one-line summary').fill(title);
  await modal.locator('textarea').fill('Triage me from the super console.');
  await modal.getByRole('button', { name: /send it/i }).click();
  await expect(modal.locator('.bug-success')).toBeVisible();
}

test.describe('bug report — super-admin triage', () => {
  test('console shows status chips and search', async ({ page }) => {
    await page.goto('/super/bug-reports');
    await expect(page.getByRole('heading', { name: 'Bug reports' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Open/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Resolved/ })).toBeVisible();
    await expect(page.getByPlaceholder(/search/i)).toBeVisible();
  });

  test('resolving a report moves it from Open to Resolved', async ({ page }) => {
    const title = `E2E triage ${Date.now()}`;
    await submitReport(page, title);

    await page.goto('/super/bug-reports');
    await page.getByPlaceholder(/search/i).fill(title);
    const card = page.locator('.bug-card', { hasText: title });
    await expect(card).toBeVisible();

    await card.click();
    const modal = page.getByRole('dialog');
    await expect(modal).toBeVisible();
    await modal.locator('select').first().selectOption('resolved');
    await modal.getByRole('button', { name: /^save$/i }).click();

    // Gone from the default Open filter…
    await expect(page.locator('.bug-card', { hasText: title })).toHaveCount(0);
    // …and present under Resolved.
    await page.getByRole('button', { name: /^Resolved/ }).click();
    await page.getByPlaceholder(/search/i).fill(title);
    await expect(page.locator('.bug-card', { hasText: title })).toBeVisible();
  });
});
