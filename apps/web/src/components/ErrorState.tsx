/* ErrorState
 *
 * Standard in-panel failure display. Pages render this on `query.isError`
 * instead of leaving a silent blank panel, with a retry wired to refetch.
 */

import type { ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

type Props = {
  title?: string;
  hint?: ReactNode;
  /** Wire to the failed query's refetch(). Omit to hide the retry button. */
  onRetry?: () => void;
  /** Smaller, denser variant for in-panel use. */
  compact?: boolean;
};

export function ErrorState({
  title = "Couldn't load this",
  hint = 'Check your connection and try again.',
  onRetry,
  compact = false,
}: Props) {
  return (
    <div className={`error-state${compact ? ' compact' : ''}`} role="alert">
      <AlertCircle className="error-state__icon" size={compact ? 22 : 30} strokeWidth={1.5} aria-hidden="true" />
      <div className="error-state__title">{title}</div>
      {hint && <div className="error-state__hint">{hint}</div>}
      {onRetry && (
        <button type="button" className="btn small" onClick={onRetry}>
          <RotateCcw size={13} strokeWidth={1.8} /> Try again
        </button>
      )}
    </div>
  );
}
