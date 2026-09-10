/**
 * Image uploads — menu art, the workspace logo, and the receipt image.
 *
 * All three are multipart POSTs that answer `{ url }`, and the URL is then
 * saved onto whatever record wanted it (a menu item's `image_url`, the
 * branding block, `preferences.receiptImageUrl`). Uploading and saving are
 * deliberately two steps: the upload is the slow, failable half, and a failed
 * save should not leave the caller thinking the picture is attached.
 *
 * The client layer already skips its JSON Content-Type for a FormData body —
 * setting one by hand strips the multipart boundary and the server rejects the
 * request as malformed, which is a genuinely baffling failure to debug.
 */
import { useMutation } from '@tanstack/react-query';
import { api } from './client';
import { useTenantStore } from '../stores/tenant';

/** What a picked image needs to become a multipart part. */
export type PickedImage = { uri: string; name: string; type: string };

function toForm(image: PickedImage): FormData {
  const fd = new FormData();
  // RN's FormData takes this {uri,name,type} shape rather than a Blob; the
  // cast is the standard React Native idiom for it.
  fd.append('file', image as unknown as Blob);
  return fd;
}

function useSlug() {
  return useTenantStore((s) => s.active?.slug);
}

/** Menu item / category artwork. */
export function useUploadMenuImage() {
  const slug = useSlug();
  return useMutation({
    mutationFn: (image: PickedImage) =>
      api.post<{ url: string }>('/v1/menu/images', toForm(image), { tenantSlug: slug }),
  });
}

/** Workspace logo — lands on the branding block server-side. */
export function useUploadLogo() {
  const slug = useSlug();
  return useMutation({
    mutationFn: (image: PickedImage) =>
      api.post<{ url: string }>('/v1/tenant/logo', toForm(image), { tenantSlug: slug }),
  });
}

/** The small image printed above the receipt footer (usually a payment QR). */
export function useUploadReceiptImage() {
  const slug = useSlug();
  return useMutation({
    mutationFn: (image: PickedImage) =>
      api.post<{ url: string }>('/v1/tenant/receipt-image', toForm(image), { tenantSlug: slug }),
  });
}
