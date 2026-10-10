import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { E2E_PREFIX, sql } from './bootstrap';

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
  await expect(page.getByRole('heading', { name: 'Cafés' })).toBeVisible();
  await shot(page, '01-tenants-list');
});

test('plans page: trial column + create/edit trial_days', async ({ page }) => {
  await page.goto('/super/plans');
  await expect(page.getByRole('heading', { name: 'Plans' })).toBeVisible();

  // The Trial column renders the plan's configured length — read it from the
  // DB rather than pinning a number that product changes (it was 90, now 30).
  const trialDays = sql(`SELECT trial_days FROM plans WHERE key = 'trial';`);
  await expect(page.getByRole('columnheader', { name: 'Trial' })).toBeVisible();
  await expect(page.locator('tr', { hasText: 'Free Trial' })).toContainText(`${trialDays}d`);
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
  await expect(page.locator('.kpi .label', { hasText: 'Past due' })).toBeVisible();

  // The create-tenant plan dropdown is data-driven (shows trial-day suffixes),
  // no longer the hardcoded "Trial (90 days)" list.
  await page.getByRole('button', { name: 'New café' }).click();
  const opts = await page.locator('.field', { hasText: 'Plan' }).locator('select option').allTextContents();
  expect(opts.some((o) => /Standard/i.test(o)), `options: ${opts.join(' | ')}`).toBeTruthy();
  expect(opts.some((o) => /day trial/i.test(o)), `options: ${opts.join(' | ')}`).toBeTruthy();
  await shot(page, '05-new-tenant-dynamic-plans');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

test('tenant detail: record payment advances paid-through, then mark comped', async ({ page }) => {
  const fixtures = readFixtures();
  // Billing lives on its own tab now, addressable by URL.
  await page.goto(`/super/tenants/${fixtures.tenantId}?tab=billing`);
  const panel = page.locator('section.panel', { has: page.getByRole('heading', { name: 'Subscription & payments' }) });
  await expect(panel).toBeVisible();

  // Seeded standard tenant has no trial + no paid_through → comped.
  await expect(panel).toContainText('no paid subscription');
  await shot(page, '06-tenant-before-payment');

  // Record a payment: Rs 2000, bank, paid through +1 month.
  await panel.getByPlaceholder('amount (Rs)').fill('2000');
  await panel.locator('.field', { hasText: 'Record a payment' }).locator('select').selectOption('bank');
  // The renewal presets live in the date picker's popover.
  await panel.locator('.field', { hasText: 'Covers the workspace through' }).locator('.dp-trigger').click();
  await page.getByRole('button', { name: '+1 month' }).click();
  await panel.getByRole('button', { name: 'Record payment' }).click();

  // History row appears and status flips to paid.
  await expect(panel.locator('table tr', { hasText: 'bank' }).getByText(/2,000/)).toBeVisible();
  await expect(panel).not.toContainText('no paid subscription');
  await expect(page.locator('.pill', { hasText: 'Active (paid)' })).toBeVisible();
  await shot(page, '07-after-payment');

  // Mark comped via the confirm dialog → back to perpetual / no paid sub.
  await panel.getByRole('button', { name: 'Mark comped' }).click();
  await page.getByRole('dialog', { name: 'Mark comped?' }).getByRole('button', { name: 'Mark comped' }).click();
  await expect(page.locator('.pill', { hasText: 'Comped (perpetual)' })).toBeVisible();
  await expect(panel).toContainText('no paid subscription');
  await shot(page, '08-after-comp');
});
