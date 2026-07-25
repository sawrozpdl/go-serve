import { test, expect, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { allNPR, parseNPR } from './read-money';

// Does the app tell the owner the same thing on every screen?
//
// The Go e2e suite proves the ENDPOINTS agree. This proves the SCREENS do — that
// what is rendered matches what was returned, that the explainer popovers show
// arithmetic that actually adds up to the number above them, and that the same
// money is not called two different things in two places. That is the part an
// owner experiences, and it is the part no API test can see.
//
// Runs against the seeded `sahan` cafe (90 days of trading), so the numbers are
// production-shaped rather than a single tidy order.

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(here, '..', 'screenshots');
fs.mkdirSync(SHOTS, { recursive: true });
const shot = (page: Page, name: string) =>
  page.screenshot({ path: path.join(SHOTS, `money-${name}.png`), fullPage: true });

// -------------------------------------------------------------------------
// Reading money off the page
// -------------------------------------------------------------------------

/**
 * The KPI card whose label is EXACTLY `label`, case-insensitively.
 *
 * Exact rather than substring: "Sales" is also inside "Net (sales − expenses)",
 * and matching both silently reads the wrong figure. Case-insensitive because the
 * labels are uppercased in CSS, and innerText returns the transformed text.
 */
async function kpiCard(page: Page, label: string): Promise<Locator> {
  const cards = page.locator('.kpi');
  await expect(cards.first()).toBeVisible();
  const seen: string[] = [];
  for (let i = 0; i < (await cards.count()); i++) {
    const card = cards.nth(i);
    const text = (await card.locator('.label').first().innerText()).trim();
    seen.push(text);
    if (text.toLowerCase() === label.toLowerCase()) return card;
  }
  throw new Error(`no KPI card labelled "${label}" — found: ${seen.join(', ')}`);
}

async function kpi(page: Page, label: string): Promise<number> {
  const card = await kpiCard(page, label);
  return parseNPR(await card.locator('.value').first().innerText());
}

// -------------------------------------------------------------------------
// The explainers must not lie
// -------------------------------------------------------------------------

/**
 * Open every "How X is calculated" popover on the page and assert none reports a
 * mismatch.
 *
 * FormulaHint renders `.formula__mismatch` when the terms it lists do not sum to
 * the figure it claims to explain. That is a self-check built into the UI, so the
 * strongest browser assertion available is simply: it never fires, on any screen,
 * against real trading data.
 */
async function everyFormulaAddsUp(page: Page, screen: string) {
  const triggers = page.locator('button.info-hint__trigger[aria-label^="How "]');
  const count = await triggers.count();
  expect(count, `${screen}: no formula explainers found — the hints may have been dropped`).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible())) continue;
    const what = (await trigger.getAttribute('aria-label')) ?? `hint ${i}`;
    await trigger.click(); // click pins the bubble open
    const bubble = page.locator('.info-hint__bubble').filter({ has: page.locator('.formula') }).first();
    await expect(bubble, `${screen}: ${what} did not open`).toBeVisible();

    const mismatch = bubble.locator('.formula__mismatch');
    if (await mismatch.count()) {
      throw new Error(`${screen}: ${what} contradicts the figure it explains — ${await mismatch.innerText()}`);
    }

    // The popover's own parts must sum to its own result, independently of the
    // component's check: this catches a formula whose rows render correctly but
    // whose result was passed in from somewhere else.
    const rows = bubble.locator('.formula__row:not(.formula__row--result)');
    const n = await rows.count();
    if (n > 0) {
      let sum = 0;
      for (let r = 0; r < n; r++) {
        const op = (await rows.nth(r).locator('.formula__op').innerText()).trim();
        const value = parseNPR(await rows.nth(r).locator('.formula__value').innerText());
        sum += op === '−' || op === '-' ? -value : value;
      }
      const result = parseNPR(
        await bubble.locator('.formula__row--result .formula__value').first().innerText(),
      );
      expect(sum, `${screen}: ${what} — the listed parts sum to ${sum}, but it claims ${result}`).toBe(result);
    }

    await page.keyboard.press('Escape');
  }
}

// -------------------------------------------------------------------------
// Specs
// -------------------------------------------------------------------------

test('dashboard: the day reconciles on screen', async ({ page }) => {
  await page.goto('/admin');
  // Wait for the KPI queries to settle rather than racing the skeletons.
  await expect(page.locator('.recon-row').first()).toBeVisible({ timeout: 15_000 });

  const sales = await kpi(page, 'Sales');
  const balance = await kpi(page, 'Cafe balance');
  expect(sales, 'the seeded cafe should have sales today').toBeGreaterThan(0);

  // Cafe balance's subtext lists the buckets; they must sum to the headline.
  const subtext = (await kpiCard(page, 'Cafe balance')).locator('.subtext, .meta').first();
  if (await subtext.count()) {
    const parts = allNPR(await subtext.innerText());
    const sum = parts.reduce((a, b) => a + b, 0);
    expect(sum, `cafe balance parts (${parts.join(' + ')}) must sum to the headline`).toBe(balance);
  }

  // "Where the money went": each additive row's terms must sum to its total. The
  // addends are the <b> figures; anything after the "·" is a channel breakdown,
  // and the --muted row is prose rather than a sum.
  const rows = page.locator('.recon-row:not(.recon-row--muted)');
  const rowCount = await rows.count();
  expect(rowCount, 'the reconciliation strip is missing').toBeGreaterThan(0);
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const label = (await row.locator('.recon-label').innerText()).trim();
    const bolds = row.locator('.recon-terms b');
    let sum = 0;
    const shown: string[] = [];
    for (let b = 0; b < (await bolds.count()); b++) {
      const text = await bolds.nth(b).innerText();
      shown.push(text);
      sum += parseNPR(text);
    }
    const total = parseNPR(await row.locator('.recon-total').innerText());
    expect(sum, `"${label}" shows ${shown.join(' + ')} but totals ${total}`).toBe(total);
  }

  // Billed sales row must equal the Sales KPI above it — the same money, twice
  // on one screen, is exactly where an inconsistency would be noticed.
  const billed = page.locator('.recon-row', { hasText: /billed sales/i }).first();
  expect(parseNPR(await billed.locator('.recon-total').innerText())).toBe(sales);

  // The muted row states what part of billed sales is not the cafe's: its total
  // is net revenue, so sales − the VAT it names must equal it exactly.
  const muted = page.locator('.recon-row--muted').first();
  if (await muted.count()) {
    const terms = await muted.locator('.recon-terms').innerText();
    const vatMatch = terms.match(/([\d,]+(?:\.\d+)?)\s*is VAT/i);
    if (vatMatch) {
      const vat = Math.round(parseFloat(vatMatch[1].replace(/,/g, '')) * 100);
      const netShown = parseNPR(await muted.locator('.recon-total').innerText());
      expect(sales - vat, 'billed sales − VAT must equal the net revenue shown').toBe(netShown);
    }
  }

  await shot(page, '01-dashboard');
  await everyFormulaAddsUp(page, 'Dashboard');
});

