import { useMemo } from 'react';

import { useAdminFeatures, useAdminSetFeatures, type AdminTenantDetail, type AdminPlan } from '@/lib/api';
import { RotateCcw } from 'lucide-react';

// Per-tenant feature editor. Effective-checkbox model: the plan's own features
// form the baseline; ticking/unticking computes the minimal grant/revoke delta
// vs that baseline (billing.ComputeState applies grant - revoke on top of the
// plan). A dot + "reset to plan" appears whenever a feature differs from the
// plan default. Overrides are ignored while the tenant is trialing.
export function FeaturesTab({ id, t, plans }: { id: string; t: AdminTenantDetail; plans: AdminPlan[] }) {
  const features = useAdminFeatures();
  const setFeatures = useAdminSetFeatures(id);

  const plan = plans.find((p) => p.key === t.plan_key);
  const base = useMemo(() => new Set(plan?.features ?? []), [plan]);

  // Depend on the field itself, not on a `?? {}` fallback: that expression
  // builds a fresh object every render, so both memos below re-ran every time
  // and the Set identities churned.
  const grant = useMemo(() => new Set(t.feature_overrides?.grant ?? []), [t.feature_overrides]);
  const revoke = useMemo(() => new Set(t.feature_overrides?.revoke ?? []), [t.feature_overrides]);

  const trialing = !!t.trial_ends_at && new Date(t.trial_ends_at).getTime() > Date.now();

  const defs = features.data?.features ?? [];
  const isEffective = (key: string) => (base.has(key) || grant.has(key)) && !revoke.has(key);
  const isOverridden = (key: string) => isEffective(key) !== base.has(key);

  // Recompute overrides from a full desired-effective set (minimal delta vs the
  // plan baseline), then persist. Called for every toggle / reset so the two
  // override lists never accumulate stale entries.
  const applyEffective = (nextEffective: Set<string>) => {
    const newGrant: string[] = [];
    const newRevoke: string[] = [];
    for (const fd of defs) {
      const eff = nextEffective.has(fd.key);
      if (eff && !base.has(fd.key)) newGrant.push(fd.key);
      else if (!eff && base.has(fd.key)) newRevoke.push(fd.key);
    }
    setFeatures.mutate({ grant: newGrant, revoke: newRevoke });
  };

  const currentEffective = () => new Set(defs.filter((fd) => isEffective(fd.key)).map((fd) => fd.key));

  const toggle = (key: string) => {
    const next = currentEffective();
    if (next.has(key)) next.delete(key);
    else next.add(key);
    applyEffective(next);
  };

  const reset = (key: string) => {
    const next = currentEffective();
    if (base.has(key)) next.add(key);
    else next.delete(key);
    applyEffective(next);
  };

  if (features.isPending || !plan) return <section className="panel"><div className="empty-state">Loading…</div></section>;
  if (features.isError) return <section className="panel"><div className="banner-error">{features.error?.message ?? 'Could not load features'}</div></section>;

  // Group defs by their registry group, preserving registry order.
  const groups: { name: string; items: typeof defs }[] = [];
  for (const fd of defs) {
    let g = groups.find((x) => x.name === fd.group);
    if (!g) { g = { name: fd.group, items: [] }; groups.push(g); }
    g.items.push(fd);
  }

  return (
    <section className="panel">
      <div className="panel-head"><h3>Features</h3></div>
      <p className="hint">
        The <strong>{t.plan_name}</strong> plan sets the baseline. Tick or untick to grant or revoke a
        feature for <strong>just this tenant</strong>; a dot marks anything overridden from the plan default.
      </p>
      {trialing && (
        <p className="banner-info" style={{ marginTop: 8 }}>
          This tenant is trialing — <strong>all</strong> features are active until the trial ends, regardless
          of these settings. The overrides take effect once the trial is over.
        </p>
      )}
      {setFeatures.isError && <p className="banner-error" style={{ marginTop: 8 }}>{setFeatures.error?.message}</p>}

      <div style={{ display: 'grid', gap: 'var(--space-4)', marginTop: 'var(--space-3)' }}>
        {groups.map((g) => (
          <div key={g.name}>
            <div className="muted" style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{g.name}</div>
            <div className="super-checks">
              {g.items.map((fd) => {
                const overridden = isOverridden(fd.key);
                return (
                  <label key={fd.key} className="super-check" title={fd.desc}>
                    <input
                      type="checkbox"
                      checked={isEffective(fd.key)}
                      disabled={setFeatures.isPending}
                      onChange={() => toggle(fd.key)}
                    />
                    <span>{fd.label}</span>
                    {base.has(fd.key) && !overridden && <span className="muted" style={{ fontSize: 11 }}>· from plan</span>}
                    {overridden && (
                      <>
                        <span title="Overridden from the plan default" style={{ color: 'var(--amber-fg)', fontSize: 11 }}>● overridden</span>
                        <button
                          type="button"
                          className="btn"
                          style={{ padding: '2px 6px', fontSize: 11 }}
                          disabled={setFeatures.isPending}
                          onClick={() => reset(fd.key)}
                        >
                          <RotateCcw size={11} strokeWidth={1.8} style={{ marginRight: 2 }} /> reset
                        </button>
                      </>
                    )}
                  </label>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

