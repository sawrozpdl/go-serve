/** In-app feedback (M9) — submit a bug/idea/question and read back your own.
 * The endpoint is multipart (it accepts screenshots on web); mobile sends a
 * text-only report for now (image attach is a tracked follow-up). */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MyBugReport, BugKind } from '@cafe-mgmt/api-types';
import { api } from './client';
import { useTenantStore } from '../stores/tenant';

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

export function useMyBugReports() {
  const slug = useSlug();
  return useQuery({
    queryKey: ['bug-reports-mine', slug],
    queryFn: () => api.get<{ reports: MyBugReport[] }>('/v1/bug-reports/mine', { tenantSlug: slug }).then((r) => r.reports),
    enabled: !!slug,
  });
}

export type SubmitFeedback = { kind: BugKind; title?: string; description: string };

export function useSubmitFeedback() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitFeedback) => {
      const fd = new FormData();
      fd.append('kind', input.kind);
      if (input.title) fd.append('title', input.title);
      fd.append('description', input.description);
      fd.append('app_version', 'go-serve-mobile');
      return api.post('/v1/bug-reports', fd, { tenantSlug: slug });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bug-reports-mine', slug] }),
  });
}
