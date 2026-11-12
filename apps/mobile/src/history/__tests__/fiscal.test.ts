import { defaultRefundMethod, type CreditNote } from '@cafe-mgmt/api-types';
import { cbmsStatus, issuedTodayNepal, returnedByLine } from '../fiscal';

describe('cbmsStatus', () => {
  it('only calls a live sync "reported"', () => {
    expect(cbmsStatus({ cbms: { status: 'synced', attempts: 1, synced_via: 'live' } }).label).toBe('Reported to IRD');
    expect(cbmsStatus({ cbms: { status: 'synced', attempts: 1, synced_via: 'mock' } }).label).toBe('Demo sync only');
  });
  it('flags failures and the not-yet case', () => {
    expect(cbmsStatus({ cbms: { status: 'failed', attempts: 5 } }).tone).toBe('danger');
    expect(cbmsStatus({ cbms: { status: 'pending', attempts: 0 } }).label).toBe('Not yet reported to IRD');
    expect(cbmsStatus({}).label).toBe('Not yet reported to IRD');
  });
});

describe('issuedTodayNepal', () => {
  it('uses the Nepal calendar day, not the phone zone', () => {
    // 18:00 UTC = 23:45 NPT on the 7th; 18:20 UTC = 00:05 NPT on the 8th.
    expect(issuedTodayNepal('2026-11-07T18:00:00Z', new Date('2026-11-07T18:10:00Z'))).toBe(true);
    expect(issuedTodayNepal('2026-11-07T18:00:00Z', new Date('2026-11-07T18:20:00Z'))).toBe(false);
  });
});

describe('returnedByLine', () => {
  it('sums earlier returns per invoice line', () => {
    const line = (invoice_line_no: number, qty: string) => ({
      line_no: 1, invoice_line_no, description: '', qty, unit_price_cents: 0, amount_cents: 0,
    });
    const notes = [
      { lines: [line(1, '1.00'), line(2, '0.50')] },
      { lines: [line(1, '1.00')] },
    ] as unknown as CreditNote[];
    const m = returnedByLine(notes);
    expect(m.get(1)).toBe(2);
    expect(m.get(2)).toBe(0.5);
    expect(m.get(3)).toBeUndefined();
  });
});

describe('defaultRefundMethod', () => {
  it('sends the money back the way it came', () => {
    expect(defaultRefundMethod('Cash')).toBe('cash');
    expect(defaultRefundMethod('Other')).toBe('online');
    expect(defaultRefundMethod('Credit')).toBe('credit');
    expect(defaultRefundMethod('Cash, Other')).toBe('cash');
    expect(defaultRefundMethod('Cash, Credit')).toBe('credit');
  });
});
