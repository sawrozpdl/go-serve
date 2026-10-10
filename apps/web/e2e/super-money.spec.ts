import { test, expect, type Page } from '@playwright/test';

import { sql } from './bootstrap';

// /super/money — partner capital + company balance (0087), and the existing
// tabs it sits beside. Runs as the platform admin from auth.setup.
//
// The dev DB is shared, so every money assertion is a DELTA against what the
// page showed before, never an absolute figure. Fixtures are named "E2E …" and
// purged by global-teardown.

const RUN = Date.now().toString(36);
const ONE = `E2E Partner One ${RUN}`;
const TWO = `E2E Partner Two ${RUN}`;
const LAKH = 100_000_00; // paisa

/** "रू 1,23,456.78" / "−रू 50" / "रू -50" → paisa. */
function paisa(text: string): number {
  const t = text.replace(/\u00a0/g, ' ');
  const m = t.match(/-?[\d,]+(\.\d+)?/);
  if (!m) throw new Error(`no number in ${JSON.stringify(text)}`);
  const n = Math.round(parseFloat(m[0].replace(/,/g, '')) * 100);
  return t.trim().startsWith('−') ? -n : n;
}

async function openTab(page: Page, name: string) {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

async function kpi(page: Page, label: string): Promise<number> {
  const value = page.locator('.kpi', { has: page.locator('.label', { hasText: label }) }).locator('.value');
  await expect(value).toBeVisible();
  return paisa(await value.innerText());
}

/** Reads the Balance tab: the headline figure, and asserts the "How we got
 *  here" bridge adds up to it exactly.
 *
 *  Retried until consistent: after a write, the tab first paints the cached
 *  statement and then the refetch, so a read can straddle the two. */
async function readBalance(page: Page): Promise<number> {
  await openTab(page, 'Balance');
  let result = 0;
  await expect(async () => {
    result = await readBalanceOnce(page);
  }).toPass({ timeout: 10_000 });
  return result;
}

async function readBalanceOnce(page: Page): Promise<number> {
  const balance = await kpi(page, 'Company balance');

  const bridge = page.locator('.panel', { has: page.getByRole('heading', { name: 'How we got here' }) });
  const terms = bridge.locator('dd');
  const n = await terms.count();
  const values: number[] = [];
  for (let i = 0; i < n; i++) values.push(paisa(await terms.nth(i).innerText()));
  const total = values.pop()!; // the last row is the Balance line
  expect(values.reduce((a, b) => a + b, 0), 'bridge terms must sum to the balance').toBe(total);
  expect(total, 'bridge total must equal the headline balance').toBe(balance);

  // Where-the-money-is must also add up to the same figure.
  const where = page.locator('.panel', { has: page.getByRole('heading', { name: 'Where the money is' }) });
  const parts = await where.locator('dd').allInnerTexts();
  const whereTotal = paisa(parts.pop()!);
  expect(parts.map(paisa).reduce((a, b) => a + b, 0)).toBe(whereTotal);
  expect(whereTotal).toBe(balance);
  return balance;
}

function card(page: Page, name: string) {
  return page.locator('.cash-card', { has: page.locator('strong', { hasText: name }) });
}

async function recordCapital(page: Page, who: string, rupees: number, opts: { out?: boolean; wallet?: boolean } = {}) {
  await openTab(page, 'Capital');
  await page.getByRole('button', { name: /record capital/i }).click();
  const modal = page.getByRole('dialog', { name: 'Record capital' });
  if (opts.out) await modal.getByRole('radio', { name: 'Take out' }).click();
  await modal.locator('select').selectOption({ label: who });
  await modal.getByPlaceholder('0.00').fill(String(rupees));
  if (opts.wallet) await modal.getByRole('radio', { name: 'Wallet' }).click();
  await modal.getByPlaceholder('note (optional)').fill(`E2E ${RUN}`);
  await modal.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(modal).toHaveCount(0);
}

async function recordExpense(
  page: Page,
  rupees: number,
  vendor: string,
  paidFrom: 'Bank' | 'Wallet' | 'Paid personally',
  who?: string,
) {
  await openTab(page, 'Expenses');
  await page.getByRole('button', { name: /record spending/i }).click();
  const modal = page.getByRole('dialog', { name: 'Record spending' });
  await modal.getByPlaceholder('0.00').fill(String(rupees));
  await modal.locator('select').first().selectOption({ label: 'Hardware' });
  await modal.getByPlaceholder('who we paid').fill(vendor);
  await modal.getByRole('radio', { name: paidFrom }).click();
  if (who) await modal.locator('select').nth(1).selectOption({ label: who });
  await modal.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(modal).toHaveCount(0);
}

async function confirmDelete(page: Page) {
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
}

test.describe('super money — capital + company balance', () => {
  test.beforeAll(() => {
    sql(`INSERT INTO platform_people (name, kind) VALUES ('${ONE}', 'admin'), ('${TWO}', 'admin');`);
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/super/money');
    await expect(page.getByRole('heading', { name: 'Money' })).toBeVisible();
  });

  test('every tab loads without an error state', async ({ page }) => {
    for (const name of ['Revenue', 'Expenses', 'Cash', 'Capital', 'Balance']) {
      await openTab(page, name);
      await expect(page.getByText(/^Could not load/)).toHaveCount(0);
    }
    await readBalance(page); // asserts both reconciliations on the live data
  });

  test('a contribution raises the balance and shows on the partner’s card', async ({ page }) => {
    const before = await readBalance(page);
    await recordCapital(page, ONE, 100000);

    await expect(card(page, ONE).locator('.cash-card__amount')).toHaveText(/1,00,000/);
    await expect(page.locator('tr', { hasText: ONE }).first()).toContainText('Put in');

    await expect.poll(() => readBalance(page)).toBe(before + LAKH);
  });

  test('a purchase paid personally is investment, not company money', async ({ page }) => {
    const before = await readBalance(page);
    const capitalBefore = await kpi(page, 'Partners’ capital');

    await recordExpense(page, 15000, `E2E printer ${RUN}`, 'Paid personally', TWO);
    const row = page.locator('tr', { hasText: `E2E printer ${RUN}` });
    await expect(row).toContainText(`${TWO} · personal`);

    await openTab(page, 'Capital');
    await expect(card(page, TWO).locator('.cash-card__amount')).toHaveText(/15,000/);
    await expect(card(page, TWO)).toContainText('Paid personally');
    await expect(page.locator('tr', { hasText: TWO }).first()).toContainText('Paid personally');

    // Same statement response as the balance: once capital shows the purchase,
    // the balance on screen is fresh — and must not have moved.
    await openTab(page, 'Balance');
    await expect.poll(() => kpi(page, 'Partners’ capital')).toBe(capitalBefore + 15000_00);
    expect(await readBalance(page)).toBe(before);

    // Deleting the expense takes it back out of their capital.
    await openTab(page, 'Expenses');
    await row.getByRole('button', { name: 'Delete' }).click();
    await confirmDelete(page);
    await expect(row).toHaveCount(0);
    await openTab(page, 'Capital');
    await expect(card(page, TWO)).toHaveCount(0);
  });

  test('bank and wallet spending lower the balance; deleting restores it', async ({ page }) => {
    const before = await readBalance(page);

    await recordExpense(page, 5000, `E2E bank spend ${RUN}`, 'Bank');
    await recordExpense(page, 700, `E2E wallet spend ${RUN}`, 'Wallet');
    await expect.poll(() => readBalance(page)).toBe(before - 5700_00);

    await openTab(page, 'Expenses');
    for (const vendor of [`E2E bank spend ${RUN}`, `E2E wallet spend ${RUN}`]) {
      const row = page.locator('tr', { hasText: vendor });
      await row.getByRole('button', { name: 'Delete' }).click();
      await confirmDelete(page);
      await expect(row).toHaveCount(0);
    }
    await expect.poll(() => readBalance(page)).toBe(before);
  });

  test('a withdrawal lowers the balance; deleting the entry restores it', async ({ page }) => {
    const before = await readBalance(page);
    await recordCapital(page, ONE, 20000, { out: true, wallet: true });

    const row = page.locator('tr', { hasText: ONE }).filter({ hasText: 'Taken out' });
    await expect(row).toContainText('Wallet');
    await expect.poll(() => readBalance(page)).toBe(before - 20000_00);

    await openTab(page, 'Capital');
    await row.getByRole('button', { name: 'Delete' }).click();
    await confirmDelete(page);
    await expect(row).toHaveCount(0);
    await expect.poll(() => readBalance(page)).toBe(before);
  });

  test('the capital form needs a person and an amount', async ({ page }) => {
    await openTab(page, 'Capital');
    await page.getByRole('button', { name: /record capital/i }).click();
    const modal = page.getByRole('dialog', { name: 'Record capital' });
    const save = modal.getByRole('button', { name: 'Record', exact: true });
    await expect(save).toBeDisabled();
    await modal.getByPlaceholder('0.00').fill('500');
    await expect(save).toBeDisabled();
    await modal.locator('select').selectOption({ label: ONE });
    await expect(save).toBeEnabled();
    await modal.getByRole('button', { name: 'Cancel' }).click();
    await expect(modal).toHaveCount(0);
  });
});
