import type { PrinterConn, TenantPreferences } from '@cafe-mgmt/api-types';
import { kitchenTargets, receiptTargets } from '../printerConfig';

const conn = (over: Partial<PrinterConn>): PrinterConn => ({
  id: over.id ?? 'p1',
  label: over.label,
  type: over.type ?? 'network',
  ip: over.ip ?? '192.168.1.50',
  port: over.port ?? 9100,
  width: over.width ?? '80',
});

describe('kitchenTargets', () => {
  it('maps configured network printers to targets', () => {
    const prefs = { kitchenPrinters: [conn({ ip: '10.0.0.2', port: 9100, width: '58' })] } as TenantPreferences;
    expect(kitchenTargets(prefs)).toEqual([{ ip: '10.0.0.2', port: 9100, width: '58' }]);
  });

  it('drops entries with no ip and trims whitespace', () => {
    const prefs = {
      kitchenPrinters: [conn({ ip: '  ' }), conn({ id: 'p2', ip: ' 10.0.0.9 ' })],
    } as TenantPreferences;
    expect(kitchenTargets(prefs)).toEqual([{ ip: '10.0.0.9', port: 9100, width: '80' }]);
  });

  it('defaults a missing/zero port to 9100', () => {
    const prefs = { kitchenPrinters: [conn({ port: 0 })] } as TenantPreferences;
    expect(kitchenTargets(prefs)[0].port).toBe(9100);
  });

  it('is empty when unset', () => {
    expect(kitchenTargets(undefined)).toEqual([]);
    expect(kitchenTargets({} as TenantPreferences)).toEqual([]);
  });
});

describe('receiptTargets', () => {
  it('uses the dedicated receipt list by default', () => {
    const prefs = {
      kitchenPrinters: [conn({ ip: '10.0.0.2' })],
      receiptPrinters: [conn({ id: 'r1', ip: '10.0.0.3' })],
    } as TenantPreferences;
    expect(receiptTargets(prefs)).toEqual([{ ip: '10.0.0.3', port: 9100, width: '80' }]);
  });

  it('falls back to the kitchen printers when "same as kitchen" is on', () => {
    const prefs = {
      receiptSameAsKitchen: true,
      kitchenPrinters: [conn({ ip: '10.0.0.2' })],
      receiptPrinters: [conn({ id: 'r1', ip: '10.0.0.3' })],
    } as TenantPreferences;
    expect(receiptTargets(prefs)).toEqual([{ ip: '10.0.0.2', port: 9100, width: '80' }]);
  });
});
