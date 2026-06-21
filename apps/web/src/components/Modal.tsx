import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type Props = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** 'wide' roomier dialog — e.g. for galleries/grids. Defaults to the standard width. */
  size?: 'default' | 'wide';
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ open, title, subtitle, onClose, children, size = 'default' }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Trap Tab inside the dialog so keyboard focus can't wander into the
      // inert page behind the scrim.
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Move focus into the dialog on open; restore it to the opener on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const el = dialogRef.current;
    if (el) {
      // Prefer the first form control over the close button.
      const focusables = el.querySelectorAll<HTMLElement>(FOCUSABLE);
      (focusables[1] ?? focusables[0])?.focus();
    }
    return () => {
      previouslyFocused?.focus?.();
    };
  }, [open]);

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
      <div
        className={`modal${size === 'wide' ? ' modal--wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
      >
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
