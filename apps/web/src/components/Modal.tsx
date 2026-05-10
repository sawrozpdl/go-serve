import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type Props = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
};

export function Modal({ open, title, subtitle, onClose, children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  // Render into <body> so the dialog escapes any ancestor that creates a
  // containing block for fixed elements (transform/filter/backdrop-filter).
  // Without this, the modal is trapped inside whatever panel it's declared in.
  return createPortal(
    <div className="scrim">
      <div className="modal" role="dialog" aria-modal="true">
        <button
          type="button"
          className="modal-close"
          aria-label="close"
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.5} />
        </button>
        <div className="modal-head">
          <h3>{title}</h3>
          {subtitle && <div className="sub">{subtitle}</div>}
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
