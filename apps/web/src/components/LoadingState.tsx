/* LoadingState
 *
 * Standard in-panel pending display — a spinner distinct from EmptyState so
 * "still fetching" never reads as "there's nothing here".
 */

type Props = {
  label?: string;
  /** Smaller, denser variant for in-panel use. */
  compact?: boolean;
};

export function LoadingState({ label = 'Loading…', compact = false }: Props) {
  return (
    <div className={`loading-state${compact ? ' compact' : ''}`} role="status" aria-live="polite">
      <span className="loading-state__spinner" aria-hidden="true" />
      <span className="loading-state__label">{label}</span>
    </div>
  );
}
