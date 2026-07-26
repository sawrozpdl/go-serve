import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Calculator, ShieldCheck } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { LoadingState } from '@/components/LoadingState';
import { EmptyState } from '@/components/EmptyState';
import {
  can,
  hasFeature,
  useCafeBalance,
  useCafeSummary,
  useMe,
  useProfitability,
  useReportsDashboard,
  useShiftSummary,
  useShifts,
  useTenantSettings,
} from '@/lib/api';
import { CalcBlock } from '@/guide/numbers/CalcBlock';
import { buildFigureSections } from '@/guide/numbers/figures';
import type { DashboardRange, ProfitRange } from '@cafe-mgmt/api-types';

/* "How your numbers are calculated" — the arithmetic behind every money figure
 * in GoServe, computed from THIS cafe's live data.
 *
 * The point is not documentation; a static explanation of a formula is easy to
 * write and impossible to trust. Here each derivation is re-added in front of
 * the operator, against the same API responses the Dashboard, Profitability,
 * Accounts and Shift pages read, and every block says whether it reconciles.
 * A figure whose explanation has drifted from the figure shows up as a warning
 * on this page rather than as a discrepancy someone finds months later.
 *
 * Each block carries the anchor `metric-<id>`, so the "Learn more →" links in
 * the InfoHint tooltips scattered across the app land on the matching figure.
 */

/* Only ranges that exist in BOTH DashboardRange and ProfitRange.
 *
 * This page puts the Dashboard's bottom line next to Profitability's and
 * accounts for the difference, so both reports must cover the same window. The
 * dashboard's "7d"/"30d" have no profitability equivalent — offering them would
 * have quietly compared two different periods and made the explanation of the
 * gap wrong, which is the one mistake this page cannot make. */
type CalcRange = Extract<DashboardRange, ProfitRange>;

const RANGES: { value: CalcRange; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'mtd', label: 'This month' },
  { value: 'ytd', label: 'This year' },
];

