/** In-app feedback (M9) — submit a bug/idea/question and read back your own.
 * Multipart: a report can carry a mood and up to five screenshots. A picture
 * of the wrong screen answers more than a paragraph describing it, and on a
 * phone taking one is a reflex. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { MyBugReport, BugKind } from '@cafe-mgmt/api-types';
import { api } from './client';
import { useTenantStore } from '../stores/tenant';
import { appVersion } from '../lib/appVersion';
import type { PickedImage } from './uploads';

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

/** The server caps attachments at 5 files of 5 MB each. */
export const MAX_FEEDBACK_FILES = 5;

export type SubmitFeedback = {
  kind: BugKind;
  title?: string;
  description: string;
  /** 1..5. Optional — a report without a mood is still a report. */
  mood?: number;
  /** Screenshots. A picture of the wrong screen answers more than a
   *  paragraph describing it. */
  files?: PickedImage[];
};

export function useSubmitFeedback() {
  const slug = useSlug();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SubmitFeedback) => {
      const fd = new FormData();
      fd.append('kind', input.kind);
      if (input.title) fd.append('title', input.title);
      fd.append('description', input.description);
      if (input.mood) fd.append('mood', String(input.mood));
      // Same field name repeated — this is how multipart carries a list, and
      // what the handler reads as r.MultipartForm.File["files"].
      for (const f of (input.files ?? []).slice(0, MAX_FEEDBACK_FILES)) {
        fd.append('files', f as unknown as Blob);
      }
      // The release, plus the OTA bundle id when the running JS is not the
      // one baked into the build. This used to be the literal string
      // 'go-serve-mobile', which named the app and dated nothing.
      fd.append('app_version', appVersion());
      return api.post('/v1/bug-reports', fd, { tenantSlug: slug });
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['bug-reports-mine', slug] }),
  });
}
