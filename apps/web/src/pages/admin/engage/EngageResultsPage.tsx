import { useState } from 'react';

import { EmptyState } from '@/components/EmptyState';
import { InfoHint } from '@/components/InfoHint';
import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { formatNPR } from '@/components/Money';
import { CHART_PALETTE } from '@/lib/chartColors';
import {
  useEngageCampaign,
  useEngageStats,
  useEngageTimeseries,
  type EngageDay,
  type EngageStats,
} from '@/lib/engage';

// =========================================================================
// Results tab.
//
// Charts are hand-rolled SVG/CSS — this repo has no chart library and is not
// getting one for this. Every figure carries what it actually means: several of
// these are easy to read as something stronger than they are, which is exactly
// why the API ships its caveats in the payload.
// =========================================================================

const RANGES = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
];

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function EngageResultsPage() {
  const [range, setRange] = useState('30d');
  const campaign = useEngageCampaign();
  const stats = useEngageStats(range);
  const series = useEngageTimeseries(range);
  const s = stats.data;

  return (
    <PageShell
      eyebrow="grow"
      title="Engage"
      docTitle="Engage · Results"
      actions={
        <div className="engage-ranges">
          {RANGES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`btn small${range === r.key ? ' primary' : ''}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
      }
    >
      <QueryState
        isPending={stats.isPending}
        isError={stats.isError}
        error={stats.error}
        refetch={stats.refetch}
      >
        {!s ? null : s.funnel.scans === 0 ? (
          <EmptyState
            title="Nobody has scanned yet"
            hint="The commonest reason a campaign goes nowhere is that the table tents never got printed. Head to the Campaign tab and print some."
          />
        ) : (
          <>
            <div className="kpis">
              <Kpi label="Scans" value={String(s.funnel.scans)}>
                {s.funnel.scan_loads} page loads. Counted once per guest per day, so this means guests rather
                than refreshes.
              </Kpi>
              <Kpi label="Finished a game" value={pct(s.rates.completion)}>
                {s.funnel.completed} of {s.funnel.started} runs were played to the end.
              </Kpi>
              <Kpi label="Won something" value={pct(s.rates.win)}>
                {s.funnel.won} rewards issued. Practice runs are left out of this — they can never win, so
                counting them would make a healthy campaign look broken.
              </Kpi>
              <Kpi label="Redeemed" value={pct(s.rates.redemption)}>
                {s.funnel.redeemed} of {s.funnel.won} issued, counted against the day they were WON.{' '}
                {s.in_flight_codes} are still inside their window. A low number usually means guests are
                winning but not reaching the counter in time.
              </Kpi>
              <Kpi label="Came back" value={s.rates.returning == null ? '—' : pct(s.rates.returning)}>
                {s.rates.returning == null
                  ? 'Needs at least a week of data before this means anything.'
                  : 'Share of devices that played on two or more different days. It counts DEVICES, not people — someone who plays but never orders is not a proven visit, and one guest with two phones counts twice.'}
              </Kpi>
              <Kpi label="Reward cost" value={formatNPR(s.value_redeemed_cents)}>
                {formatNPR(s.value_issued_cents)} was promised; this is what actually came off bills.
              </Kpi>
            </div>

            <section className="panel">
              <div className="panel-head">
                <h3>From scan to till</h3>
              </div>
              <Funnel s={s} />
            </section>

            <section className="panel">
              <div className="panel-head">
                <h3>Scores</h3>
                <span className="meta">and where your thresholds sit</span>
              </div>
              <p className="engage-hint">
                The most useful chart here: if a hump of players sits just under a threshold, move the
                threshold rather than the reward.
              </p>
              <ScoreHistogram
                bins={s.score_histogram}
                thresholds={(campaign.data?.tiers ?? []).map((t) => t.min_score)}
              />
            </section>

            <section className="panel">
              <div className="panel-head">
                <h3>By day</h3>
                <span className="meta">played · redeemed</span>
              </div>
              <QueryState
                isPending={series.isPending}
                isError={series.isError}
                error={series.error}
                refetch={series.refetch}
                compact
              >
                <DayChart days={series.data?.days ?? []} />
              </QueryState>
            </section>

            <section className="panel">
              <div className="panel-head">
                <h3>Average bill</h3>
                <InfoHint label="How this is worked out">
                  {s.spend_lift.caveats.join(' ')}
                </InfoHint>
              </div>
              <div className="engage-lift">
                <div>
                  <div className="engage-lift__label">With a reward</div>
                  <div className="engage-lift__val num">{formatNPR(s.spend_lift.avg_with_subtotal_cents)}</div>
                  <div className="engage-lift__sub">{s.spend_lift.with_reward_orders} bills</div>
                </div>
                <div>
                  <div className="engage-lift__label">Without</div>
                  <div className="engage-lift__val num">
                    {formatNPR(s.spend_lift.avg_without_subtotal_cents)}
                  </div>
                  <div className="engage-lift__sub">{s.spend_lift.without_reward_orders} bills</div>
                </div>
              </div>
              {/* Said plainly on the page, not hidden in a tooltip — this is the
                  figure most likely to be read as more than it is. */}
              <p className="engage-hint">
                Compared before discounts, so the reward itself doesn't drag its own number down. This is an
                association, not proof: guests who play and redeem chose to, and may already have been your
                bigger spenders.
              </p>
            </section>

            {s.flagged_runs > 0 && (
              <section className="panel">
                <div className="panel-head">
                  <h3>Rejected runs</h3>
                  <span className="meta">{s.flagged_runs}</span>
                </div>
                <p className="engage-hint">
                  Scores that couldn't have happened — usually someone poking at the page rather than playing
                  it. No reward was issued for any of them.
                </p>
              </section>
            )}
          </>
        )}
      </QueryState>
    </PageShell>
  );
}

function Kpi({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="kpi">
      <div className="label">
        {label} <InfoHint>{children}</InfoHint>
      </div>
      <div className="value num">{value}</div>
    </div>
  );
}

/** CSS-width bars, the same idiom the dashboard's charts already use. */
function Funnel({ s }: { s: EngageStats }) {
  const steps = [
    { label: 'Scanned', n: s.funnel.scans },
    { label: 'Started a game', n: s.funnel.started },
    { label: 'Finished', n: s.funnel.completed },
    { label: 'Won', n: s.funnel.won },
    { label: 'Redeemed', n: s.funnel.redeemed },
  ];
  const top = Math.max(1, steps[0]?.n ?? 1);
  return (
    <div className="engage-funnel">
      {steps.map((st, i) => {
        const prev = steps[i - 1]?.n;
        const drop = prev && prev > 0 ? 1 - st.n / prev : null;
        return (
          <div key={st.label} className="engage-funnel__row">
            <div className="engage-funnel__bar" style={{ width: `${Math.max(6, (st.n / top) * 100)}%` }}>
              <span className="engage-funnel__label">{st.label}</span>
              <span className="engage-funnel__n num">{st.n}</span>
            </div>
            {/* The drop-off between steps is the actionable part — where guests
                are being lost, not just how many are left. */}
            {drop != null && drop > 0 && (
              <span className="engage-funnel__drop num">−{Math.round(drop * 100)}%</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function ScoreHistogram({
  bins,
  thresholds,
}: {
  bins: { bucket: number; count: number }[];
  thresholds: number[];
}) {
  if (bins.length === 0) return <p className="engage-hint">No finished games yet.</p>;
  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const maxBucket = Math.max(...bins.map((b) => b.bucket), ...thresholds, 1);
  const W = 320;
  const H = 120;
  const bw = W / bins.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="engage-hist" role="img" aria-label="Distribution of scores">
      {bins.map((b, i) => {
        const h = (b.count / maxCount) * (H - 22);
        return (
          <rect
            key={b.bucket}
            x={i * bw + 1}
            y={H - h}
            width={Math.max(1, bw - 2)}
            height={h}
            fill={CHART_PALETTE[0]}
            opacity={0.85}
          />
        );
      })}
      {/* A dashed line per configured threshold, so the gap between where people
          actually score and what you're asking for is visible at a glance. */}
      {thresholds.map((t) => {
        const x = Math.min(W - 1, (t / maxBucket) * W);
        return (
          <g key={t}>
            <line x1={x} y1={0} x2={x} y2={H} stroke={CHART_PALETTE[1]} strokeWidth={1} strokeDasharray="3 3" />
            <text x={x + 3} y={11} fontSize={9} fill={CHART_PALETTE[1]}>
              {t}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function DayChart({ days }: { days: EngageDay[] }) {
  if (days.length === 0) return <p className="engage-hint">No days in this range.</p>;
  const max = Math.max(...days.map((d) => Math.max(d.started, d.redeemed)), 1);
  return (
    <div className="engage-days-chart">
      {days.map((d) => (
        <div
          key={d.day}
          className="engage-day"
          title={`${d.day}: ${d.started} played, ${d.redeemed} redeemed`}
        >
          <div className="engage-day__bars">
            <div
              className="engage-day__bar"
              style={{ height: `${(d.started / max) * 100}%`, background: CHART_PALETTE[0] }}
            />
            <div
              className="engage-day__bar"
              style={{ height: `${(d.redeemed / max) * 100}%`, background: CHART_PALETTE[1] }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
