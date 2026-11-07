/**
 * IRD fiscal documents (docs/ird/COMPLIANCE.md). Invoices are issued by the
 * close call (useCloseOrder); this module prints them. Every print goes through
 * the server, which counts it and decides the label (ORIGINAL, SECOND COPY,
 * Copy of Original (n)) — the app never decides that itself.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InvoicePrintResponse } from '@cafe-mgmt/api-types';
import { api } from './client';
import { useTenantStore } from '../stores/tenant';

export function usePrintInvoice() {
  const slug = useTenantStore((s) => s.active?.slug);
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { invoiceId: string; device?: string }) =>
      api.post<InvoicePrintResponse>(
        `/v1/invoices/${vars.invoiceId}/print`,
        vars.device ? { device: vars.device } : {},
        { tenantSlug: slug },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['order-invoice'] });
    },
  });
}
