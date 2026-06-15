import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Rocket, Plus, Trash2, CheckCircle2 } from 'lucide-react';

import { PageShell } from '@/components/PageShell';
import { LoadingState } from '@/components/LoadingState';
import { ErrorState } from '@/components/ErrorState';
import { formatNPR, parsePriceInput } from '@/components/Money';
import {
  useGoLive,
  useGoLiveStatus,
  useCafeOwners,
  useHouseTabs,
  useServiceTables,
  useMenuItems,
  type GoLivePayload,
} from '@/lib/api';

const cents = (s: string) => parsePriceInput(s) ?? 0;

type TabRow = { tableId: string; items: { menuItemId: string; qty: number }[] };

/** One-time wizard that seeds a fresh cafe's opening money state: cash in the
 *  drawer, bank/online balances, each owner's contributed capital + the cash
 *  they're holding, outstanding house-tab debts, and any currently-open
 *  customer tabs. Every figure becomes an opening ledger row server-side. */
export function GoLiveWizard() {
  const navigate = useNavigate();
  const status = useGoLiveStatus();
  const owners = useCafeOwners({ activeOnly: true });
  const tabs = useHouseTabs();
  const tables = useServiceTables();
  const menu = useMenuItems();
  const goLive = useGoLive();

  // --- Form state (rupee text; converted to paisa at submit) ---
  const [drawer, setDrawer] = useState('');
  const [bank, setBank] = useState('');
  const [online, setOnline] = useState('');
  const [ownerVals, setOwnerVals] = useState<Record<string, { invest: string; cash: string }>>({});
  const [tabVals, setTabVals] = useState<Record<string, string>>({});
  const [custTabs, setCustTabs] = useState<TabRow[]>([]);

  const setOwner = (id: string, key: 'invest' | 'cash', v: string) =>
    setOwnerVals((p) => ({ ...p, [id]: { invest: '', cash: '', ...p[id], [key]: v } }));

  const menuById = useMemo(() => {
    const m: Record<string, { name: string; price: number }> = {};
    (menu.data ?? []).forEach((mi) => (m[mi.id] = { name: mi.name, price: mi.price_cents }));
    return m;
  }, [menu.data]);

  const custTabTotal = (row: TabRow) =>
    row.items.reduce((sum, it) => sum + (menuById[it.menuItemId]?.price ?? 0) * it.qty, 0);

  const payload: GoLivePayload = useMemo(
    () => ({
      drawer_cents: cents(drawer),
      bank_cents: cents(bank),
      online_cents: cents(online),
      owners: (owners.data ?? [])
        .map((o) => ({
          owner_id: o.id,
          investment_cents: cents(ownerVals[o.id]?.invest ?? ''),
          cash_held_cents: cents(ownerVals[o.id]?.cash ?? ''),
        }))
        .filter((o) => o.investment_cents > 0 || o.cash_held_cents > 0),
      house_tabs: (tabs.data ?? [])
        .map((t) => ({ house_tab_id: t.id, outstanding_cents: cents(tabVals[t.id] ?? '') }))
        .filter((t) => t.outstanding_cents > 0),
      customer_tabs: custTabs
        .map((row) => ({
          service_table_id: row.tableId || null,
          items: row.items
            .filter((it) => it.menuItemId && it.qty > 0)
            .map((it) => ({ menu_item_id: it.menuItemId, qty: it.qty })),
        }))
        .filter((row) => row.items.length > 0),
    }),
    [drawer, bank, online, owners.data, ownerVals, tabs.data, tabVals, custTabs],
  );

  if (status.isPending || owners.isPending) return <LoadingState />;
  if (status.isError) return <ErrorState hint={status.error?.message} onRetry={() => status.refetch()} />;

  // Already live → nothing to seed.
  if (status.data?.went_live_at) {
    return (
      <PageShell eyebrow="Setup" title="Go live">
        <section className="panel" style={{ textAlign: 'center', padding: 40 }}>
          <CheckCircle2 size={32} strokeWidth={1.6} style={{ color: 'var(--lime-fg)' }} />
          <h3 style={{ marginTop: 12 }}>This cafe is already live</h3>
          <p className="hint">Opening balances were seeded on {new Date(status.data.went_live_at).toLocaleString()}. The wizard runs only once.</p>
        </section>
      </PageShell>
    );
  }

  const assetTotal = payload.drawer_cents + payload.bank_cents + payload.online_cents +
    payload.owners.reduce((s, o) => s + o.cash_held_cents, 0);
  const investTotal = payload.owners.reduce((s, o) => s + o.investment_cents, 0);
  const receivables = payload.house_tabs.reduce((s, t) => s + t.outstanding_cents, 0) +
    payload.customer_tabs.reduce((s, r) => s + r.items.reduce((x, it) => x + (menuById[it.menu_item_id]?.price ?? 0) * it.qty, 0), 0);

  const submit = () =>
    goLive.mutate(payload, {
      onSuccess: () => navigate('/admin/owners'),
    });

  return (
    <PageShell
      eyebrow="Setup"
      title="Go live"
      subtitle="Enter your real-world money state to start fresh. This runs once."
      footer={
        <div className="savebar">
          <span className={goLive.isError ? 'banner-error' : 'muted'} style={{ margin: 0, flex: 1 }}>
            {goLive.isError
              ? (goLive.error?.message ?? 'Something went wrong')
              : `Assets ${formatNPR(assetTotal)} · Capital ${formatNPR(investTotal)} · Owed to cafe ${formatNPR(receivables)}`}
          </span>
          <button className="btn primary" disabled={goLive.isPending} onClick={submit}>
            <Rocket size={15} strokeWidth={1.7} style={{ marginRight: 6 }} />
            {goLive.isPending ? 'Going live…' : 'Go live'}
          </button>
        </div>
      }
    >
      <div className="banner-info" style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <Rocket size={16} strokeWidth={1.7} />
        <span>Leave anything you don't track at 0. You can record real transactions normally after going live — this only sets the starting point.</span>
      </div>

      {/* Cash & accounts */}
      <section className="panel">
        <div className="panel-head"><h3>Cash &amp; accounts</h3></div>
        <div className="field">
          <label>Cash in drawer now</label>
          <input inputMode="decimal" value={drawer} onChange={(e) => setDrawer(e.target.value)} placeholder="0" />
          <p className="hint">Opens your first shift with this float.</p>
        </div>
        <div className="field">
          <label>Bank balance</label>
          <input inputMode="decimal" value={bank} onChange={(e) => setBank(e.target.value)} placeholder="0" />
        </div>
        <div className="field">
          <label>Online / wallet balance (eSewa, Khalti, card…)</label>
          <input inputMode="decimal" value={online} onChange={(e) => setOnline(e.target.value)} placeholder="0" />
        </div>
      </section>

      {/* Owners */}
      <section className="panel">
        <div className="panel-head"><h3>Owners</h3></div>
        {(owners.data ?? []).length === 0 ? (
          <p className="hint">No owners yet — add them in the Owners page first if you want to record capital.</p>
        ) : (
          (owners.data ?? []).map((o) => (
            <div key={o.id} className="field">
              <label>{o.display_name}</label>
              <div className="super-inline">
                <input inputMode="decimal" value={ownerVals[o.id]?.invest ?? ''} onChange={(e) => setOwner(o.id, 'invest', e.target.value)} placeholder="capital invested" />
                <input inputMode="decimal" value={ownerVals[o.id]?.cash ?? ''} onChange={(e) => setOwner(o.id, 'cash', e.target.value)} placeholder="cash they hold" />
              </div>
            </div>
          ))
        )}
        <p className="hint">Capital invested feeds equity / ROI. Cash they hold is cafe cash in the owner's pocket (not the drawer).</p>
      </section>

      {/* House tabs */}
      {(tabs.data ?? []).length > 0 && (
        <section className="panel">
          <div className="panel-head"><h3>House tabs owed to the cafe</h3></div>
          {(tabs.data ?? []).map((t) => (
            <div key={t.id} className="field">
              <label>{t.name}</label>
              <input inputMode="decimal" value={tabVals[t.id] ?? ''} onChange={(e) => setTabVals((p) => ({ ...p, [t.id]: e.target.value }))} placeholder="0" />
            </div>
          ))}
        </section>
      )}

      {/* Open customer tabs */}
      <section className="panel">
        <div className="panel-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3>Open customer tabs</h3>
          <button className="btn" onClick={() => setCustTabs((p) => [...p, { tableId: '', items: [{ menuItemId: '', qty: 1 }] }])}>
            <Plus size={14} strokeWidth={1.8} style={{ marginRight: 4 }} /> Add tab
          </button>
        </div>
        {custTabs.length === 0 && <p className="hint">Add a tab for any table that currently owes for un-paid items.</p>}
        {custTabs.map((row, ri) => (
          <div key={ri} className="panel" style={{ marginTop: 10, background: 'var(--surface-2, transparent)' }}>
            <div className="field">
              <label>Table (optional — leave blank for takeaway)</label>
              <select value={row.tableId} onChange={(e) => setCustTabs((p) => p.map((r, i) => i === ri ? { ...r, tableId: e.target.value } : r))}>
                <option value="">— none —</option>
                {(tables.data ?? []).map((tb) => <option key={tb.id} value={tb.id}>{tb.name}</option>)}
              </select>
            </div>
            {row.items.map((it, ii) => (
              <div key={ii} className="super-inline" style={{ marginBottom: 6 }}>
                <select value={it.menuItemId} onChange={(e) => setCustTabs((p) => p.map((r, i) => i === ri ? { ...r, items: r.items.map((x, j) => j === ii ? { ...x, menuItemId: e.target.value } : x) } : r))}>
                  <option value="">— pick item —</option>
                  {(menu.data ?? []).map((mi) => <option key={mi.id} value={mi.id}>{mi.name} · {formatNPR(mi.price_cents)}</option>)}
                </select>
                <input type="number" min={1} value={it.qty} style={{ maxWidth: 80 }} onChange={(e) => setCustTabs((p) => p.map((r, i) => i === ri ? { ...r, items: r.items.map((x, j) => j === ii ? { ...x, qty: Math.max(1, Number(e.target.value)) } : x) } : r))} />
                <button className="btn icon" title="Remove item" onClick={() => setCustTabs((p) => p.map((r, i) => i === ri ? { ...r, items: r.items.filter((_, j) => j !== ii) } : r))}>
                  <Trash2 size={13} strokeWidth={1.7} />
                </button>
              </div>
            ))}
            <div className="super-inline" style={{ justifyContent: 'space-between', marginTop: 6 }}>
              <button className="btn" onClick={() => setCustTabs((p) => p.map((r, i) => i === ri ? { ...r, items: [...r.items, { menuItemId: '', qty: 1 }] } : r))}>
                <Plus size={13} strokeWidth={1.8} style={{ marginRight: 4 }} /> Add item
              </button>
              <span className="muted">Tab total {formatNPR(custTabTotal(row))}</span>
              <button className="btn danger" onClick={() => setCustTabs((p) => p.filter((_, i) => i !== ri))}>Remove tab</button>
            </div>
          </div>
        ))}
      </section>
    </PageShell>
  );
}
