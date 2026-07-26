/**
 * Human-readable text for a thrown query/mutation error.
 *
 * The fetch layer throws a plain `ApiError` OBJECT (not an Error subclass), so
 * `String(err)` on it renders the literal "[object Object]" — which is what
 * every screen using `detail={String(q.error)}` was showing operators. Prefer
 * the API's own message, fall back to an Error's message, and only then to a
 * generic line.
 */
export function errorText(err: unknown): string {
  if (err == null) return 'Something went wrong.';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m;
  }
  return 'Something went wrong.';
}
