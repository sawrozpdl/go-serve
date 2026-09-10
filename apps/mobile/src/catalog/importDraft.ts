/**
 * Turning a reviewed import draft into the payload the server takes.
 *
 * The draft holds prices as free TEXT in major units, because the operator is
 * fixing what a language model read off a photograph and needs to be able to
 * type "1,250" or "125.5" or clear the box entirely. This is where that
 * becomes money.
 */
import type { BulkImportPayload } from '@cafe-mgmt/api-types';
import type { ImportCategoryDraft } from '@cafe-mgmt/menu-import';

/** Major-unit text → cents, or null when it isn't a usable price. */
export function draftPriceToCents(text: string): number | null {
  // Strip grouping commas and any currency the model helpfully included.
  const cleaned = text.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export type DraftProblem = { category: string; item: string; reason: string };

/**
 * Every row that cannot be imported, and why.
 *
 * Reported rather than silently dropped: an operator who pasted forty items
 * and got thirty-eight has to know which two, or they will find out weeks
 * later when someone orders one.
 */
export function draftProblems(cats: ImportCategoryDraft[]): DraftProblem[] {
  const out: DraftProblem[] = [];
  for (const c of cats) {
    for (const it of c.items) {
      if (draftPriceToCents(it.price) == null) {
        out.push({
          category: c.name,
          item: it.name,
          reason: it.price.trim() ? `"${it.price}" is not a price` : 'no price',
        });
      }
    }
  }
  return out;
}

/** Rows that will actually be sent. */
export function draftItemCount(cats: ImportCategoryDraft[]): number {
  return cats.reduce(
    (n, c) => n + c.items.filter((it) => draftPriceToCents(it.price) != null).length,
    0,
  );
}

/**
 * Build the payload, dropping unpriced rows and any category left empty by
 * that. A category with no importable items would otherwise be created bare,
 * which reads as a successful import of nothing.
 */
export function toImportPayload(
  cats: ImportCategoryDraft[],
  opts: { dryRun: boolean; overwriteExisting: boolean },
): BulkImportPayload {
  const categories = cats
    .map((c) => ({
      name: c.name.trim(),
      icon: c.icon || undefined,
      items: c.items
        .map((it) => ({ it, cents: draftPriceToCents(it.price) }))
        .filter((row): row is { it: typeof row.it; cents: number } => row.cents != null)
        .map(({ it, cents }) => ({
          name: it.name.trim(),
          description: it.description || undefined,
          icon: it.icon || undefined,
          price_cents: cents,
        })),
    }))
    .filter((c) => c.name && c.items.length > 0);

  return { dry_run: opts.dryRun, overwrite_existing: opts.overwriteExisting, categories };
}
