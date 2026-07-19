import { useCallback, useMemo, useState } from 'react';

/**
 * Pure A–Z sort: returns a new array ordered case-insensitively by `nameOf`.
 * Exported so it can be unit-tested without a React renderer.
 */
export function sortByNameAlpha<T>(items: T[], nameOf: (t: T) => string): T[] {
  return [...items].sort((a, b) =>
    nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base', numeric: true }),
  );
}

/**
 * A per-list alphabetical (A–Z) sort override. When enabled it re-sorts the
 * already-rendered array by name via localeCompare, OVERRIDING whatever order
 * the server returned (e.g. the menu's manual `sort` column). The preference is
 * remembered per list in localStorage so it survives reloads.
 *
 * There's no shared sortable-table component in the app — all list ordering is
 * decided by the backend SQL ORDER BY — so this is a light client-side layer
 * each list opts into by supplying a `nameOf` accessor and a stable `storageKey`.
 */
export function useAlphaSort<T>(
  items: T[],
  nameOf: (t: T) => string,
  storageKey: string,
): { sorted: T[]; alpha: boolean; toggle: () => void } {
  const lsKey = `alphaSort.${storageKey}`;
  const [alpha, setAlpha] = useState<boolean>(() => {
    try {
      return localStorage.getItem(lsKey) === '1';
    } catch {
      return false;
    }
  });

  const toggle = useCallback(() => {
    setAlpha((v) => {
      const next = !v;
      try {
        localStorage.setItem(lsKey, next ? '1' : '0');
      } catch {
        /* ignore storage failures (private mode etc.) */
      }
      return next;
    });
  }, [lsKey]);

  const sorted = useMemo(() => {
    if (!alpha) return items;
    return sortByNameAlpha(items, nameOf);
    // nameOf is expected to be cheap/stable; lists here are small.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, alpha]);

  return { sorted, alpha, toggle };
}
