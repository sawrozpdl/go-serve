/**
 * IRD fiscal documents (docs/ird/COMPLIANCE.md). Invoices are issued by the
 * close call (useCloseOrder); this module reads, prints and corrects them.
 * Every print goes through the server, which counts it and decides the label
 * (ORIGINAL, SECOND COPY, Copy of Original (n)) — the app never decides that
 * itself. Mirrors web lib/api.ts's fiscal hooks.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateCreditNoteVars,
  CreditNote,
  CreditNotePrintResponse,
  InvoicePrintResponse,
  InvoiceView,
} from '@cafe-mgmt/api-types';
import { api } from './client';
import { qk } from './queryKeys';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

const invoiceKey = (slug: string, id: string) => ['invoice', slug, id] as const;

/** An issued invoice with its prints, CBMS status and corrections (fiscal:print). */
export function useInvoiceView(invoiceId: string | undefined, enabled = true) {
  const slug = useSlug();
  return useQuery({
    queryKey: invoiceKey(slug ?? '', invoiceId ?? ''),
    queryFn: () => api.get<InvoiceView>(`/v1/invoices/${invoiceId}`, { tenantSlug: slug }),
    enabled: !!slug && !!invoiceId && enabled,
  });
}

export function usePrintInvoice() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { invoiceId: string; device?: string }) =>
      api.post<InvoicePrintResponse>(
        `/v1/invoices/${vars.invoiceId}/print`,
        vars.device ? { device: vars.device } : {},
        { tenantSlug: slug },
      ),
    onSuccess: (_r, vars) => {
      void qc.invalidateQueries({ queryKey: invoiceKey(slug ?? '', vars.invoiceId) });
    },
  });
}

/** Issue a sales return or reverse entry against an invoice (fiscal:correct). */
export function useCreateCreditNote() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, ...body }: CreateCreditNoteVars) =>
      api.post<CreditNote>(`/v1/invoices/${invoiceId}/credit-notes`, body, { tenantSlug: slug }),
    onSuccess: (cn) => {
      const s = slug ?? '';
      void qc.invalidateQueries({ queryKey: invoiceKey(s, cn.invoice_id) });
      void qc.invalidateQueries({ queryKey: qk.orderHistoryAll(s) });
      void qc.invalidateQueries({ queryKey: qk.currentShift(s) });
      void qc.invalidateQueries({ queryKey: qk.orders(s) });
      void qc.invalidateQueries({ queryKey: qk.tables(s) });
      void qc.invalidateQueries({ queryKey: qk.houseTabs(s) });
    },
  });
}

/** Record one print of a credit note; returns the label to print. */
export function usePrintCreditNote() {
  const slug = useSlug();
  return useMutation({
    mutationFn: (vars: { creditNoteId: string; device?: string }) =>
      api.post<CreditNotePrintResponse>(
        `/v1/credit-notes/${vars.creditNoteId}/print`,
        vars.device ? { device: vars.device } : {},
        { tenantSlug: slug },
      ),
  });
}
