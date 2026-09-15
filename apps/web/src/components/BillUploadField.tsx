import { useEffect, useRef, useState } from 'react';
import { FileText, Loader2, Trash2, Upload, Sparkles } from 'lucide-react';

import { useUploadExpenseBill, useReadExpenseBill, fetchExpenseDocBlob } from '@/lib/api';
import type { BillSuggestion, ExpenseDocument } from '@/lib/api';
import { useTenant } from '@/lib/tenant';
import { formatBytes } from '@/lib/staff-docs';
import { toast } from '@/lib/toast';

type Props = {
  /** Bills already attached to (or staged for) this expense. */
  docs: ExpenseDocument[];
  onAdd: (doc: ExpenseDocument) => void;
  onRemove: (docId: string) => void;
  /** Called with whatever the server could read off the bill — never applied
   *  here, because only the form knows which fields the operator has touched. */
  onSuggestion?: (s: BillSuggestion) => void;
  disabled?: boolean;
};

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

/**
 * Attach the supplier's bill to an expense.
 *
 * Two things happen on pick, and they are deliberately independent: the file is
 * stored, and — separately — the server is asked whether it can read anything
 * off it. The upload is what matters; the reading is a convenience that is
 * allowed to fail silently, because for most workspaces it is simply not
 * configured and nothing should look broken when it is off.
 */
export function BillUploadField({ docs, onAdd, onRemove, onSuggestion, disabled }: Props) {
  const upload = useUploadExpenseBill();
  const read = useReadExpenseBill();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!ALLOWED.includes(file.type)) {
      toast.error('Unsupported file', 'Attach a PDF, PNG, JPEG or WEBP.');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('File too large', 'Maximum size is 10 MB.');
      return;
    }
    try {
      const doc = await upload.mutateAsync(file);
      onAdd(doc);
      // Reading is best-effort. A workspace with no model configured gets a
      // null suggestion and a form that behaves exactly as it always has.
      try {
        const s = await read.mutateAsync(doc.id);
        if (s && s.fields.length > 0) onSuggestion?.(s);
      } catch {
        /* the bill is saved either way — that is the part that matters */
      }
    } catch (e: unknown) {
      toast.error('Upload failed', (e as { message?: string }).message ?? 'Please try again.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="bill-upload">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        hidden
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />

      {docs.map((d) => (
        <BillRow key={d.id} doc={d} onRemove={() => onRemove(d.id)} disabled={disabled} />
      ))}

      <button
        type="button"
        className={`bill-upload__drop${dragOver ? ' is-over' : ''}`}
        onClick={() => inputRef.current?.click()}
        disabled={disabled || upload.isPending}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFile(e.dataTransfer.files?.[0]);
        }}
      >
        {upload.isPending ? (
          <>
            <Loader2 size={16} className="spin" /> Saving the bill…
          </>
        ) : read.isPending ? (
          <>
            <Sparkles size={16} strokeWidth={1.6} /> Reading the bill…
          </>
        ) : (
          <>
            <Upload size={16} strokeWidth={1.5} />
            {docs.length > 0 ? 'Add another page' : 'Attach the bill'}
          </>
        )}
      </button>
      <div className="field-hint">
        PDF or photo, up to 10 MB. Kept private — only people who can see this
        expense can open it.
      </div>
    </div>
  );
}

/** One attached bill, with a link that opens it through the authed proxy. */
function BillRow({
  doc,
  onRemove,
  disabled,
}: {
  doc: ExpenseDocument;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const { slug } = useTenant();
  const [href, setHref] = useState<string | null>(null);

  // The bytes come through an authenticated fetch, so the preview is a blob
  // URL that has to be revoked or it leaks for the life of the page.
  useEffect(() => {
    if (!slug) return;
    let revoked = false;
    let objectUrl: string | null = null;
    fetchExpenseDocBlob(slug, doc.id)
      .then((u) => {
        objectUrl = u;
        if (revoked) {
          URL.revokeObjectURL(u);
          return;
        }
        setHref(u);
      })
      .catch(() => setHref(null));
    return () => {
      revoked = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [slug, doc.id]);

  return (
    <div className="bill-row">
      <FileText size={15} strokeWidth={1.5} aria-hidden />
      <span className="bill-row__name">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {doc.file_name || 'Bill'}
          </a>
        ) : (
          (doc.file_name || 'Bill')
        )}
      </span>
      <span className="bill-row__size">{formatBytes(doc.size_bytes)}</span>
      <button
        type="button"
        className="btn icon"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Remove ${doc.file_name || 'bill'}`}
      >
        <Trash2 size={13} strokeWidth={1.5} />
      </button>
    </div>
  );
}
