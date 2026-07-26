import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseNPR } from './read-money';

// The reported bug, in a browser: "credit settlement is counted as new sales".
//
// It is worth doing this at the UI level even though the Go e2e suite covers the
// same journey, because the thing that was actually wrong was what the SCREEN
// said — the number was right and the label was misleading. So this spec reads
// the same figures an owner reads, collects credit through the real form, and
// checks that Sales does not budge while Credit collected does.
//
// Then it reverses the collection, which is the correction path a cafe needs when
// money is entered against the wrong account, and checks the books return to
// where they were.

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `credit-${name}.png`), fullPage: true });

type Snapshot = { sales: number; creditCollected: number; balance: number };

// Marks the row this spec creates, so the reversal step targets it exactly.
// Unique per run: the dev database keeps every previous run's rows, and "the row
// with note X" has to mean this run's row.
const RUN = Date.now().toString(36);
const NOTE = `e2e collection ${RUN}`;
const REVERSAL_REASON = `e2e: entered by mistake (${RUN})`;

/** Read the Dashboard's Sales card and the credit figure inside its explainer. */
async function dashboardSnapshot(page: Page): Promise<{ sales: number; creditCollected: number }> {
  await page.goto('/admin');
  // Wait for the KPI queries rather than racing the skeletons.
  await expect(page.locator('.recon-row').first()).toBeVisible({ timeout: 15_000 });
  // Exact label: "Sales" is also a substring of "Net (sales − expenses)".
  const cards = page.locator('.kpi');
  await expect(cards.first()).toBeVisible();
  let sales: number | null = null;
  for (let i = 0; i < (await cards.count()); i++) {
    // Case-insensitive: the labels are uppercased in CSS and innerText returns
    // the transformed text.
    if ((await cards.nth(i).locator('.label').first().innerText()).trim().toLowerCase() === 'sales') {
      sales = parseNPR(await cards.nth(i).locator('.value').first().innerText());
      break;
    }
  }
  if (sales == null) throw new Error('no Sales KPI on the dashboard');

  // "Credit collected" appears in the reconciliation strip's Money in row.
  let creditCollected = 0;
  const row = page.locator('.recon-row', { hasText: 'Money in' }).first();
  if (await row.count()) {
    const text = await row.locator('.recon-terms').innerText();
    const m = text.match(/([\d,]+(?:\.\d+)?)\s*credit collected/);
    if (m) creditCollected = Math.round(parseFloat(m[1].replace(/,/g, '')) * 100);
  }
  return { sales, creditCollected };
}

test('collecting credit moves money without moving sales, and reverses cleanly', async ({ page }) => {
  // Find an account with something outstanding — the seed always leaves several.
  await page.goto('/admin/house-tabs');
  await expect(page.getByRole('heading', { name: 'Credit' }).first()).toBeVisible();

  const rows = page.locator('table.t tbody tr');
  await expect(rows.first()).toBeVisible();

  let target = -1;
  let owed = 0;
  for (let i = 0; i < (await rows.count()); i++) {
    const balance = parseNPR(await rows.nth(i).locator('td').nth(3).innerText());
    if (balance > 500) {
      target = i;
      owed = balance;
      break;
    }
  }
  expect(target, 'no credit account with an outstanding balance — run `make seed --reset`').toBeGreaterThanOrEqual(0);
  const accountName = (await rows.nth(target).locator('td').first().innerText()).split('\n')[0].trim();

  const before: Snapshot = { ...(await dashboardSnapshot(page)), balance: owed };
  await shot(page, '01-before');

  // --- Collect ----------------------------------------------------------
  await page.goto('/admin/house-tabs');
  await page.locator('table.t tbody tr', { hasText: accountName }).first().click();
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();

  // A round amount well inside the balance, so this works on any seeded state.
  const collect = 100_00; // Rs 100
  expect(owed, 'the chosen account should owe more than the test collects').toBeGreaterThan(collect);

  await modal.getByRole('button', { name: 'Cash' }).click();
  // The amount field, addressed through the settle form rather than "the first
  // input in the modal" — the reversal form below also has inputs.
  await modal.locator('.settle-form .row-inputs input').first().fill('100');
  // A note, so the row can be identified precisely later instead of reversing
  // "the first one" and hoping it is the one this test created.
  await modal.locator('.settle-form input[placeholder="optional"]').fill(NOTE);
  await shot(page, '02-collect-form');
  await modal.getByRole('button', { name: 'Record settlement' }).click();
  // A validation refusal would otherwise show up as a silent timeout below.
  await expect(modal.locator('.banner-error')).toHaveCount(0);

  // The account's own ledger updates first: outstanding drops by exactly the
  // amount collected.
  await expect(async () => {
    const balanceRow = modal.locator('.settle-row', { hasText: /balance owed/i }).first();
    const shown = parseNPR(await balanceRow.locator('.num').first().innerText());
    expect(shown).toBe(owed - collect);
  }).toPass({ timeout: 10_000 });
  await shot(page, '03-after-collect');

  // --- The Dashboard must not report new sales -------------------------
  const after = await dashboardSnapshot(page);
  expect(after.sales, 'collecting credit created new sales — the reported bug').toBe(before.sales);
  expect(
    after.creditCollected,
    'the collection did not show up as credit collected',
  ).toBe(before.creditCollected + collect);
  await shot(page, '04-dashboard-after');

  // --- Reverse it ------------------------------------------------------
  await page.goto('/admin/house-tabs');
  await page.locator('table.t tbody tr', { hasText: accountName }).first().click();
  const modal2 = page.getByRole('dialog');
  await expect(modal2).toBeVisible();

  const mine = modal2.locator('.settlement-row', { hasText: NOTE }).first();
  await expect(mine, 'the collection this test recorded is not in the ledger').toBeVisible();
  await mine.getByRole('button', { name: 'Reverse' }).click();

  // A reason is mandatory: the confirm button stays disabled until one is typed.
  const confirmBtn = modal2.getByRole('button', { name: 'Reverse collection' });
  await expect(confirmBtn).toBeDisabled();
  await modal2.getByPlaceholder('wrong amount / wrong account / duplicate entry').fill(REVERSAL_REASON);
  await expect(confirmBtn).toBeEnabled();
  await shot(page, '05-reverse-form');
  await confirmBtn.click();

  // The row stays, struck through, with the reason visible — the ledger has to
  // show what was entered AND what undid it.
  await expect(mine, 'the reversed row must stay in the ledger with its reason').toContainText(
    REVERSAL_REASON,
  );
  await expect(async () => {
    const balanceRow = modal2.locator('.settle-row', { hasText: /balance owed/i }).first();
    expect(parseNPR(await balanceRow.locator('.num').first().innerText())).toBe(owed);
  }).toPass({ timeout: 10_000 });
  await shot(page, '06-after-reverse');

  // And the day's figures are back where they started.
  const restored = await dashboardSnapshot(page);
  expect(restored.sales, 'sales moved during a reversal').toBe(before.sales);
  expect(restored.creditCollected, 'the reversed collection is still counted').toBe(
    before.creditCollected,
  );
});
