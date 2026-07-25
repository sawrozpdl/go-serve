/* Arithmetic shown to the operator, with their own numbers.
 *
 * A money figure is only trustworthy if you can see how it was built. These
 * helpers turn a figure plus its terms into displayable rows AND check that the
 * arithmetic actually holds — so a formula that has drifted from the number it
 * claims to explain is caught here rather than quietly misleading someone.
 */

export type FormulaTerm = {
  label: string;
  cents: number;
  /** How this term combines with the running total. First term ignores it. */
  op?: '+' | '−';
  /** Optional one-line aside, e.g. "owed to the government". */
  note?: string;
};

export type FormulaRow = Omit<FormulaTerm, 'op'> & { op: '+' | '−' | '' };

export type Formula = {
  rows: FormulaRow[];
  resultLabel: string;
  resultCents: number;
  /** The terms' own arithmetic. Equals resultCents in a correct formula. */
  computedCents: number;
  /** True when the terms do NOT add up to the stated result. */
  mismatch: boolean;
};

/** Combine terms into rows plus a verified result. */
export function buildFormula(
  resultLabel: string,
  resultCents: number,
  terms: FormulaTerm[],
): Formula {
  const rows: FormulaRow[] = terms.map((t, i) => ({
    ...t,
    op: i === 0 ? '' : (t.op ?? '+'),
  }));
  const computedCents = rows.reduce(
    (sum, t, i) => (i === 0 ? t.cents : t.op === '−' ? sum - t.cents : sum + t.cents),
    0,
  );
  return {
    rows,
    resultLabel,
    resultCents,
    computedCents,
    mismatch: computedCents !== resultCents,
  };
}

/** Drop terms that are zero, keeping the formula short — but never drop them all,
 *  and never drop one that would break the arithmetic. */
export function withoutZeroTerms(terms: FormulaTerm[]): FormulaTerm[] {
  const kept = terms.filter((t, i) => i === 0 || t.cents !== 0);
  return kept.length > 0 ? kept : terms;
}
