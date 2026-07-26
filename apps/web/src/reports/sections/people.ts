// People sections — staff roster, salary register, workspace access.
//
// Staff records hold personal data. The roster prints the employment facts a
// manager needs (role, status, dates, salary terms) and deliberately stops
// there: personal documents live behind a permission-gated proxy and never
// belong in a document that gets emailed around. Phone is included because a
// roster without contact details isn't a roster; nothing more identifying is.

import { request } from '@/lib/api';
import type { Member, Role, Staff, StaffPay } from '@cafe-mgmt/api-types';

import { count, formatNPR, orDash, shortDate, titleCase } from '../format';
import { resolveWindowDays } from '../window';
import { boundRows, defineSection, heading, note, totalRow, type LoadCtx } from '../section';

function get<T>(ctx: LoadCtx, path: string): Promise<T> {
  return request<T>('GET', path, { tenantSlug: ctx.slug });
}

/** Salary and pay amounts are numeric RUPEES, not paisa (see components/Money). */
function rupees(amount: number | null | undefined): string {
  return formatNPR(Math.round((amount ?? 0) * 100));
}

// ---------------------------------------------------------------------------
// Staff roster
// ---------------------------------------------------------------------------

export const peopleStaff = defineSection<{ staff: Staff[] }>({
  id: 'people.staff',
  group: 'People',
  label: 'Staff roster',
  description: 'Everyone on the books, with role, status and salary terms.',
  perm: 'staff:read',
  feature: 'staff_hr',
  needsRange: false,
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: (ctx) => get<{ staff: Staff[] }>(ctx, '/v1/staff'),
  rowCount: (d) => d.staff.length,
  render: (d) => {
    const active = d.staff.filter((s) => s.status === 'active');
    // Monthly-equivalent payroll is only meaningful for staff on a monthly
    // cadence; mixing cadences into one figure would be arithmetic nonsense.
    const monthly = active.filter((s) => s.salary_cadence === 'monthly');
    const monthlyTotal = monthly.reduce((n, s) => n + (s.salary_amount ?? 0), 0);

    return [
      heading('Staff roster', 'Current as at the moment this report was generated'),
      {
        kind: 'kpis',
        cells: [
          { label: 'Active staff', value: count(active.length) },
          { label: 'On the books', value: count(d.staff.length) },
          {
            label: 'Monthly salaries',
            value: rupees(monthlyTotal),
            note: `${count(monthly.length)} on a monthly wage`,
          },
        ],
      },
      {
        kind: 'table',
        repeatHeader: true,
        caption: d.staff.length === 0 ? 'No staff records exist.' : undefined,
        columns: [
          { key: 'name', label: 'Name', width: 2.6 },
          { key: 'role', label: 'Role', width: 2 },
          { key: 'phone', label: 'Phone', width: 1.8 },
          { key: 'status', label: 'Status', width: 1.2 },
          { key: 'from', label: 'Started', width: 1.5 },
          { key: 'to', label: 'Ended', width: 1.5 },
          { key: 'salary', label: 'Salary', numeric: true, width: 1.6 },
          { key: 'cadence', label: 'Per', width: 1.2 },
        ],
        rows: d.staff.map((s) => ({
          cells: [
            s.full_name,
            orDash(s.role_title),
            orDash(s.phone),
            titleCase(s.status),
            s.started_on ? shortDate(s.started_on) : '—',
            s.ended_on ? shortDate(s.ended_on) : '—',
            s.salary_amount ? rupees(s.salary_amount) : '—',
            s.salary_amount ? titleCase(s.salary_cadence) : '—',
          ],
          muted: s.status !== 'active',
        })),
      },
      note(
        'Personal documents held against a staff record are not included in this ' +
          'report. Salary figures are the agreed terms, not amounts actually paid — ' +
          'see the salary register for those.',
      ),
    ];
  },
});

// ---------------------------------------------------------------------------
// Salary register
// ---------------------------------------------------------------------------

type PayRow = StaffPay & { staffName: string; roleTitle: string };
type PayData = { rows: PayRow[]; from?: string; to?: string };

