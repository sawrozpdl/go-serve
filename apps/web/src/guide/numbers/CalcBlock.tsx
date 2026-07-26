import { Check, TriangleAlert } from 'lucide-react';

import { formatNPRExact } from '@/components/Money';
import { buildFormula } from '@/lib/formula';
import type { Figure } from './figures';

/**
 * One figure, shown the way a receipt shows a total: the parts, the operators,
 * the line, the result — and a verdict on whether it actually adds up.
 *
 * Unlike FormulaHint (the same arithmetic inside a tooltip), this is a
 * full-width block meant to be read rather than peeked at, so it carries the
 * reasoning and the source columns too. Zero terms are kept: on a page whose
 * whole purpose is transparency, a term that is zero is information.
 */
export function CalcBlock({ figure }: { figure: Figure }) {
  const f =
    figure.terms && figure.cents !== undefined
      ? buildFormula(figure.resultLabel ?? figure.title, figure.cents, figure.terms)
      : null;

  return (
    <section className="calc-block" id={`metric-${figure.id}`}>
      <header className="calc-block__head">
        <h3 className="calc-block__title">{figure.title}</h3>
        <div className="calc-block__seen">
          {figure.seenOn.map((s) => (
            <span className="calc-block__chip" key={s}>
              {s}
            </span>
          ))}
        </div>
      </header>

      {f && (
        <div className="calc-block__math">
          <div className="formula__rows">
            {f.rows.map((r) => (
              <div className="formula__row" key={r.label}>
                <span className="formula__op" aria-hidden>
                  {r.op}
                </span>
                <span className="formula__label">
                  {r.label}
                  {r.note ? <em className="formula__note"> — {r.note}</em> : null}
                </span>
                <span className="formula__value">{formatNPRExact(r.cents)}</span>
              </div>
            ))}
            <div className="formula__row formula__row--result">
              <span className="formula__op" aria-hidden>
                =
              </span>
              <span className="formula__label">{f.resultLabel}</span>
              <span className="formula__value">{formatNPRExact(f.resultCents)}</span>
            </div>
          </div>

          {f.mismatch ? (
            // The page exists to catch exactly this: the number on screen and the
            // explanation of it have diverged. Never quietly reconcile it.
            <p className="calc-block__verdict calc-block__verdict--bad">
              <TriangleAlert size={13} strokeWidth={1.8} aria-hidden />
              These parts add up to {formatNPRExact(f.computedCents)}, but the API reports{' '}
              {formatNPRExact(f.resultCents)}. That is a bug — please report it.
            </p>
          ) : (
            <p className="calc-block__verdict calc-block__verdict--ok">
              <Check size={13} strokeWidth={2} aria-hidden />
              Checks out against your live figures.
            </p>
          )}
        </div>
      )}

      {figure.rows && (
        <div className="calc-block__math">
          <div className="formula__rows">
            {figure.rows.map((r) => (
              <div className="formula__row" key={r.label}>
                <span className="formula__op" aria-hidden />
                <span className="formula__label">
                  {r.label}
                  {r.note ? <em className="formula__note"> — {r.note}</em> : null}
                </span>
                <span className="formula__value">{r.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="calc-block__why">{figure.why}</div>

      <p className="calc-block__source">
        <span className="calc-block__source-tag">Where it comes from</span>
        {figure.source}
      </p>
    </section>
  );
}
