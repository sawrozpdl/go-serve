// Money sections — expense register, balances, transfers, owners, credit.
//
// Two vocabulary rules from money.go apply throughout:
//   - an account's inflow is split into `payments_cents` (sales) and
//     `credit_collected_cents` (money against EARLIER sales). Printing the sum
//     as "sales" is the exact bug the credit-collected work fixed; don't
//     reintroduce it in the PDF.
//   - "credit collected", never "settlement" (that's the database's word).

import { request } from '@/lib/api';
import type {
  AccountBalance,
  AccountTransfer,
  CafeBalance,
  CafeOwner,
  CafeSummary,
  Expense,
  HouseTab,
  HouseTabDetail,
  OwnerCashResponse,
  OwnerLedgerEntry,
} from '@cafe-mgmt/api-types';

import {
  count,
  dateTime,
  money,
  orDash,
  paidFromLabel,
  pct,
  shortDate,
  signedMoney,
  titleCase,
} from '../format';
import { resolveWindowDays } from '../window';
import {
  boundRows,
  defineSection,
  heading,
  note,
  pageAll,
  totalRow,
  type LoadCtx,
} from '../section';
import type { ReportBlock, TableRow } from '../types';

function get<T>(ctx: LoadCtx, path: string): Promise<T> {
  return request<T>('GET', path, { tenantSlug: ctx.slug });
}

// ---------------------------------------------------------------------------
// Expense register
// ---------------------------------------------------------------------------

type ExpenseData = {
  rows: Expense[];
  total: number;
  truncated: boolean;
  from?: string;
  to?: string;
};

