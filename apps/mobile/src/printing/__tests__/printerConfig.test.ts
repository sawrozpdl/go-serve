import type { Outlet, PrinterConn, TenantPreferences } from '@cafe-mgmt/api-types';
import { outletTarget, receiptTargets } from '../printerConfig';

const conn = (over: Partial<PrinterConn>): PrinterConn => ({
  id: over.id ?? 'p1',
  label: over.label,
  type: over.type ?? 'network',
  ip: over.ip ?? '192.168.1.50',
  port: over.port ?? 9100,
  width: over.width ?? '80',
});

const outlet = (over: Partial<Outlet>): Outlet => ({
  id: over.id ?? 'o1',
  name: over.name ?? 'Kitchen',
  sort: over.sort ?? 0,
  is_active: over.is_active ?? true,
  is_default: over.is_default ?? false,
  printer_ip: over.printer_ip,
  printer_port: over.printer_port ?? 9100,
  printer_width: over.printer_width ?? '80',
});

describe('outletTarget', () => {
  it('maps an outlet with a printer to a target', () => {
    expect(outletTarget(outlet({ printer_ip: '10.0.0.2', printer_port: 9100, printer_width: '58' }))).toEqual({
      ip: '10.0.0.2',
      port: 9100,
      width: '58',
    });
  });

  it('trims whitespace and defaults a zero port to 9100', () => {
    expect(outletTarget(outlet({ printer_ip: ' 10.0.0.9 ', printer_port: 0 }))).toEqual({
      ip: '10.0.0.9',
      port: 9100,
      width: '80',
    });
  });

  it('returns null when the outlet has no printer', () => {
    expect(outletTarget(outlet({ printer_ip: undefined }))).toBeNull();
    expect(outletTarget(outlet({ printer_ip: '   ' }))).toBeNull();
    expect(outletTarget(undefined)).toBeNull();
  });
});

describe('receiptTargets', () => {
  it('uses the dedicated receipt list', () => {
    const prefs = {
      receiptPrinters: [conn({ id: 'r1', ip: '10.0.0.3' })],
    } as TenantPreferences;
    expect(receiptTargets(prefs)).toEqual([{ ip: '10.0.0.3', port: 9100, width: '80' }]);
  });

  it('drops entries with no ip and trims whitespace', () => {
    const prefs = {
      receiptPrinters: [conn({ ip: '  ' }), conn({ id: 'r2', ip: ' 10.0.0.9 ' })],
    } as TenantPreferences;
    expect(receiptTargets(prefs)).toEqual([{ ip: '10.0.0.9', port: 9100, width: '80' }]);
  });

  it('is empty when unset', () => {
    expect(receiptTargets(undefined)).toEqual([]);
    expect(receiptTargets({} as TenantPreferences)).toEqual([]);
  });
});