export const peoplePay = defineSection<PayData>({
  id: 'people.pay',
  group: 'People',
  label: 'Salary register',
  description: 'Salary payments actually made, per person, over the period.',
  // Matches the endpoint: GET /v1/staff/{id}/pay is gated on staff:read.
  perm: 'staff:read',
  feature: 'staff_hr',
  needsRange: true,
  defaultDetail: 'full',
  detailLevels: ['topN', 'full'],
  load: async (ctx) => {
    const staff = (await get<{ staff: Staff[] }>(ctx, '/v1/staff')).staff;
    // Pay rows carry no date filter on the API, so the window is applied here —
    // which means it has to be real days, not an unresolved preset.
    const w = await resolveWindowDays(ctx);
    // Pay is per-staff on the API and carries no date filter, so fetch each
    // person's history and window it here.
    const all = await Promise.all(
      staff.map(async (s) => {
        const pay = (await get<{ pay: StaffPay[] }>(ctx, `/v1/staff/${s.id}/pay`)).pay ?? [];
        return pay.map((p) => ({ ...p, staffName: s.full_name, roleTitle: s.role_title }));
      }),
    );
    const rows = all
      .flat()
      .filter((p) => p.paid_on >= w.from && p.paid_on <= w.to)
      .sort((a, b) => (a.paid_on < b.paid_on ? 1 : a.paid_on > b.paid_on ? -1 : 0));
    return { rows, from: w.from, to: w.to };
  },
  rowCount: (d) => d.rows.length,
  render: (d, opts) => {
    const { rows, caption } = boundRows(d.rows, opts, {
      total: d.rows.length,
      orderedBy: 'date paid (most recent first)',
      emptyText: 'No salary payments were made in this period.',
    });
    const total = d.rows.reduce((n, p) => n + p.amount, 0);

    // Per-person subtotals are what makes this a register rather than a list.
    const byPerson = new Map<string, number>();
    for (const p of d.rows) byPerson.set(p.staffName, (byPerson.get(p.staffName) ?? 0) + p.amount);

    return [
      heading('Salary register'),
      heading('By person', undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        caption: `Totals cover all ${count(d.rows.length)} payments in the period.`,
        columns: [
          { key: 'name', label: 'Name', width: 3 },
          { key: 'amt', label: 'Paid in period', numeric: true, width: 2 },
        ],
        rows: [
          ...[...byPerson.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([name, amt]) => ({ cells: [name, rupees(amt)] })),
          totalRow(['Total', rupees(total)]),
        ],
      },
      heading('Every payment', undefined, 2),
      {
        kind: 'table',
        repeatHeader: true,
        caption,
        columns: [
          { key: 'when', label: 'Paid on', width: 1.6 },
          { key: 'name', label: 'Name', width: 2.4 },
          { key: 'role', label: 'Role', width: 1.8 },
          { key: 'period', label: 'For period', width: 2 },
          { key: 'note', label: 'Note', width: 2.2 },
          { key: 'amt', label: 'Amount', numeric: true, width: 1.8 },
        ],
        rows: rows.map((p) => ({
          cells: [
            shortDate(p.paid_on),
            p.staffName,
            orDash(p.roleTitle),
            orDash(p.period_label),
            orDash(p.note),
            rupees(p.amount),
          ],
        })),
      },
      note(
        'Each salary payment also books a matching expense, so these amounts are ' +
          'already inside the expense register and the net profit figure.',
      ),
    ];
  },
});

// ---------------------------------------------------------------------------
// Workspace access
// ---------------------------------------------------------------------------

type AccessData = { members: Member[]; roles: Role[] };

export const peopleAccess = defineSection<AccessData>({
  id: 'people.access',
  group: 'People',
  label: 'Workspace access',
  description: 'Who can sign in, and which roles grant what.',
  perm: 'member:read',
  needsRange: false,
  defaultDetail: 'full',
  detailLevels: ['full'],
  load: async (ctx) => ({
    members: (await get<{ members: Member[] }>(ctx, '/v1/members')).members,
    roles: (await get<{ roles: Role[] }>(ctx, '/v1/roles')).roles,
  }),
  rowCount: (d) => d.members.length + d.roles.length,
  render: (d) => [
    heading('Workspace access', 'Current as at the moment this report was generated'),
    heading('People with access', undefined, 2),
    {
      kind: 'table',
      repeatHeader: true,
      caption: d.members.length === 0 ? 'No members.' : undefined,
      columns: [
        { key: 'name', label: 'Name', width: 2.4 },
        { key: 'email', label: 'Email', width: 3 },
        { key: 'roles', label: 'Roles', width: 3 },
      ],
      rows: d.members.map((m) => ({
        cells: [orDash(m.name), m.email, m.roles.length ? m.roles.join(', ') : '— no role —'],
        // A member with no role can sign in but do nothing; worth standing out.
        muted: m.roles.length === 0,
      })),
    },
    heading('Roles', undefined, 2),
    {
      kind: 'table',
      repeatHeader: true,
      columns: [
        { key: 'name', label: 'Role', width: 2 },
        { key: 'kind', label: 'Kind', width: 1.4 },
        { key: 'perms', label: 'Permissions granted', numeric: true, width: 1.6 },
      ],
      rows: d.roles.map((r) => ({
        cells: [
          r.name,
          r.is_system ? 'Built-in' : 'Custom',
          r.permissions.includes('*:*') ? 'all' : count(r.permissions.length),
        ],
      })),
    },
  ],
});

export const PEOPLE_SECTIONS = [peopleStaff, peoplePay, peopleAccess];