export function CalculationsPage() {
  const me = useMe();
  const [range, setRange] = useState<CalcRange>('mtd');
  const { hash } = useLocation();

  const mayReport = can(me.data, 'report:read');
  const mayFinance = can(me.data, 'finance:read');
  const mayShift = can(me.data, 'shift:read');
  const mayTenant = can(me.data, 'tenant:read');
  const hasProfit = hasFeature(me.data, 'profitability');

  // Each source is independent and gated on its own permission: the page is open
  // to every member, so a waiter sees the arithmetic for the figures their role
  // can see and no request is fired for the rest.
  const dash = useReportsDashboard(range, undefined, mayReport);
  const prof = useProfitability(range, undefined, mayReport && hasProfit);
  const balance = useCafeBalance(mayFinance);
  const summary = useCafeSummary(mayFinance);
  const shifts = useShifts(mayShift);
  const tenant = useTenantSettings(mayTenant);

  // The most recently closed shift is the useful one — it has a stamped
  // expected-cash figure and a real counted total to compare against. An open
  // shift's reconciliation doesn't exist until it closes.
  const lastClosed = useMemo(
    () => shifts.data?.find((s) => !!s.closed_at),
    [shifts.data],
  );
  const shiftSummary = useShiftSummary(mayShift ? lastClosed?.id : undefined);

  const sections = useMemo(
    () =>
      buildFigureSections({
        dash: mayReport ? dash.data : undefined,
        prof: mayReport && hasProfit ? prof.data : undefined,
        balance: mayFinance ? balance.data : undefined,
        summary: mayFinance ? summary.data : undefined,
        shift: mayShift ? shiftSummary.data : undefined,
      }),
    [
      mayReport,
      mayFinance,
      mayShift,
      hasProfit,
      dash.data,
      prof.data,
      balance.data,
      summary.data,
      shiftSummary.data,
    ],
  );

  // Deep links from the "Learn more →" tooltips arrive as …/numbers#metric-x.
  // Wait for the blocks to exist before scrolling, or the anchor isn't there yet.
  useEffect(() => {
    const anchor = hash.replace(/^#/, '');
    if (!anchor || !sections.length) return;
    requestAnimationFrame(() => {
      document.getElementById(anchor)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }, [hash, sections.length]);

  const loading =
    (mayReport && dash.isLoading) || (mayFinance && balance.isLoading) || me.isLoading;

  // Not `window` — that shadows the global.
  const windowLabel = dash.data
    ? `${fmtDay(dash.data.from)} – ${fmtDay(dash.data.to, true)} · ${dash.data.timezone}`
    : null;

  return (
    <PageShell
      eyebrow="Learn"
      title="How your numbers are calculated"
      subtitle="every money figure in GoServe, worked through with your cafe’s own data"
      docTitle="How the numbers work"
      actions={
        mayReport ? (
          <div className="filter-row" style={{ marginBottom: 0 }}>
            {RANGES.map((r) => (
              <button
                type="button"
                key={r.value}
                className={`chip ${range === r.value ? 'active' : ''}`}
                onClick={() => setRange(r.value)}
              >
                {r.label}
              </button>
            ))}
          </div>
        ) : undefined
      }
    >
      <div className="calc-intro">
        <p>
          <Calculator size={14} strokeWidth={1.7} aria-hidden /> Every figure below is
          read from your live data and then <strong>re-added in front of you</strong>. If
          a total and its parts ever disagree, this page says so — it does not quietly
          reconcile them.
        </p>
        {windowLabel && (
          <p className="calc-intro__window">
            Period figures cover <strong>{windowLabel}</strong>. The cafe balance is always
            live, whatever period is selected.
          </p>
        )}
        {mayTenant && tenant.data && (
          <p className="calc-intro__window">
            This cafe: VAT <strong>{vatLabel(tenant.data.vat_mode, tenant.data.vat_pct)}</strong>
            , service charge <strong>{tenant.data.service_charge_pct}%</strong>. Both change
            how the figures below break down.
          </p>
        )}
      </div>

      {loading && <LoadingState label="Reading your figures…" />}

      {!loading && sections.length === 0 && (
        <EmptyState
          title="No figures to show yet"
          hint="Once serves are settled — and if your role can see reports — the arithmetic behind every number appears here."
        />
      )}

      {sections.map((section) => (
        <section className="calc-section" key={section.id} id={`calc-${section.id}`}>
          <header className="calc-section__head">
            <h2 className="calc-section__title">{section.title}</h2>
            <p className="calc-section__blurb">{section.blurb}</p>
          </header>
          <div className="calc-section__blocks">
            {section.figures.map((figure) => (
              <CalcBlock figure={figure} key={figure.id} />
            ))}
          </div>
        </section>
      ))}

      {!loading && sections.length > 0 && <Conventions />}
    </PageShell>
  );
}

/** The rules that apply to every figure above, stated once. */
function Conventions() {
  return (
    <section className="calc-section" id="calc-conventions">
      <header className="calc-section__head">
        <h2 className="calc-section__title">
          <ShieldCheck size={15} strokeWidth={1.7} aria-hidden /> Rules that apply to every
          figure
        </h2>
        <p className="calc-section__blurb">
          Four conventions, applied everywhere, so two screens can’t disagree.
        </p>
      </header>
      <div className="calc-section__blocks">
        <section className="calc-block">
          <header className="calc-block__head">
            <h3 className="calc-block__title">One clock, one boundary</h3>
          </header>
          <div className="calc-block__why">
            <p>
              Every window runs in <strong>your cafe’s timezone</strong>, and every window
              is half-open: <code>from</code> is included, <code>to</code> is not. A serve
              closing at exactly midnight belongs to one day only — which is why each
              day’s figures add up to the month’s figure exactly, with nothing counted
              twice and nothing dropped.
            </p>
          </div>
        </section>

        <section className="calc-block">
          <header className="calc-block__head">
            <h3 className="calc-block__title">Each figure has one population</h3>
          </header>
          <div className="calc-block__why">
            <p>
              Sales-side figures count serves by <strong>close time</strong>, and only
              serves with status <code>closed</code>. Expense-side figures count by{' '}
              <strong>paid date</strong>, and ignore deleted rows. Credit collections
              count by <strong>when the money arrived</strong>. Those are three different
              clocks on purpose, because they answer three different questions.
            </p>
            <p>
              This is also why an open table shows nowhere in your sales: it hasn’t
              closed, so it has no place in the window yet.
            </p>
          </div>
        </section>

        <section className="calc-block">
          <header className="calc-block__head">
            <h3 className="calc-block__title">Round once, and make the parts sum</h3>
          </header>
          <div className="calc-block__why">
            <p>
              Money is stored in <strong>paisa as whole numbers</strong> — never as
              decimals, which drift. Figures are computed from those exact stored values,
              and any breakdown (per category, per channel, per day) is split using
              largest-remainder rounding.
            </p>
            <p>
              That is what guarantees the rows of a breakdown add up to its total{' '}
              <em>exactly</em>, with no stray paisa. A total that is off by one paisa from
              its parts is a bug, not a rounding fact of life.
            </p>
          </div>
        </section>

        <section className="calc-block">
          <header className="calc-block__head">
            <h3 className="calc-block__title">Closed means frozen</h3>
          </header>
          <div className="calc-block__why">
            <p>
              When a serve closes, its totals are written once and never recalculated.
              When a shift closes, its expected cash and variance are stamped and never
              revised. A correction is recorded as a new, visible entry — a reversal or an
              adjustment — rather than by editing history.
            </p>
            <p>
              So a report you read last month still says the same thing today, and any
              change to it is something you can point at.
            </p>
          </div>
        </section>
      </div>
    </section>
  );
}

function vatLabel(mode: string, pct: string): string {
  if (mode === 'none') return 'off';
  if (mode === 'inclusive') return `${pct}%, included in menu prices`;
  return `${pct}%, added at checkout`;
}

function fmtDay(iso: string, exclusiveEnd = false): string {
  const d = new Date(iso);
  // The window's end is exclusive, so the day a human would name is the one before.
  if (exclusiveEnd) d.setDate(d.getDate() - 1);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}
