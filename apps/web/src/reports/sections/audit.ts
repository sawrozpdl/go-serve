// Audit section — the activity log.
//
// The log is keyset-paged (base64 cursor), not offset-paged, so it walks with
// cursorAll. It can be enormous: a busy workspace writes thousands of rows a
// month and the hard cap will trip regularly. That is fine as long as the
// document says so, which boundRows guarantees.

import { request } from '@/lib/api';
import type { AuditEvent } from '@cafe-mgmt/api-types';

import { count, dateTime, orDash, titleCase } from '../format';
import { resolveWindowDays } from '../window';
import { boundRows, cursorAll, defineSection, heading, note } from '../section';

type AuditPage = { items: AuditEvent[]; next_cursor: string | null };
type AuditData = { rows: AuditEvent[]; total: number; truncated: boolean };

export const auditActivity = defineSection<AuditData>({
  id: 'audit.activity',
  group: 'Audit',
  label: 'Activity log',
  description: 'Who changed what, and when. Can be very long.',
  perm: 'audit:read',
  feature: 'audit_logs',
  needsRange: true,
  prefersLandscape: true,
  defaultDetail: 'topN',
  detailLevels: ['topN', 'full'],
  load: async (ctx) => {
    // The audit endpoint drops the filter entirely when from/to are absent, so
    // a preset must be resolved to days before it is queried.
    const w = await resolveWindowDays(ctx);
    const paged = await cursorAll<AuditEvent>(
      async (cursor) => {
        const p = new URLSearchParams();
        // The audit endpoint windows on full timestamps, not whole days — the
        // one place in the app that differs. Widen each end to the whole local
        // day so the window matches every other section in the document.
        p.set('from', `${w.from}T00:00:00`);
        p.set('to', `${w.to}T23:59:59`);
        p.set('limit', '200');
        if (cursor) p.set('cursor', cursor);
        const r = await request<AuditPage>('GET', `/v1/audit?${p}`, { tenantSlug: ctx.slug });
        return { rows: r.items, nextCursor: r.next_cursor };
      },
      { hardCap: 5000 },
    );
    return { rows: paged.rows, total: paged.total, truncated: paged.truncated };
  },
  rowCount: (d) => d.total,
  render: (d, opts) => {
    const { rows, caption } = boundRows(d.rows, opts, {
      total: d.total,
      truncated: d.truncated,
      orderedBy: 'time (most recent first)',
      emptyText: 'No recorded activity in this period.',
    });
    return [
      heading('Activity log'),
      {
        kind: 'table',
        repeatHeader: true,
        caption,
        columns: [
          { key: 'when', label: 'When', width: 2 },
          { key: 'who', label: 'Who', width: 2.4 },
          { key: 'action', label: 'Action', width: 1.4 },
          { key: 'entity', label: 'On', width: 1.6 },
          { key: 'summary', label: 'What changed', width: 4 },
        ],
        rows: rows.map((e) => ({
          cells: [
            dateTime(e.created_at),
            // actor_name can be blank for system-initiated writes; the email is
            // the reliable identifier.
            orDash(e.actor_name || e.actor_email),
            titleCase(e.action),
            titleCase(e.entity),
            orDash(e.summary),
          ],
        })),
      },
      note(
        `${count(d.total)} entries were retrieved for this period. The activity log records ` +
          `changes, not reads — viewing a screen leaves no entry.`,
      ),
    ];
  },
});

export const AUDIT_SECTIONS = [auditActivity];