export const moneyExpenses = defineSection<ExpenseData>({
  id: 'money.expenses',
  group: 'Money',
  label: 'Expense register',
  description: 'Every expense paid in the period, with category, vendor and source.',
  perm: 'expense:read',
  needsRange: true,
  defaultDetail: 'full',
  detailLevels: ['topN', 'full'],
  load: async (ctx) => {
    // Explicit days, always: this endpoint filters on paid_at and treats a
    // missing from/to as "every expense ever recorded".
    const w = await resolveWindowDays(ctx);
    const qs = new URLSearchParams({ from: w.from, to: w.to });
    const paged = await pageAll<Expense>(
      async (offset, limit) => {
        const q = new URLSearchParams(qs);
        q.set('limit', String(limit));
        q.set('offset', String(offset));
        const r = await get<{ expenses: Expense[]; total: number }>(ctx, `/v1/expenses?${q}`);
        return { rows: r.expenses, total: r.total ?? r.expenses.length };
      },
      // The endpoint caps a page at 2000 (maxExpensePage); ask for less per
      // round-trip so a big year streams in rather than timing out at once.
      { pageSize: 500, hardCap: 10_000 },
    );
    return { rows: paged.rows, total: paged.total, truncated: paged.truncated, ...w };
  },
  rowCount: (d) => d.total,
  resolvedWindow: (d) => ({ from: d.from, to: d.to }),
  render: (d, opts) => {
    const { rows, caption } = boundRows(d.rows, opts, {
      total: d.total,
      truncated: d.truncated,
      orderedBy: 'date paid (most recent first)',
      emptyText: 'No expenses were paid in this period.',
    });
    const shown = rows.reduce((n, e) => n + e.amount_cents, 0);
    const all = d.rows.reduce((n, e) => n + e.amount_cents, 0);
    const bounded = rows.length < d.rows.length;

    // Grouping by category is what makes this usable as an accounting document
    // rather than a flat log.
    const byCategory = new Map<string, number>();
    for (const e of d.rows) {
      const key = e.expense_category_name ?? 'Untagged';
      byCategory.set(key, (byCategory.get(key) ?? 0) + e.amount_cents);
    }
    const catRows: TableRow[] = [...byCategory.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, amount]) => ({
        cells: [name, money(amount), all > 0 ? pct((amount / all) * 100) : '—'],
      }));

    return [
      heading('Expense register'),
      heading('By category', undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        caption: `Totals below cover all ${count(d.rows.length)} expenses retrieved for this period.`,
        columns: [
          { key: 'cat', label: 'Category', width: 3 },
          { key: 'amt', label: 'Total', numeric: true, width: 2 },
          { key: 'share', label: 'Share', numeric: true, width: 1 },
        ],
        rows: [...catRows, totalRow(['Total', money(all), '100.0%'])],
      },
      heading('Every expense', undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        caption,
        columns: [
          { key: 'date', label: 'Paid', width: 1.6 },
          { key: 'vendor', label: 'Vendor', width: 2.2 },
          { key: 'cat', label: 'Category', width: 2 },
          { key: 'source', label: 'Paid from', width: 1.8 },
          { key: 'ref', label: 'Reference', width: 1.6 },
          { key: 'notes', label: 'Notes', width: 2.4 },
          { key: 'amt', label: 'Amount', numeric: true, width: 1.8 },
        ],
        rows: [
          ...rows.map((e) => ({
            cells: [
              shortDate(e.paid_at),
              orDash(e.vendor),
              e.expense_category_name ?? 'Untagged',
              // Owner-paid rows are meaningless without the owner's name.
              e.owner_name
                ? `${paidFromLabel(e.paid_from)} (${e.owner_name})`
                : paidFromLabel(e.paid_from),
              orDash(e.reference_no),
              orDash(e.notes),
              money(e.amount_cents),
            ],
          })),
          ...(bounded
            ? [
                totalRow([
                  `Total of the ${count(rows.length)} rows shown`,
                  '',
                  '',
                  '',
                  '',
                  '',
                  money(shown),
                ]),
                totalRow([
                  `Total across all ${count(d.rows.length)} expenses`,
                  '',
                  '',
                  '',
                  '',
                  '',
                  money(all),
                ]),
              ]
            : [totalRow(['Total', '', '', '', '', '', money(all)])]),
        ],
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// Cafe balance + per-account breakdown
// ---------------------------------------------------------------------------

type BalanceData = { balance: CafeBalance; accounts: { accounts: AccountBalance[] } };

export const moneyBalances = defineSection<BalanceData>({
  id: 'money.balances',
  group: 'Money',
  label: 'Cafe balance',
  description: 'Current cash drawer, bank, online and owner-held cash. Point in time.',
  perm: 'account:read',
  // Balances are a snapshot: they are whatever they are right now, regardless of
  // the reporting period. Presenting them under a date range would misread as
  // "the balance during that period".
  needsRange: false,
  defaultDetail: 'full',
  detailLevels: ['full'],
  explainerIds: ['cafe-balance', 'account-balance'],
  load: async (ctx) => ({
    balance: await get<CafeBalance>(ctx, '/v1/finance/cafe-balance'),
    accounts: await get<{ accounts: AccountBalance[] }>(ctx, '/v1/accounts/balances'),
  }),
  rowCount: (d) => d.accounts.accounts.length,
  render: (d) => {
    const b = d.balance;
    const drawerNote =
      b.drawer_source === 'live'
        ? 'from the open shift'
        : b.drawer_source === 'last_close'
          ? `counted at the last close${b.drawer_as_of ? ` (${shortDate(b.drawer_as_of)})` : ''}`
          : 'no shift recorded';

    return [
      heading('Cafe balance', 'Position as at the moment this report was generated'),
      note(
        'These are current balances, not period figures — they are unaffected by the ' +
          'reporting period stated on the cover.',
      ),
      {
        kind: 'kpis',
        cells: [
          { label: 'Cash drawer', value: money(b.drawer_cents), note: drawerNote },
          { label: 'Bank', value: money(b.bank_cents) },
          {
            label: 'Held by owners',
            value: money(b.owner_cash_cents),
            note: 'cafe cash outside the drawer',
            tone: b.owner_cash_cents > 0 ? 'warn' : undefined,
          },
          { label: 'Total', value: money(b.total_cents) },
        ],
      },
      heading('By account', undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        caption:
          'Sales and credit collected are listed separately: credit collected is money ' +
          'received against serves billed earlier, so it is not sales.',
        columns: [
          { key: 'acct', label: 'Account', width: 2 },
          { key: 'sales', label: 'Sales in', numeric: true, width: 1.8 },
          { key: 'credit', label: 'Credit collected', numeric: true, width: 1.8 },
          { key: 'exp', label: 'Expenses out', numeric: true, width: 1.8 },
          { key: 'tin', label: 'Transfers in', numeric: true, width: 1.6 },
          { key: 'tout', label: 'Transfers out', numeric: true, width: 1.6 },
          { key: 'other', label: 'Other', numeric: true, width: 1.4 },
          { key: 'bal', label: 'Balance', numeric: true, width: 1.8 },
        ],
        rows: d.accounts.accounts.map((a) => ({
          cells: [
            a.label,
            money(a.payments_cents, { zeroDash: true }),
            money(a.credit_collected_cents ?? 0, { zeroDash: true }),
            money(a.expenses_cents, { zeroDash: true }),
            money(a.transfers_in_cents, { zeroDash: true }),
            money(a.transfers_out_cents, { zeroDash: true }),
            signedMoney(a.other_movements_cents ?? 0),
            money(a.balance_cents),
          ],
        })),
      },
      ...(b.owner_outstanding.loans_cents > 0
        ? [
            note(
              `${money(b.owner_outstanding.loans_cents)} is outstanding to owners for cash they ` +
                `advanced to the cafe. That is a liability and is not deducted from the balances above.`,
            ),
          ]
        : []),
    ];
  },
});

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

export const moneyTransfers = defineSection<{ transfers: AccountTransfer[] }>({
  id: 'money.transfers',
  group: 'Money',
  label: 'Account transfers',
  description: 'Money moved between drawer, bank and online, with any charges.',
  perm: 'account:read',
  needsRange: false,
  explainerIds: ['transfer-fee'],
  defaultDetail: 'full',
  detailLevels: ['topN', 'full'],
  load: (ctx) => get<{ transfers: AccountTransfer[] }>(ctx, '/v1/transfers'),
  rowCount: (d) => d.transfers.length,
  render: (d, opts) => {
    const { rows, caption } = boundRows(d.transfers, opts, {
      total: d.transfers.length,
      orderedBy: 'date (most recent first)',
      emptyText: 'No transfers have been recorded.',
    });
    const feeTotal = d.transfers.reduce((n, t) => n + t.fee_cents, 0);
    return [
      heading('Account transfers'),
      {
        kind: 'table',
        repeatHeader: true,
        caption,
        columns: [
          { key: 'when', label: 'Date', width: 1.8 },
          { key: 'from', label: 'From', width: 1.4 },
          { key: 'to', label: 'To', width: 1.4 },
          { key: 'amt', label: 'Amount', numeric: true, width: 1.8 },
          { key: 'fee', label: 'Charge', numeric: true, width: 1.4 },
          { key: 'ref', label: 'Reference', width: 1.6 },
          { key: 'notes', label: 'Notes', width: 2.2 },
        ],
        rows: [
          ...rows.map((t) => ({
            cells: [
              shortDate(t.transferred_at),
              titleCase(t.from_method),
              titleCase(t.to_method),
              money(t.amount_cents),
              money(t.fee_cents, { zeroDash: true }),
              orDash(t.reference_no),
              orDash(t.notes),
            ],
          })),
          ...(feeTotal > 0
            ? [totalRow(['Total charges', '', '', '', money(feeTotal), '', ''])]
            : []),
        ],
      },
      ...(feeTotal > 0
        ? [
            note(
              'Transfer charges are money out that never appears in the expense register, ' +
                'so they are deducted separately when net profit is calculated.',
            ),
          ]
        : []),
    ];
  },
});

// ---------------------------------------------------------------------------
// Owner equity
// ---------------------------------------------------------------------------

type OwnerData = { owners: CafeOwner[]; summary: CafeSummary };

export const moneyOwnerEquity = defineSection<OwnerData>({
  id: 'money.owner_equity',
  group: 'Money',
  label: 'Owners and equity',
  description: 'Ownership shares, lifetime investment, payouts and outstanding loans.',
  perm: 'finance:read',
  feature: 'owner_finance',
  needsRange: false,
  explainerIds: ['outstanding-loans'],
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: async (ctx) => ({
    // No ?active=true — a report of ownership has to include owners who have
    // since left, or the historical investment figures won't add up.
    owners: (await get<{ owners: CafeOwner[] }>(ctx, '/v1/finance/owners')).owners,
    summary: await get<CafeSummary>(ctx, '/v1/finance/cafe-summary'),
  }),
  rowCount: (d) => d.owners.length,
  render: (d) => {
    const s = d.summary;
    const totalUnits = d.owners.reduce((n, o) => n + (o.active_to ? 0 : o.share_units), 0) || 1;
    return [
      heading('Owners and equity', 'Lifetime figures, not period figures'),
      {
        kind: 'kpis',
        cells: [
          { label: 'Invested to date', value: money(s.lifetime_invested_cents) },
          { label: 'Paid out to date', value: money(s.lifetime_payouts_cents) },
          {
            label: 'Owed to owners',
            value: money(s.outstanding_loans_cents),
            tone: s.outstanding_loans_cents > 0 ? 'warn' : undefined,
          },
          {
            label: 'Net profit to date',
            value: money(s.cafe_net_profit_cents),
            tone: s.cafe_net_profit_cents >= 0 ? 'good' : 'bad',
          },
        ],
      },
      {
        kind: 'table',
        repeatHeader: true,
        columns: [
          { key: 'name', label: 'Owner', width: 2.6 },
          { key: 'share', label: 'Share', numeric: true, width: 1.2 },
          { key: 'inv', label: 'Invested', numeric: true, width: 1.8 },
          { key: 'out', label: 'Paid out', numeric: true, width: 1.8 },
          { key: 'loan', label: 'Owed to them', numeric: true, width: 1.8 },
          { key: 'since', label: 'Since', width: 1.6 },
        ],
        rows: [
          ...d.owners.map((o) => ({
            cells: [
              o.active_to ? `${o.display_name} (inactive)` : o.display_name,
              o.active_to ? '—' : pct((o.share_units / totalUnits) * 100),
              money(o.lifetime_investment_cents),
              money(o.lifetime_payouts_cents, { zeroDash: true }),
              money(o.outstanding_loans_cents, { zeroDash: true }),
              shortDate(o.active_from),
            ],
            muted: !!o.active_to,
          })),
          totalRow([
            'Total',
            '100.0%',
            money(s.lifetime_invested_cents),
            money(s.lifetime_payouts_cents),
            money(s.outstanding_loans_cents),
            '',
          ]),
        ],
      },
      note(
        'Investment is owner capital put into the cafe; a payout is profit taken out. ' +
          'Money an owner advanced on the cafe’s behalf is a loan and is listed as owed ' +
          'to them rather than as investment.',
      ),
    ];
  },
});

// ---------------------------------------------------------------------------
// Owner ledger
// ---------------------------------------------------------------------------

export const moneyOwnerLedger = defineSection<{ entries: OwnerLedgerEntry[] }>({
  id: 'money.owner_ledger',
  group: 'Money',
  label: 'Owner ledger',
  description: 'Every investment, payout, loan and repayment, in order.',
  perm: 'finance:read',
  feature: 'owner_finance',
  needsRange: false,
  defaultDetail: 'full',
  detailLevels: ['topN', 'full'],
  load: (ctx) => get<{ entries: OwnerLedgerEntry[] }>(ctx, '/v1/finance/owner-ledger'),
  rowCount: (d) => d.entries.length,
  render: (d, opts) => {
    const { rows, caption } = boundRows(d.entries, opts, {
      total: d.entries.length,
      orderedBy: 'date (most recent first)',
      emptyText: 'No owner ledger entries have been recorded.',
    });
    return [
      heading('Owner ledger'),
      {
        kind: 'table',
        repeatHeader: true,
        caption,
        columns: [
          { key: 'when', label: 'Date', width: 1.6 },
          { key: 'owner', label: 'Owner', width: 2 },
          { key: 'kind', label: 'Type', width: 1.8 },
          { key: 'amt', label: 'Amount', numeric: true, width: 1.8 },
          { key: 'repaid', label: 'Repaid', numeric: true, width: 1.4 },
          { key: 'notes', label: 'Notes', width: 2.6 },
        ],
        rows: rows.map((e) => ({
          cells: [
            shortDate(e.occurred_at),
            e.owner_name,
            titleCase(e.kind),
            money(e.amount_cents),
            e.kind === 'loan_advance' ? money(e.repaid_cents, { zeroDash: true }) : '—',
            // A correction row alongside the row it corrects is confusing unless
            // it says which it is.
            e.is_correction ? `Correction. ${orDash(e.notes)}` : orDash(e.notes),
          ],
          muted: e.is_correction,
        })),
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// Owner-held cash
// ---------------------------------------------------------------------------

export const moneyOwnerCash = defineSection<OwnerCashResponse>({
  id: 'money.owner_cash',
  group: 'Money',
  label: 'Cash held by owners',
  description: 'Cafe cash taken from the drawer by an owner and not yet reconciled.',
  perm: 'finance:owner_cash',
  feature: 'owner_finance',
  needsRange: false,
  explainerIds: ['owner-cash'],
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => get<OwnerCashResponse>(ctx, '/v1/finance/owner-cash'),
  rowCount: (d) => d.holdings.length + d.entries.length,
  render: (d) => {
    const held = d.holdings.reduce((n, h) => n + h.holding_cents, 0);
    return [
      heading('Cash held by owners'),
      note(
        'This is cafe money, not owner money — cash taken out of the drawer that has not ' +
          'yet been spent on the cafe, banked, or returned. It is still part of the cafe balance.',
      ),
      {
        kind: 'table',
        repeatHeader: true,
        caption: d.holdings.length === 0 ? 'No owner is currently holding cafe cash.' : undefined,
        columns: [
          { key: 'owner', label: 'Owner', width: 3 },
          { key: 'held', label: 'Currently holding', numeric: true, width: 2 },
        ],
        rows: [
          ...d.holdings.map((h) => ({
            cells: [
              h.active ? h.display_name : `${h.display_name} (inactive)`,
              money(h.holding_cents),
            ],
            muted: !h.active,
          })),
          ...(d.holdings.length > 0 ? [totalRow(['Total held', money(held)])] : []),
        ],
      },
      heading('Movements', undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        caption: d.entries.length === 0 ? 'No movements recorded.' : undefined,
        columns: [
          { key: 'when', label: 'Date', width: 1.6 },
          { key: 'owner', label: 'Owner', width: 2 },
          { key: 'kind', label: 'Movement', width: 2 },
          { key: 'amt', label: 'Amount', numeric: true, width: 1.8 },
          { key: 'notes', label: 'Notes / vendor', width: 2.6 },
        ],
        rows: d.entries.map((e) => ({
          cells: [
            shortDate(e.occurred_at),
            e.owner_name,
            titleCase(e.kind),
            money(e.amount_cents),
            orDash(e.expense_vendor ?? e.notes),
          ],
        })),
      },
    ];
  },
});

// ---------------------------------------------------------------------------
// Credit accounts (house tabs)
// ---------------------------------------------------------------------------

type CreditData = { tabs: HouseTab[]; statements: HouseTabDetail[] };

export const moneyCredit = defineSection<CreditData>({
  id: 'money.credit',
  group: 'Money',
  label: 'Credit accounts',
  description: 'Outstanding customer credit balances, with a statement for each.',
  perm: 'house_tab:read',
  feature: 'house_tabs',
  needsRange: false,
  explainerIds: ['credit-collected'],
  defaultDetail: 'summary',
  detailLevels: ['summary', 'full'],
  load: async (ctx) => {
    const tabs = (await get<{ house_tabs: HouseTab[] }>(ctx, '/v1/house-tabs')).house_tabs;
    // Statements are only fetched for accounts that still owe something —
    // printing a full history for every settled account would bury the ones
    // that need chasing.
    const owing = tabs.filter((t) => t.balance_cents !== 0);
    const statements = await Promise.all(
      owing.map((t) => get<HouseTabDetail>(ctx, `/v1/house-tabs/${t.id}`)),
    );
    return { tabs, statements };
  },
  rowCount: (d) => d.tabs.length,
  render: (d, opts) => {
    const outstanding = d.tabs.reduce((n, t) => n + t.balance_cents, 0);
    const active = d.tabs.filter((t) => !t.archived_at);

    const blocks: ReportBlock[] = [
      heading('Credit accounts'),
      {
        kind: 'kpis',
        cells: [
          {
            label: 'Total outstanding',
            value: money(outstanding),
            tone: outstanding > 0 ? 'warn' : 'good',
          },
          { label: 'Accounts', value: count(active.length) },
          {
            label: 'With a balance',
            value: count(d.tabs.filter((t) => t.balance_cents !== 0).length),
          },
        ],
      },
      {
        kind: 'table',
        repeatHeader: true,
        caption: d.tabs.length === 0 ? 'No credit accounts exist.' : undefined,
        columns: [
          { key: 'name', label: 'Account', width: 2.6 },
          { key: 'phone', label: 'Phone', width: 1.8 },
          { key: 'charged', label: 'Charged', numeric: true, width: 1.8 },
          { key: 'collected', label: 'Collected', numeric: true, width: 1.8 },
          { key: 'bal', label: 'Outstanding', numeric: true, width: 1.8 },
        ],
        rows: [
          ...d.tabs.map((t) => ({
            cells: [
              t.archived_at ? `${t.name} (archived)` : t.name,
              orDash(t.contact_phone),
              money(t.charged_cents),
              money(t.settled_cents, { zeroDash: true }),
              money(t.balance_cents, { zeroDash: true }),
            ],
            muted: !!t.archived_at,
          })),
          totalRow([
            'Total outstanding',
            '',
            money(d.tabs.reduce((n, t) => n + t.charged_cents, 0)),
            money(d.tabs.reduce((n, t) => n + t.settled_cents, 0)),
            money(outstanding),
          ]),
        ],
      },
      note(
        'Charged is what has been billed to the account; collected is money since ' +
          'received against it. Collections pay down serves billed earlier, so they are ' +
          'never counted as new sales.',
      ),
    ];

    if (opts.detail === 'full' && d.statements.length > 0) {
      d.statements.forEach((st) => {
        blocks.push({ kind: 'pagebreak' });
        blocks.push(heading(st.house_tab.name, 'Credit account statement', 2));
        blocks.push({
          kind: 'rows',
          rows: [
            { label: 'Charged to the account', value: money(st.house_tab.charged_cents) },
            { label: 'Collected against it', value: money(st.house_tab.settled_cents) },
            { label: 'Outstanding', value: money(st.house_tab.balance_cents), total: true },
          ],
        });
        blocks.push({
          kind: 'table',
          repeatHeader: true,
          caption: st.charges.length === 0 ? 'No charges on this account.' : 'Charges',
          columns: [
            { key: 'when', label: 'Date', width: 1.8 },
            { key: 'table', label: 'Table', width: 2 },
            { key: 'ref', label: 'Reference', width: 2 },
            { key: 'amt', label: 'Amount', numeric: true, width: 1.8 },
          ],
          rows: st.charges.map((c) => ({
            cells: [
              shortDate(c.recorded_at),
              c.is_opening_balance ? 'Opening balance' : orDash(c.service_table_name),
              orDash(c.reference_no),
              money(c.amount_cents),
            ],
          })),
        });
        blocks.push({
          kind: 'table',
          repeatHeader: true,
          caption: st.settlements.length === 0 ? 'Nothing collected yet.' : 'Credit collected',
          columns: [
            { key: 'when', label: 'Date', width: 1.8 },
            { key: 'method', label: 'Method', width: 1.6 },
            { key: 'ref', label: 'Reference', width: 1.8 },
            { key: 'notes', label: 'Notes', width: 2.2 },
            { key: 'amt', label: 'Amount', numeric: true, width: 1.8 },
          ],
          rows: st.settlements.map((s) => ({
            cells: [
              dateTime(s.recorded_at),
              titleCase(s.payment_method),
              orDash(s.reference_no),
              // A reversed collection stays in the ledger for the audit trail but
              // counts toward nothing — it has to be visibly marked.
              s.reversed_at
                ? `REVERSED ${shortDate(s.reversed_at)}. ${orDash(s.reversal_reason)}`
                : orDash(s.notes),
              money(s.amount_cents),
            ],
            muted: !!s.reversed_at,
          })),
        });
      });
    }

    return blocks;
  },
});

export const MONEY_SECTIONS = [
  moneyExpenses,
  moneyBalances,
  moneyTransfers,
  moneyOwnerEquity,
  moneyOwnerLedger,
  moneyOwnerCash,
  moneyCredit,
];
