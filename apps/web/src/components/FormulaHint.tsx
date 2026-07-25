import { formatNPR } from './Money';
import { InfoHint } from './InfoHint';
import { buildFormula, withoutZeroTerms, type FormulaTerm } from '@/lib/formula';

type Props = {
  /** Registry id, so the popover also deep-links into the guide. */
  topic?: string;
  /** What the figure is called on screen. */
  label: string;
  /** The figure itself, in paisa. */
  cents: number;
  /** The terms it is built from, in display order. */
  terms: FormulaTerm[];
  /** One or two sentences on why the figure is defined this way. */
  note?: React.ReactNode;
  /** Hide terms that are zero (default true) so a simple day stays simple. */
  compact?: boolean;
};

/**
 * "How is this number built?" — the arithmetic, with the tenant's own numbers,
 * in the popover attached to the figure.
 *
 * A label alone ("Net revenue", "Expected cash") tells an operator what a number
 * is called, not what is inside it. That gap is what let two screens show
 * different figures under the same word for months. Here the terms are laid out
 * and summed in front of them:
 *
 *     Billed sales        रू 234
 *   − VAT collected       रू 26.92
 *   = Net revenue         रू 207.08
 *
 * If the terms don't add up to the figure, that is a bug in whatever assembled
 * the formula — so it is shown rather than hidden.
 */
export function FormulaHint({ topic, label, cents, terms, note, compact = true }: Props) {
  const f = buildFormula(label, cents, compact ? withoutZeroTerms(terms) : terms);
  return (
    <InfoHint topic={topic} label={`How ${label} is calculated`}>
      <span className="formula">
        <span className="formula__title">How {label.toLowerCase()} is calculated</span>
        <span className="formula__rows">
          {f.rows.map((r) => (
            <span className="formula__row" key={r.label}>
              <span className="formula__op" aria-hidden>
                {r.op}
              </span>
              <span className="formula__label">
                {r.label}
                {r.note ? <em className="formula__note"> {r.note}</em> : null}
              </span>
              <span className="formula__value">{formatNPR(r.cents)}</span>
            </span>
          ))}
          <span className="formula__row formula__row--result">
            <span className="formula__op" aria-hidden>
              =
            </span>
            <span className="formula__label">{f.resultLabel}</span>
            <span className="formula__value">{formatNPR(f.resultCents)}</span>
          </span>
        </span>
        {f.mismatch && (
          // Loud on purpose: the number on screen and the explanation of it have
          // diverged, which is precisely the class of bug this UI exists to stop.
          <span className="formula__mismatch">
            These parts add up to {formatNPR(f.computedCents)}, not {formatNPR(f.resultCents)} —
            please report this.
          </span>
        )}
        {note ? <span className="formula__why">{note}</span> : null}
      </span>
    </InfoHint>
  );
}
