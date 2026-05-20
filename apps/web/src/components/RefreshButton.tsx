import { RefreshCw } from 'lucide-react';

// Tiny icon-only refresh control, used in page topbars so users always
// have a manual escape hatch — useful when the WS falls back to polling
// or when something feels stale. Spins while `busy` is true; disabled in
// the same window so the user can't queue a storm of refetches.

type Props = {
  onClick: () => void | Promise<unknown>;
  busy?: boolean;
  label?: string;
};

export function RefreshButton({ onClick, busy = false, label = 'Refresh' }: Props) {
  return (
    <button
      type="button"
      className="btn icon"
      onClick={() => void onClick()}
      disabled={busy}
      aria-label={label}
      title={label}
    >
      <RefreshCw
        size={14}
        strokeWidth={1.5}
        style={busy ? { animation: 'spin-cw 0.8s linear infinite' } : undefined}
      />
    </button>
  );
}
