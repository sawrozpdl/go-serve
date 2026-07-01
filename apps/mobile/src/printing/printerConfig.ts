/**
 * Per-device printer configuration, persisted to MMKV. Mirrors web's
 * `getDeviceRole`/`setDeviceRole`: a device's print role + printer IPs are a
 * property of that till, not synced to the tenant. Kitchen and receipt can be
 * the same or different physical printers (there's no OS spooler on mobile to
 * route for us, unlike web).
 */
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { mmkvStorage } from '../lib/zustandStorage';

export type PrintWidth = '58' | '80';
export type PrinterTarget = { ip: string; port: number; width: PrintWidth };
export type DeviceRole = { kitchen: boolean; receipt: boolean };

type PrintConfigState = {
  /** null until configured. */
  kitchenPrinter: PrinterTarget | null;
  receiptPrinter: PrinterTarget | null;
  role: DeviceRole;
  setKitchenPrinter: (p: PrinterTarget | null) => void;
  setReceiptPrinter: (p: PrinterTarget | null) => void;
  setRole: (role: Partial<DeviceRole>) => void;
};

export const DEFAULT_PORT = 9100;

export const usePrintConfig = create<PrintConfigState>()(
  persist(
    (set) => ({
      kitchenPrinter: null,
      receiptPrinter: null,
      role: { kitchen: false, receipt: false },
      setKitchenPrinter: (kitchenPrinter) => set({ kitchenPrinter }),
      setReceiptPrinter: (receiptPrinter) => set({ receiptPrinter }),
      setRole: (patch) => set((s) => ({ role: { ...s.role, ...patch } })),
    }),
    { name: 'goserve-print-config', storage: createJSONStorage(() => mmkvStorage) },
  ),
);
