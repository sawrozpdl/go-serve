/**
 * Networked-printer targets, resolved from the tenant preferences that an admin
 * sets ONCE on the web dashboard. Nothing here is device-local anymore: every
 * phone pulls the same config via `useTenantSettings` and prints to the shared
 * network printer(s). Because only the acting device fires a job (and it goes to
 * a central printer), there's no per-device "role" and no duplicate-print
 * problem — unlike web's window.print() path.
 */
import type { PrinterConn, TenantPreferences } from '@cafe-mgmt/api-types';

export type PrintWidth = '58' | '80';
/** The minimal target the ESC/POS senders need. */
export type PrinterTarget = { ip: string; port: number; width: PrintWidth };

export const DEFAULT_PORT = 9100;

/** Drop unusable entries and narrow PrinterConn → PrinterTarget. */
function toTargets(printers: PrinterConn[] | undefined): PrinterTarget[] {
  return (printers ?? [])
    .filter((p) => p.type === 'network' && !!p.ip?.trim())
    .map((p) => ({ ip: p.ip.trim(), port: p.port || DEFAULT_PORT, width: p.width }));
}

/** Printers that should receive the kitchen docket (KOT). */
export function kitchenTargets(prefs: TenantPreferences | undefined): PrinterTarget[] {
  return toTargets(prefs?.kitchenPrinters);
}

/** Printers that should receive the customer receipt — the kitchen printers when
 *  "same as kitchen" is on, otherwise the dedicated receipt list. */
export function receiptTargets(prefs: TenantPreferences | undefined): PrinterTarget[] {
  return toTargets(prefs?.receiptSameAsKitchen ? prefs?.kitchenPrinters : prefs?.receiptPrinters);
}
