import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle } from 'lucide-react';

import { Modal } from './Modal';

// Imperative confirm() replacement.
//
//   const confirm = useConfirm();
//   if (await confirm({ title: 'Delete?', message: '…', danger: true })) { … }
//
// Mounts via <ConfirmProvider> at the app root. The dialog is portal-rendered
// inside <Modal>, so it floats above any ancestor that creates a containing
// block (e.g. a transformed panel).

export type ConfirmOptions = {
  title: string;
  message?: ReactNode;
  /** Confirm-button label. Defaults to "Delete" when danger, else "Confirm". */
  confirmLabel?: string;
  /** Cancel-button label. Default "Cancel". */
  cancelLabel?: string;
  /** Renders the confirm button in the danger style + warning icon in head. */
  danger?: boolean;
  /** Optional secondary subtitle line (kicker above the message). */
  subtitle?: string;
};

type Resolver = (ok: boolean) => void;

type Ctx = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<Ctx | null>(null);

export function useConfirm(): Ctx {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm() requires <ConfirmProvider> at the app root');
  return ctx;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  const confirm = useCallback<Ctx>((next) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setOpts(next);
    });
  }, []);

  const close = useCallback(
    (ok: boolean) => {
      resolverRef.current?.(ok);
      resolverRef.current = null;
      setOpts(null);
    },
    [],
  );

  // Focus the confirm button when the dialog opens — most uses are deletes
  // where the user's already decided, so making Enter the affirmative is
  // ergonomic. Cancel still requires an explicit click / Escape.
  useEffect(() => {
    if (opts) {
      // next tick so the button is mounted
      const t = window.setTimeout(() => confirmBtnRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [opts]);

  // Enter = confirm (only while the dialog is open + the focused element
  // isn't a textarea/input where Enter has its own meaning).
  useEffect(() => {
    if (!opts) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'textarea' || tag === 'input') return;
      e.preventDefault();
      close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [opts, close]);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!opts}
        title={opts?.title ?? ''}
        subtitle={opts?.subtitle}
        onClose={() => close(false)}
      >
        {opts && (
          <div className="confirm-body">
            <div className="confirm-row">
              {opts.danger && (
                <div className="confirm-icon" aria-hidden="true">
                  <AlertTriangle size={20} strokeWidth={1.75} />
                </div>
              )}
              {opts.message && <div className="confirm-msg">{opts.message}</div>}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn"
                onClick={() => close(false)}
              >
                {opts.cancelLabel ?? 'Cancel'}
              </button>
              <button
                ref={confirmBtnRef}
                type="button"
                className={opts.danger ? 'btn danger' : 'btn primary'}
                onClick={() => close(true)}
              >
                {opts.confirmLabel ?? (opts.danger ? 'Delete' : 'Confirm')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </ConfirmCtx.Provider>
  );
}
