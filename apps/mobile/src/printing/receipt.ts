/**
 * Customer-receipt printing. Prints on settle-close when printing is enabled,
 * the receipt toggle is on, and this device is a receipt station — mirroring
 * web. The caller snapshots the args BEFORE closing (close finalizes totals
 * server-side and refetches).
 */
import { buildReceiptCommands, type ReceiptPayment } from '@cafe-mgmt/receipt-format';
import type { OrderItemRow, SettleQuote, TenantPreferences } from '@cafe-mgmt/api-types';
import { printBytes } from './tcpPrinter';
import type { DeviceRole, PrinterTarget } from './printerConfig';

export function shouldPrintReceipt(prefs: TenantPreferences | undefined, role: DeviceRole): boolean {
  return !!prefs?.printingEnabled && !!prefs?.printCustomerReceipt && role.receipt;
}

export type ReceiptContent = {
  items: OrderItemRow[];
  quote: SettleQuote;
  payments: ReceiptPayment[];
  tableLabel: string;
  header: string;
  footer: string;
  orderId: string;
  closedAt?: string | null;
  reprint?: boolean;
};

export async function printReceipt(content: ReceiptContent, printer: PrinterTarget): Promise<void> {
  const bytes = buildReceiptCommands({
    ...content,
    width: printer.width,
    now: new Date(),
  });
  await printBytes(printer.ip, printer.port, bytes);
}