test('profitability: net revenue is labelled as such and derives from billed sales', async ({ page }) => {
  await page.goto('/admin/reports/profitability');
  await expect(page.getByText(/net revenue/i).first()).toBeVisible();

  // The audit's whole point: this figure is NOT called "Sales" any more, because
  // it excludes VAT the cafe is only holding for the government.
  await expect(page.locator('.np-label', { hasText: /net revenue/i }).first()).toBeVisible();

  // COGS is labelled with what it contains, not just "allocated".
  await expect(page.getByText(/cogs \(direct \+ allocated\)/i).first()).toBeVisible();

  // The category table's Net revenue column must sum to the reported total.
  const table = page.locator('table').filter({ has: page.getByRole('columnheader', { name: /net revenue/i }) }).first();
  await expect(table).toBeVisible();
  const header = table.locator('thead th');
  let netCol = -1;
  for (let i = 0; i < (await header.count()); i++) {
    if ((await header.nth(i).innerText()).trim().toLowerCase() === 'net revenue') netCol = i;
  }
  expect(netCol, 'no Net revenue column').toBeGreaterThanOrEqual(0);

  const bodyRows = table.locator('tbody tr');
  let sum = 0;
  for (let r = 0; r < (await bodyRows.count()); r++) {
    const cell = bodyRows.nth(r).locator('td').nth(netCol);
    if (!(await cell.count())) continue;
    const text = (await cell.innerText()).trim();
    if (!/\d/.test(text)) continue;
    sum += parseNPR(text);
  }

  const footer = table.locator('tfoot tr').first();
  if (await footer.count()) {
    const totalCell = footer.locator('td, th').nth(netCol);
    if (await totalCell.count()) {
      expect(sum, 'category net revenue must sum to the table total').toBe(
        parseNPR(await totalCell.innerText()),
      );
    }
  }

  await shot(page, '02-profitability');
  await everyFormulaAddsUp(page, 'Profitability');
});

test('accounts: the drawer and the cash ledger are told apart', async ({ page }) => {
  await page.goto('/admin/accounts');

  // Two figures, ~100px apart, that answer different questions. Before the audit
  // both were called "Cash drawer" and read differently, which looked like a bug.
  await expect(page.getByText(/drawer · this shift/i).first()).toBeVisible();
  await expect(page.getByText(/cash drawer/i).first()).toBeVisible();

  await shot(page, '03-accounts');
  await everyFormulaAddsUp(page, 'Accounts');
});

test('shift screen explains its own arithmetic', async ({ page }) => {
  await page.goto('/admin/shift');
  await expect(page.locator('h1, h2').first()).toBeVisible();
  await shot(page, '05-shift');
  await everyFormulaAddsUp(page, 'Shift');
});

test('owners screen explains its lifetime net profit', async ({ page }) => {
  await page.goto('/admin/owners');
  // The returns card lives on the Financials tab, not the roster.
  await page.getByRole('tab', { name: /financials/i }).click();
  await expect(page.getByText(/net profit \(lifetime\)/i).first()).toBeVisible();
  await shot(page, '06-owners');
  await everyFormulaAddsUp(page, 'Owners');
});

// The History day panel is the other place the day is added up, and it must
// match the Dashboard for the same date. It has topic explainers rather than
// formula popovers, so it gets its own check.
test('history: the day panel agrees with the dashboard', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.locator('.recon-row').first()).toBeVisible({ timeout: 15_000 });
  const sales = await kpi(page, 'Sales');

  await page.goto('/admin/history');
  const grossStat = page.locator('.hs-stat', { hasText: /gross sales/i }).first();
  await expect(grossStat, 'the History day panel is missing').toBeVisible({ timeout: 15_000 });
  const gross = parseNPR(await grossStat.locator('.hs-stat-value').first().innerText());
  expect(gross, "History's gross sales must equal the Dashboard's Sales for the same day").toBe(sales);

  // The payment tiles split that same money by channel; credit is called out as
  // "not in hand" rather than folded in silently.
  const pay = page.locator('.hs-pay');
  let paid = 0;
  for (let i = 0; i < (await pay.count()); i++) {
    paid += parseNPR(await pay.nth(i).innerText());
  }
  expect(paid, 'the channel tiles must account for the whole day').toBe(gross);

  await shot(page, '04-history');
});
