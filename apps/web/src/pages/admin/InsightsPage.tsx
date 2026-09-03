import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, ArrowRight } from 'lucide-react';

import { useInsights, type Insight } from '@/lib/api';
import { PageShell } from '@/components/PageShell';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { InsightCard } from '@/components/InsightCard';

// =========================================================================
// Findings — everything the café has been told, and what it decided.
//
// The list arrives already filtered per recipient and ranked worst-first by the
// server, using the same code the morning brief uses. It is rendered IN THAT
// ORDER: the ranking is an editorial judgement written down once on the backend,
// and re-sorting here would mean the email and the page disagreed about what
// matters. There are no filter controls for the same reason — a findings list
// short enough to read does not need faceting, and one long enough to need it
// would mean the detectors are too noisy.
// =========================================================================

/** Books Confidence, in words. The honest alternative to attaching a made-up
 *  confidence interval to a forecast: describe what we actually know.
 *
 *  null is a real answer, and it must never render as 0% — that reads as an
 *  accusation against a café that simply hasn't recorded much yet. */
function Confidence({ value }: { value: number | null }) {
  if (value === null) {
    return (
      <section className="panel insight-confidence unknown">
        <ShieldCheck size={18} strokeWidth={1.6} aria-hidden="true" />
        <div>
          <strong>Not enough recorded yet</strong>
          <p>
            Once you have a few weeks of sales, costs and shift closes, we can tell you how much of
            your own numbers we can vouch for.
          </p>
        </div>
      </section>
    );
  }
  const pct = Math.round(value * 100);
  const tone = pct >= 90 ? 'ok' : pct >= 60 ? 'warn' : 'bad';
  return (
    <section className={`panel insight-confidence ${tone}`}>
      <ShieldCheck size={18} strokeWidth={1.6} aria-hidden="true" />
      <div>
        <strong>
          Your books are <span className="insight-confidence__pct">{pct}%</span> complete
        </strong>
        <p>
          {pct >= 90
            ? 'These numbers can be taken at face value.'
            : pct >= 60
              ? 'The gaps below make profit read higher than it really is.'
              : 'Treat any profit figure as a rough guide until the gaps below are filled.'}{' '}
          <Link to="/admin/learn/numbers">See how each number is worked out</Link>.
        </p>
      </div>
    </section>
  );
}

/** Nothing to report is the GOOD outcome, and it has to look like one. An empty
 *  state that reads as a failure teaches people the feature is broken. */
function AllClear() {
  return (
    <section className="panel insight-clear">
      <ShieldCheck size={26} strokeWidth={1.5} aria-hidden="true" />
      <h3>Nothing needs your attention</h3>
      <p>
        We check your books every night — the takings, the drawer, your margins, your credit and
        your stock. When something does not add up, or when money is quietly going somewhere it
        should not, it shows up here and in your morning email.
      </p>
      <p className="muted">A quiet page means a well-run café, not a broken check.</p>
    </section>
  );
}

export function InsightsPage() {
  const q = useInsights();

  const groups = useMemo(() => {
    const all = q.data?.insights ?? [];
    // Accepted findings are separated out because they are a different KIND of
    // thing to read: not "look at this" but "you said you would, here is
    // whether it moved". Order within each group is the server's.
    return {
      open: all.filter((i: Insight) => i.state !== 'accepted'),
      accepted: all.filter((i: Insight) => i.state === 'accepted'),
    };
  }, [q.data]);

  return (
    <PageShell
      eyebrow="Money truth"
      title="Findings"
      subtitle="What we noticed in your books overnight, worst first."
    >
      {q.isLoading && <LoadingState label="Checking your books…" />}
      {q.isError && (
        <ErrorState
          title="Couldn't load your findings"
          hint="The nightly check may not have run yet."
          onRetry={() => q.refetch()}
        />
      )}

      {q.data && (
        <>
          <Confidence value={q.data.books_confidence} />

          {groups.open.length === 0 && groups.accepted.length === 0 && <AllClear />}

          {groups.open.length > 0 && (
            <div className="insight-list">
              {groups.open.map((i) => (
                <InsightCard key={i.id} insight={i} />
              ))}
            </div>
          )}

          {groups.accepted.length > 0 && (
            <section style={{ marginTop: 'var(--space-6)' }}>
              <h3 className="insight-group-title">You said you'd deal with these</h3>
              <div className="insight-list">
                {groups.accepted.map((i) => (
                  <InsightCard key={i.id} insight={i} />
                ))}
              </div>
            </section>
          )}

          <p className="insight-foot muted">
            Findings you dismiss stop appearing. Dismiss the same kind three times and we stop
            raising it for this café at all.{' '}
            <Link to="/admin/learn/numbers">
              How your numbers are worked out <ArrowRight size={12} strokeWidth={2.5} />
            </Link>
          </p>
        </>
      )}
    </PageShell>
  );
}

export default InsightsPage;
