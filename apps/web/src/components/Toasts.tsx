import { CheckCircle2, Info, AlertCircle, X } from 'lucide-react';

import { useToasts, useDismissToast, type ToastKind } from '@/lib/toast';

const ICONS: Record<ToastKind, typeof CheckCircle2> = {
  success: CheckCircle2,
  info: Info,
  error: AlertCircle,
};

export function Toasts() {
  const items = useToasts();
  const dismiss = useDismissToast();

  if (items.length === 0) return null;

  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {items.map((t) => {
        const Icon = ICONS[t.kind];
        return (
          <div key={t.id} className={`toast toast-${t.kind}`} role="status">
            <Icon size={16} strokeWidth={1.6} className="toast-icon" />
            <div className="toast-body">
              <div className="toast-msg">{t.message}</div>
              {t.hint && <div className="toast-hint">{t.hint}</div>}
            </div>
            <button
              type="button"
              className="toast-close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
            >
              <X size={14} strokeWidth={1.6} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
