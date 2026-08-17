import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { QueryState } from '@/components/QueryState';
import { SaveBar } from '@/components/SaveBar';
import { SearchSelect } from '@/components/SearchSelect';
import { formatNPR, parsePriceInput } from '@/components/Money';
import { useMenuItems } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { toast } from '@/lib/toast';
import { useEngageCampaign, useSaveEngageTiers } from '@/lib/engage';
import { toDraft, validateLadder, worstCase, type Draft } from './ladder';

// =========================================================================
// Rewards tab — the ladder the guest climbs, edited in the same shape they
// will see it.
//
// No drag-and-drop: rows re-sort by threshold on save. Dragging fights the
// SaveBar model and is miserable on a touch device, and the ordering is fully
// determined by a number the owner is already typing.
// =========================================================================

const KINDS: { value: Draft['reward_kind']; label: string }[] = [
  { value: 'percent', label: '% off' },
  { value: 'flat', label: 'Amount off' },
  { value: 'free_item', label: 'Free item' },
  { value: 'none', label: 'Nothing (consolation)' },
];

export function RewardsPage() {
  const { can } = usePermissions();
  const q = useEngageCampaign();
  const save = useSaveEngageTiers();
  const items = useMenuItems();
  const editable = can('engage:update');

  const [rows, setRows] = useState<Draft[]>([]);
  const hydrated = useRef(false);

  useEffect(() => {
    if (!q.data || hydrated.current) return;
    hydrated.current = true;
    setRows(q.data.tiers.map(toDraft));
  }, [q.data]);

  const savedRows = (q.data?.tiers ?? []).map(toDraft);
  const dirty = JSON.stringify(rows) !== JSON.stringify(savedRows);
  const problem = validateLadder(rows);
  const winners = rows.filter((r) => r.reward_kind !== 'none').length;

  const update = (i: number, patch: Partial<Draft>) =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) {
      toast.error('Check the ladder', problem);
      return;
    }
    try {
      await save.mutateAsync(rows);
      toast.success('Rewards saved');
    } catch (err) {
      toast.error('Could not save', (err as Error).message);
    }
  };

  return (
    <PageShell
      eyebrow="grow"
      title="Engage"
      docTitle="Engage · Rewards"
      footer={
        editable ? (
          <SaveBar
            dirty={dirty}
            submitButton={
              <button type="submit" form="engage-tiers" className="btn primary" disabled={save.isPending || !!problem}>
                {save.isPending ? 'Saving…' : 'Save rewards'}
              </button>
            }
          />
        ) : undefined
      }
    >
      <QueryState isPending={q.isPending} isError={q.isError} error={q.error} refetch={q.refetch}>
        {!q.data?.campaign ? (
          <div className="panel">
            <p className="engage-hint">Save a campaign first, then set what guests can win.</p>
          </div>
        ) : (
          <form id="engage-tiers" onSubmit={submit} className="engage-form">
              <section className="panel">
                <div className="panel-head">
                  <h3>The ladder</h3>
                  <span className="meta">{rows.length} tier(s)</span>
                </div>
                <p className="engage-hint">
                  A guest wins the highest tier their score reaches. Add a "nothing" tier at 0 if you want a
                  kind message for everyone else.
                </p>

                {rows.length === 0 && <p className="engage-hint">No rewards yet — nobody can win.</p>}

                <div className="engage-tiers">
                  {rows.map((r, i) => (
                    <div key={i} className="engage-tier">
                      <label className="field engage-tier__score">
                        <span className="field-label">Score ≥</span>
                        <input
                          inputMode="numeric"
                          value={String(r.min_score)}
                          onChange={(e) => update(i, { min_score: Number(e.target.value) || 0 })}
                          disabled={!editable}
                        />
                      </label>

                      <label className="field engage-tier__label">
                        <span className="field-label">Guest sees</span>
                        <input
                          value={r.label}
                          onChange={(e) => update(i, { label: e.target.value })}
                          disabled={!editable}
                          maxLength={80}
                          placeholder="10% off your bill"
                        />
                      </label>

                      <label className="field engage-tier__kind">
                        <span className="field-label">Reward</span>
                        <select
                          value={r.reward_kind}
                          onChange={(e) =>
                            update(i, {
                              reward_kind: e.target.value as Draft['reward_kind'],
                              percent_bp: null,
                              amount_cents: null,
                              menu_item_id: null,
                              max_discount_cents: null,
                            })
                          }
                          disabled={!editable}
                        >
                          {KINDS.map((k) => (
                            <option key={k.value} value={k.value}>
                              {k.label}
                            </option>
                          ))}
                        </select>
                      </label>

                      {r.reward_kind === 'percent' && (
                        <>
                          <label className="field engage-tier__val">
                            <span className="field-label">Percent</span>
                            <input
                              inputMode="decimal"
                              value={r.percent_bp != null ? String(r.percent_bp / 100) : ''}
                              onChange={(e) =>
                                update(i, { percent_bp: e.target.value ? Math.round(Number(e.target.value) * 100) : null })
                              }
                              disabled={!editable}
                            />
                          </label>
                          <label className="field engage-tier__val">
                            <span className="field-label">Max off</span>
                            <input
                              inputMode="decimal"
                              value={r.max_discount_cents != null ? String(r.max_discount_cents / 100) : ''}
                              onChange={(e) =>
                                update(i, { max_discount_cents: e.target.value ? parsePriceInput(e.target.value) : null })
                              }
                              disabled={!editable}
                            />
                          </label>
                        </>
                      )}

                      {r.reward_kind === 'flat' && (
                        <label className="field engage-tier__val">
                          <span className="field-label">Amount</span>
                          <input
                            inputMode="decimal"
                            value={r.amount_cents != null ? String(r.amount_cents / 100) : ''}
                            onChange={(e) =>
                              update(i, { amount_cents: e.target.value ? parsePriceInput(e.target.value) : null })
                            }
                            disabled={!editable}
                          />
                        </label>
                      )}

                      {r.reward_kind === 'free_item' && (
                        <label className="field engage-tier__item">
                          <span className="field-label">Item</span>
                          <SearchSelect
                            value={r.menu_item_id ?? ''}
                            onChange={(v) => update(i, { menu_item_id: v || null })}
                            options={(items.data ?? []).map((m) => ({ value: m.id, label: m.name }))}
                            placeholder="Pick an item"
                          />
                        </label>
                      )}

                      {editable && (
                        <button
                          type="button"
                          className="btn icon danger"
                          aria-label="remove tier"
                          onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                        >
                          <Trash2 size={14} strokeWidth={1.6} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {editable && (
                  <button
                    type="button"
                    className="discount-add"
                    onClick={() =>
                      setRows((rs) => [
                        ...rs,
                        {
                          min_score: (rs.reduce((m, r) => Math.max(m, r.min_score), 0) || 0) + 10,
                          label: '',
                          reward_kind: 'percent',
                          percent_bp: 1000,
                          amount_cents: null,
                          menu_item_id: null,
                          max_discount_cents: 20000,
                        },
                      ])
                    }
                  >
                    <Plus size={14} strokeWidth={1.8} /> Add a tier
                  </button>
                )}

                {problem && <p className="engage-error">{problem}</p>}
                {!problem && winners === 0 && rows.length > 0 && (
                  <p className="engage-error">
                    Every tier is a consolation — as configured, no guest can ever win anything.
                  </p>
                )}
              </section>

              {/* What it could cost, at the worst case the caps are enforced
                  against. An owner setting thresholds without this is guessing. */}
              <section className="panel">
                <div className="panel-head">
                  <h3>Worst case</h3>
                </div>
                <p className="engage-hint">
                  If every guest cleared your top tier, each reward would cost up to{' '}
                  <strong className="num">{formatNPR(worstCase(rows))}</strong>. Your daily budget cap on the
                  Campaign tab is what actually bounds the spend.
                </p>
              </section>
          </form>
        )}
      </QueryState>
    </PageShell>
  );
}
