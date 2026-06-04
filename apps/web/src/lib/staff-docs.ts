// Staff document presets + a small hook for loading a private document as an
// object URL. The byte stream itself lives in api.ts (fetchStaffDocBlob); this
// wraps it with React lifecycle so previews/lightboxes clean up their blob URLs.

import { useEffect, useState } from 'react';

import { fetchStaffDocBlob, type StaffDocument } from '@/lib/api';
import { useTenant } from '@/lib/tenant';

/** The "kind of document" options offered on upload (the user's preset list). */
export const DOC_TYPE_PRESETS = [
  { key: 'citizenship', label: 'Citizenship' },
  { key: 'drivers_license', label: "Driver's License" },
  { key: 'passport', label: 'Passport' },
  { key: 'national_id', label: 'National ID' },
  { key: 'pan_tax_id', label: 'PAN / Tax ID' },
  { key: 'contract', label: 'Contract / Agreement' },
  { key: 'photo', label: 'Photo' },
  { key: 'other', label: 'Other' },
] as const;

export type DocTypeKey = (typeof DOC_TYPE_PRESETS)[number]['key'];

/** Human label for a document's kind. Custom 'other' docs show their label. */
export function docTypeLabel(doc: Pick<StaffDocument, 'doc_type' | 'label'>): string {
  if (doc.doc_type === 'other') return doc.label || 'Other';
  const preset = DOC_TYPE_PRESETS.find((d) => d.key === doc.doc_type);
  return preset ? preset.label : doc.doc_type;
}

export function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type DocUrlState = { url: string | null; loading: boolean; error: boolean };

/**
 * Load a private staff document into a blob object URL while `enabled`. Revokes
 * the URL on unmount or when the target document changes, so previews don't
 * leak memory. Returns { url, loading, error }.
 */
export function useStaffDocUrl(
  staffId: string,
  docId: string,
  enabled = true,
): DocUrlState {
  const { slug } = useTenant();
  const [state, setState] = useState<DocUrlState>({ url: null, loading: enabled, error: false });

  useEffect(() => {
    if (!enabled || !slug) {
      setState({ url: null, loading: false, error: false });
      return;
    }
    let revoked = false;
    let objectUrl: string | null = null;
    setState({ url: null, loading: true, error: false });
    fetchStaffDocBlob(slug, staffId, docId)
      .then((u) => {
        objectUrl = u;
        if (revoked) {
          URL.revokeObjectURL(u);
          return;
        }
        setState({ url: u, loading: false, error: false });
      })
      .catch(() => {
        if (!revoked) setState({ url: null, loading: false, error: true });
      });
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [slug, staffId, docId, enabled]);

  return state;
}
