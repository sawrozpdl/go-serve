import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, AlertOctagon, ArrowRight, Check, Clock, X } from 'lucide-react';

import { useDecideInsight, type Insight } from '@/lib/api';
import { insightImproved } from '@cafe-mgmt/api-types';
import { formatNPR } from '@/components/Money';
import { toast } from '@/lib/toast';

// =========================================================================
// One finding, as the owner reads it.
//
// The DETAIL SENTENCE is the product. It arrives fully written and fully
// numbered from the detector — which is the only thing that knows which of its
// numbers matter — so this component renders it verbatim and never re-derives or
// re-formats what it says. That is also why there is no separate "metric" line:
// repeating the number beside the sentence that already contains it is how a
// screen ends up disagreeing with itself.
//
// The three controls are the whole decision model. There is deliberately no
// "assign to", no priority and no due-date picker beyond a few presets: nobody
// adopts a second task manager, and a café that runs on a paper notebook is not
// going to fill in a form.
// =========================================================================

/** SNOOZE_PRESETS / FOLLOW_UP_PRESETS are buttons, not a date picker. Choosing
 *  "next week" is one tap; choosing 2026-09-01 from a calendar is a chore, and
 *  the exact day almost never matters. */
const SNOOZE_PRESETS = [
  { days: 7, label: 'a week' },
  { days: 30, label: 'a month' },
];
const FOLLOW_UP_PRESETS = [
  { days: 7, label: 'in a week' },
  { days: 14, label: 'in 2 weeks' },
  { days: 30, label: 'in a month' },
];

/** formatMetric renders a bare metric for the then→now comparison only. Every
 *  other number the owner sees comes from the detector's own sentence. */
export function formatMetric(value: number, unit: Insight['metric_unit']): string {
  switch (unit) {
    case 'cents':
      return formatNPR(value);
    case 'ratio':
      return `${(value * 100).toFixed(value * 100 < 10 ? 1 : 0)}%`;
    case 'days':
      return `${Math.round(value)}d`;
    case 'minutes':
      return `${Math.round(value)} min`;
    default:
      return String(Math.round(value));
  }
}

function SeverityIcon({ severity }: { severity: Insight['severity'] }) {
  const Icon = severity === 'bad' ? AlertOctagon : AlertTriangle;
  return <Icon size={15} strokeWidth={2} aria-hidden="true" />;
}

/** Movement on an accepted finding. Silent when there is nothing to compare —
 *  a follow-up with no baseline must not imply progress either way. */
function Movement({ insight }: { insight: Insight }) {
  const improved = insightImproved(insight);
  if (improved === null || insight.then_value === null) {
    return (
      <span className="insight-move neutral">
        no change to compare yet
      </span>
    );
  }
  return (
    <span className={`insight-move ${improved ? 'better' : 'worse'}`}>
      {formatMetric(insight.then_value, insight.metric_unit)}
      <ArrowRight size={11} strokeWidth={2.5} aria-hidden="true" />
      {formatMetric(insight.metric_value, insight.metric_unit)}
      <span className="insight-move__verdict">
        {improved ? 'better' : 'not better'}
      </span>
    </span>
  );
}

type Props = {
  insight: Insight;
  /** Compact hides the controls — used by the dashboard strip, where the point
   *  is to notice the finding, not to act on it in passing. */
  compact?: boolean;
};

export function InsightCard({ insight, compact = false }: Props) {
  const [accepting, setAccepting] = useState(false);
  const [note, setNote] = useState('');
  const decide = useDecideInsight();

  const act = (action: Parameters<typeof decide.mutate>[0]['action'], said: string) => {
    decide.mutate(
      { id: insight.id, action },
      {
        onSuccess: () => {
          setAccepting(false);
          setNote('');
          toast.success(said);
        },
        onError: () => toast.error("That didn't save — try again."),
      },
    );
  };

  const busy = decide.isPending;

  return (
    <article className={`insight ${insight.severity}${compact ? ' compact' : ''}`}>
      <header className="insight__head">
        <span className={`insight__sev ${insight.severity}`}>
          <SeverityIcon severity={insight.severity} />
        </span>
        <h4 className="insight__label">{insight.subject_label || insight.label}</h4>
        {insight.state === 'accepted' && (
          <span className="pill ok" title={`Review on ${insight.follow_up_on}`}>
            reviewing
          </span>
        )}
        {insight.state === 'snoozed' && <span className="pill">snoozed</span>}
      </header>

      {/* Verbatim, always. */}
      <p className="insight__detail">{insight.detail}</p>

      {insight.state === 'accepted' && (
        <div className="insight__followup">
          <Movement insight={insight} />
          {insight.note && <span className="insight__note">“{insight.note}”</span>}
        </div>
      )}

      {!compact && (
        <footer className="insight__foot">
          {insight.deep_link && (
            <Link to={insight.deep_link} className="insight__link">
              Look at this <ArrowRight size={13} strokeWidth={2.5} aria-hidden="true" />
            </Link>
          )}

          {!accepting && (
            <div className="insight__actions">
              {insight.state !== 'accepted' && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => setAccepting(true)}
                >
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  I'll deal with this
                </button>
              )}
              {SNOOZE_PRESETS.map((p) => (
                <button
                  key={p.days}
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => act({ kind: 'snooze', days: p.days }, `Hidden for ${p.label}.`)}
                >
                  <Clock size={13} strokeWidth={2.5} aria-hidden="true" />
                  Not for {p.label}
                </button>
              ))}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() =>
                  act({ kind: 'dismiss' }, 'Dismissed. Three of these and we stop mentioning it.')
                }
              >
                <X size={13} strokeWidth={2.5} aria-hidden="true" />
                Not useful
              </button>
            </div>
          )}

          {accepting && (
            <div className="insight__accept">
              <label className="insight__accept-label" htmlFor={`note-${insight.id}`}>
                What are you going to do about it?{' '}
                <span className="muted">(optional — it shows up when we check back)</span>
              </label>
              <input
                id={`note-${insight.id}`}
                className="input"
                value={note}
                maxLength={280}
                placeholder="A note to yourself — optional"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="insight__accept-when">
                <span className="muted">Check back</span>
                {FOLLOW_UP_PRESETS.map((p) => (
                  <button
                    key={p.days}
                    type="button"
                    className="btn primary"
                    disabled={busy}
                    onClick={() =>
                      act(
                        { kind: 'accept', days: p.days, note },
                        `Noted. We'll show you whether it moved ${p.label}.`,
                      )
                    }
                  >
                    {p.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setAccepting(false);
                    setNote('');
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </footer>
      )}
    </article>
  );
}
