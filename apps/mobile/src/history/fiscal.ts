/**
 * Pure helpers for the History screen's IRD invoice panel and correction
 * sheet. Kept out of the components so they are unit-tested directly.
 */
import type { StampTone } from '@cafe-mgmt/design-tokens';
import type { CreditNote, InvoiceView } from '@cafe-mgmt/api-types';

/** Where an invoice stands with IRD's CBMS, in the cashier's words. A mock
 *  sync is never presented as reported — it reached the stand-in, not IRD. */
export function cbmsStatus(v: Pick<InvoiceView, 'cbms'>): { label: string; tone: StampTone } {
  const c = v.cbms;
  if (c?.status === 'synced') {
    return c.synced_via === 'live'
      ? { label: 'Reported to IRD', tone: 'success' }
      : { label: 'Demo sync only', tone: 'neutral' };
  }
  if (c?.status === 'failed') return { label: 'IRD reporting failed', tone: 'danger' };
  return { label: 'Not yet reported to IRD', tone: 'warn' };
}

/** Same Nepal (UTC+05:45) calendar day as the bill. Only decides which
 *  correction to offer first; the server refuses a stale reversal regardless. */
export function issuedTodayNepal(issuedAt: string, now: Date = new Date()): boolean {
  const npDay = (d: Date) => new Date(d.getTime() + (5 * 60 + 45) * 60_000).toISOString().slice(0, 10);
  return npDay(new Date(issuedAt)) === npDay(now);
}

/** Quantity of each invoice line already credited by earlier notes. */
export function returnedByLine(notes: CreditNote[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const cn of notes) {
    for (const l of cn.lines) m.set(l.invoice_line_no, (m.get(l.invoice_line_no) ?? 0) + Number(l.qty));
  }
  return m;
}
