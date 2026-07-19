import { ArrowDownAZ } from 'lucide-react';

/**
 * Small toggle button that flips a list into alphabetical (A–Z) order. Drop it
 * in a page's PageShell `actions` slot and wire it to `useAlphaSort`.
 */
export function AlphaSortToggle({
  active,
  onToggle,
}: {
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className={`btn${active ? ' primary' : ''}`}
      onClick={onToggle}
      aria-pressed={active}
      title={active ? 'Alphabetical order on — click to restore default order' : 'Sort A–Z'}
    >
      <ArrowDownAZ size={14} strokeWidth={1.6} /> A–Z
    </button>
  );
}
