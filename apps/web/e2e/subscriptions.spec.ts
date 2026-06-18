import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { E2E_PREFIX } from './bootstrap';

const here = path.dirname(fileURLToPath(import.meta.url));

// Read lazily inside tests: this file is collected before the setup project
// (which writes fixtures.json) has run.
function readFixtures(): { tenantId: string; slug: string } {
  return JSON.parse(fs.readFileSync(path.join(here, '.auth', 'fixtures.json'), 'utf8'));
}

const SHOTS = path.join(here, 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });

// Fill an input/select inside the modal `.field` whose label contains `label`.
function field(scope: Page | Locator, label: string): Locator {
  return scope.locator('.field', { hasText: label }).locator('input, select').first();
}

const planKey = `${E2E_PREFIX}tp-${Date.now().toString(36)}`;

test('super console loads as platform admin', async ({ page }) => {
  await page.goto('/super/tenants');
  await expect(page.getByRole('heading', { name: 'Tenants' })).toBeVisible();
  await shot(page, '01-tenants-list');
});

test('plans page: trial column + create/edit trial_days', async ({ page }) => {
  await page.goto('/super/plans');
  await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();

  // The seed catalog renders the new Trial column; Free Trial shows 90d.
  await expect(page.getByRole('columnheader', { name: 'Trial' })).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Free Trial' })).toContainText('90d');
  await shot(page, '02-plans-trial-column');

  // Create a plan with a custom trial window.
  await page.getByRole('button', { name: 'New plan' }).click();
  const dialog = page.getByRole('dialog');
  await field(dialog, 'Key').fill(planKey);
  await field(dialog, 'Name').fill('E2E Trial Plan');
  await field(dialog, 'Trial length').fill('14');
  await shot(page, '03-new-plan-modal');
  await dialog.getByRole('button', { name: 'Save' }).click();

  const row = page.locator('tr', { hasText: 'E2E Trial Plan' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('14d');

  // Edit it to 21 days.
  await row.getByRole('button', { name: 'Edit' }).click();
  const editDialog = page.getByRole('dialog');
  await field(editDialog, 'Trial length').fill('21');
  await editDialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('tr', { hasText: 'E2E Trial Plan' })).toContainText('21d');
  await shot(page, '04-plan-trial-edited');
});

test('tenants page: past-due KPI + dynamic plan dropdown', async ({ page }) => {
  await page.goto('/super/tenants');
  // New "Past due" KPI is rendered.
  await expect(page.locator('.kpi-label', { hasText: 'Past due' })).toBeVisible();

  // The create-tenant plan dropdown is data-driven (shows trial-day suffixes),
  // no longer the hardcoded "Trial (90 days)" list.
  await page.getByRole('button', { name: 'New tenant' }).click();
  const opts = await page.locator('.field', { hasText: 'Plan' }).locator('select option').allTextContents();
  expect(opts.some((o) => /Standard/i.test(o)), `options: ${opts.join(' | ')}`).toBeTruthy();
  expect(opts.some((o) => /day trial/i.test(o)), `options: ${opts.join(' | ')}`).toBeTruthy();
  await shot(page, '05-new-tenant-dynamic-plans');
  await page.getByRole('button', { name: 'Cancel' }).click();
});

test('tenant detail: record payment advances paid-through, then mark comped', async ({ page }) => {
  const fixtures = readFixtures();
  await page.goto(`/super/tenants/${fixtures.tenantId}`);
  await expect(page.getByRole('heading', { name: 'Subscription & payments' })).toBeVisible();

  // Seeded standard tenant has no trial + no paid_through → comped.
  await expect(page.locator('.super-dl')).toContainText('no paid subscription');
  await shot(page, '06-tenant-before-payment');

  // Record a payment: Rs 2000, bank, paid through +1 month.
  await page.getByPlaceholder('amount (Rs)').fill('2000');
  await page.locator('.field', { hasText: 'Record a payment' }).locator('select').selectOption('bank');
  await page.getByRole('button', { name: '+1mo' }).click();
  await page.getByRole('button', { name: 'Record payment' }).click();

  // History row appears and status flips to paid.
  await expect(page.locator('table', { hasText: 'NPR' }).getByText(/NPR\s*2,000\.00/)).toBeVisible();
  await expect(page.locator('.super-dl')).not.toContainText('no paid subscription');
  await expect(page.locator('.pill', { hasText: 'Active (paid)' })).toBeVisible();
  await shot(page, '07-after-payment');

  // Mark comped via the confirm dialog → back to perpetual / no paid sub.
  await page.locator('section', { hasText: 'Subscription & payments' }).getByRole('button', { name: 'Mark comped' }).click();
  await page.getByRole('dialog', { name: 'Mark comped?' }).getByRole('button', { name: 'Mark comped' }).click();
  await expect(page.locator('.pill', { hasText: 'Comped (perpetual)' })).toBeVisible();
  await expect(page.locator('.super-dl')).toContainText('no paid subscription');
  await shot(page, '08-after-comp');
});
