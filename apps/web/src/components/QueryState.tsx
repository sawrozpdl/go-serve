/* One place that decides what a page shows while it is loading, when the
 * request failed, and when the answer is legitimately empty.
 *
 * The platform console used to open-code this per page as
 * `{q.isError && <div className="banner-error">{q.error?.message}</div>}`,
 * with no loading state at all — so a slow cross-tenant query looked like an
 * empty table, and a failure looked like a bare sentence with no way to retry.
 */

import type { ReactNode } from 'react';

import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';
import { EmptyState } from './EmptyState';

type Props = {
  /** Straight from react-query. */
  isPending: boolean;
  isError?: boolean;
  error?: { message?: string } | null;
  refetch?: () => void;
  /** When true (and not pending/erroring), render `empty` instead of children. */
  isEmpty?: boolean;
  emptyTitle?: string;
  emptyHint?: string;
  emptyCta?: ReactNode;
  loadingLabel?: string;
  errorTitle?: string;
  /** Render inline (inside a panel) rather than as a full page region. */
  compact?: boolean;
  children: ReactNode;
};

export function QueryState({
  isPending,
  isError,
  error,
  refetch,
  isEmpty,
  emptyTitle = 'Nothing here yet',
  emptyHint,
  emptyCta,
  loadingLabel = 'Loading…',
  errorTitle = 'Could not load this',
  compact = false,
  children,
}: Props) {
  // Error first: a refetch that fails while showing stale data should surface
  // the failure rather than quietly leave the old rows on screen.
  if (isError) {
    return (
      <ErrorState
        title={errorTitle}
        hint={error?.message}
        onRetry={refetch}
        compact={compact}
      />
    );
  }
  if (isPending) return <LoadingState label={loadingLabel} compact={compact} />;
  if (isEmpty) return <EmptyState title={emptyTitle} hint={emptyHint} cta={emptyCta} compact={compact} />;
  return <>{children}</>;
}
