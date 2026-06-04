import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, ChevronLeft, ChevronRight, Download, Trash2, Loader2 } from 'lucide-react';

import { useDeleteStaffDocument, type StaffDocument } from '@/lib/api';
import { docTypeLabel, formatBytes, isImage, useStaffDocUrl } from '@/lib/staff-docs';
import { Can } from '@/lib/permissions';
import { toast } from '@/lib/toast';

type Props = {
  staffId: string;
  documents: StaffDocument[];
  index: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
};

// Full-screen viewer for a staff member's documents. Images render inline and
// zoom-to-fit; PDFs render in an embedded frame. Bytes load through the
// authenticated proxy (useStaffDocUrl), so nothing is ever a public URL.
export function StaffDocumentLightbox({ staffId, documents, index, onClose, onIndexChange }: Props) {
  const doc = documents[index];
  const del = useDeleteStaffDocument(staffId);
  const [confirming, setConfirming] = useState(false);
  const { url, loading, error } = useStaffDocUrl(staffId, doc?.id ?? '', !!doc);

  const hasPrev = index > 0;
  const hasNext = index < documents.length - 1;

  useEffect(() => {
    setConfirming(false);
  }, [index]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && hasPrev) onIndexChange(index - 1);
      else if (e.key === 'ArrowRight' && hasNext) onIndexChange(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, hasPrev, hasNext, onClose, onIndexChange]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (!doc) return null;

  const onDelete = async () => {
    try {
      await del.mutateAsync(doc.id);
      toast.success('Document deleted', docTypeLabel(doc));
      onClose();
    } catch (err) {
      toast.error('Could not delete', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  return createPortal(
    <div className="staff-lightbox" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="staff-lightbox__bar" onClick={(e) => e.stopPropagation()}>
        <div className="staff-lightbox__title">
          <strong>{docTypeLabel(doc)}</strong>
          <span>
            {doc.file_name || 'document'} · {formatBytes(doc.size_bytes)}
          </span>
        </div>
        <div className="staff-lightbox__tools">
          {url && (
            <a className="btn small" href={url} download={doc.file_name || 'document'}>
              <Download size={14} /> Download
            </a>
          )}
          <Can perm="staff:delete_document">
            {confirming ? (
              <button type="button" className="btn small danger" onClick={onDelete} disabled={del.isPending}>
                {del.isPending ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                Confirm delete
              </button>
            ) : (
              <button type="button" className="btn small danger" onClick={() => setConfirming(true)}>
                <Trash2 size={14} /> Delete
              </button>
            )}
          </Can>
          <button type="button" className="btn icon staff-lightbox__close" aria-label="Close" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>

      <div className="staff-lightbox__stage" onClick={(e) => e.stopPropagation()}>
        {hasPrev && (
          <button
            type="button"
            className="staff-lightbox__nav staff-lightbox__nav--prev"
            aria-label="Previous"
            onClick={() => onIndexChange(index - 1)}
          >
            <ChevronLeft size={22} />
          </button>
        )}

        {loading && <div className="staff-lightbox__status"><Loader2 size={24} className="spin" /></div>}
        {error && <div className="staff-lightbox__status">Couldn’t load this document.</div>}
        {!loading && !error && url && (
          isImage(doc.mime_type) ? (
            <img className="staff-lightbox__img" src={url} alt={docTypeLabel(doc)} />
          ) : (
            <iframe className="staff-lightbox__pdf" src={url} title={doc.file_name || 'document'} />
          )
        )}

        {hasNext && (
          <button
            type="button"
            className="staff-lightbox__nav staff-lightbox__nav--next"
            aria-label="Next"
            onClick={() => onIndexChange(index + 1)}
          >
            <ChevronRight size={22} />
          </button>
        )}
      </div>

      <div className="staff-lightbox__count" onClick={(e) => e.stopPropagation()}>
        {index + 1} / {documents.length}
      </div>
    </div>,
    document.body,
  );
}
