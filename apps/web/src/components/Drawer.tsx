import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

type Props = {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  /** Optional node rendered above the title in the header (eyebrow, badges). */
  headerExtra?: ReactNode;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Right-slide overlay drawer. Mirrors Modal.tsx conventions: portal to
// <body>, Escape-to-close, body scroll lock, focus trap + restore.
// Styles live in admin.css under the "Drawer" section.
export function Drawer({ open, title, subtitle, onClose, children, headerExtra }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const el = dialogRef.current;
      if (!el) return;
      // If focus has moved into a stacked overlay (e.g. a modal opened
      // from inside the drawer portals its own dialog to <body>), defer
      // to that layer — don't steal Tab or close on its Escape.
      const active = document.activeElement;
      if (active && active !== document.body && !el.contains(active)) return;
      if (e.key === 'Escape') onClose();
      // Trap Tab inside the drawer so keyboard focus can't wander into
      // the inert page behind the scrim.
      if (e.key === 'Tab') {
        const focusables = el.querySelectorAll<HTMLElement>(FOCUSABLE);
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && (active === first || !el.contains(active))) {
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

  // Move focus into the drawer on open; restore it to the opener on close.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const el = dialogRef.current;
    if (el) {
      // Prefer the first body control over the close button.
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

  // Render into <body> so the drawer escapes any ancestor that creates a
  // containing block for fixed elements (transform/filter/backdrop-filter).
  return createPortal(
    <>
      <div className="drawer-panel-scrim" onClick={onClose} aria-hidden="true" />
      <div
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialogRef}
      >
        <header className="drawer-head">
          <div>
            {headerExtra}
            <h2>{title}</h2>
            {subtitle && <div className="sub">{subtitle}</div>}
          </div>
          <button type="button" className="btn icon" onClick={onClose} aria-label="close">
            <X size={16} strokeWidth={1.5} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}
