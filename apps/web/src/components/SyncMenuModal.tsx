import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, AlertTriangle, Send } from 'lucide-react';
import type { MenuSyncResponse, MenuSyncTarget } from '@cafe-mgmt/api-types';

import { Modal } from '@/components/Modal';
import { formatNPR } from '@/components/Money';
import { useSyncMenuToBranches } from '@/lib/api';
import { branchColor, branchLabel } from '@/lib/branches';
import { useOverview } from '@/lib/useBranchNav';
import { toast } from '@/lib/toast';

type Props = { open: boolean; onClose: () => void };

const STATUS_COPY: Record<MenuSyncTarget['status'], string> = {
  ok: '',
  forbidden: "You can't edit this branch's menu.",
  write_locked: 'This branch is read-only until its plan is sorted out.',
  not_found: 'Not a branch you can reach.',
  error: "Something went wrong here — nothing was changed in this branch.",
};

/**
 * Push this branch's menu to the others. Three steps: pick branches (and
 * whether prices go too), preview exactly what changes in each, then sync.
 *
 * Safe by construction: matched by name, never deletes, and each branch keeps
 * its own prices unless "Also push prices" is on — so Thamel can charge more
 * than Sorakhutte and a later sync won't undo it.
 */
export function SyncMenuModal({ open, onClose }: Props) {
  const { business, branches } = useOverview();
  const sync = useSyncMenuToBranches();
  const source = branches.find((b) => b.is_active);
  const others = branches.filter((b) => !b.is_active);

  const [step, setStep] = useState<'choose' | 'preview' | 'done'>('choose');
  const [picked, setPicked] = useState<string[]>([]);
  const [prices, setPrices] = useState(false);
  const [photos, setPhotos] = useState(true);
  const [addOns, setAddOns] = useState(true);
  const [stations, setStations] = useState(false);
  const [preview, setPreview] = useState<MenuSyncResponse | null>(null);
  const [result, setResult] = useState<MenuSyncResponse | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('choose');
    setPicked(others.filter((b) => b.can?.menu_update).map((b) => b.slug));
    setPrices(false);
    setPhotos(true);
    setAddOns(true);
    setStations(false);
    setPreview(null);
    setResult(null);
    // Reset only when the modal opens; `others` is derived each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const label = (name: string) => branchLabel(name, business?.name);
  const colour = (slug: string) => branchColor(branches, slug);

  const run = (dryRun: boolean) =>
    sync.mutate(
      { targets: picked, include_prices: prices, dry_run: dryRun, photos, add_ons: addOns, stations },
      {
        onSuccess: (res) => {
          if (dryRun) {
            setPreview(res);
            setStep('preview');
          } else {
            setResult(res);
            setStep('done');
            const ok = res.targets.filter((t) => t.status === 'ok').length;
            toast.success(`Menu synced to ${ok} ${ok === 1 ? 'branch' : 'branches'}`);
          }
        },
        onError: (e) => toast.error('Could not sync the menu', e.message),
      },
    );

  const changes = useMemo(
    () =>
      (preview?.targets ?? [])
        .filter((t) => t.status === 'ok')
        .reduce((n, t) => n + t.result.items.created + t.result.items.updated + t.result.categories.created + extrasChanges(t), 0),
    [preview],
  );

  let footer: ReactNode = null;
  if (step === 'choose') {
    footer = (
      <>
        <button type="button" className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn primary" disabled={picked.length === 0 || sync.isPending} onClick={() => run(true)}>
          {sync.isPending ? 'Checking…' : 'Preview changes'} <ArrowRight size={14} strokeWidth={1.6} />
        </button>
      </>
    );
  } else if (step === 'preview') {
    footer = (
      <>
        <button type="button" className="btn ghost" onClick={() => setStep('choose')}>
          <ArrowLeft size={14} strokeWidth={1.6} /> Back
        </button>
        <button type="button" className="btn primary" disabled={changes === 0 || sync.isPending} onClick={() => run(false)}>
          <Send size={14} strokeWidth={1.6} />
          {sync.isPending ? 'Syncing…' : changes === 0 ? 'Already in sync' : `Sync ${changes} ${changes === 1 ? 'change' : 'changes'}`}
        </button>
      </>
    );
  } else {
    footer = (
      <button type="button" className="btn primary" onClick={onClose}>
        Done
      </button>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Sync menu to branches"
      subtitle={source ? `From ${label(source.name)}` : undefined}
      size="wide"
      footer={footer}
    >
      {step === 'choose' && (
        <div className="sync-choose">
          <p className="field-hint" style={{ marginTop: 0 }}>
            Categories and items are matched by name. New ones are added, existing ones get this branch's description and
            kitchen setting. Nothing is ever deleted or unlinked.
          </p>
          <div className="sync-targets" role="group" aria-label="Branches to sync to">
            {others.map((b) => {
              const allowed = !!b.can?.menu_update;
              const on = picked.includes(b.slug);
              return (
                <label key={b.slug} className={`sync-target${allowed ? '' : ' is-disabled'}${on ? ' is-on' : ''}`}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!allowed}
                    onChange={(e) =>
                      setPicked((p) => (e.target.checked ? [...p, b.slug] : p.filter((s) => s !== b.slug)))
                    }
                  />
                  <span className="branch-dot" style={{ background: colour(b.slug) }} aria-hidden />
                  <span className="sync-target__name">{label(b.name)}</span>
                  {!allowed && <span className="sync-target__why">no menu access</span>}
                </label>
              );
            })}
          </div>
          <div className="sync-options">
            <SyncOption checked={photos} onChange={setPhotos} title="Photos">
              Items and categories get this branch's photo.
            </SyncOption>
            <SyncOption checked={addOns} onChange={setAddOns} title="Add-ons">
              Add-on groups and their options are copied and attached to the same items.
            </SyncOption>
            <SyncOption checked={stations} onChange={setStations} title="Stations">
              Items go to the station with the same name there (Kitchen, Bar…). Stations aren't created — each building
              sets up its own printers.
            </SyncOption>
            <SyncOption checked={prices} onChange={setPrices} title="Also push prices">
              Off: each branch keeps its own prices (items and add-ons); new ones arrive at this branch's price. On:
              everything synced takes this branch's price.
            </SyncOption>
          </div>
        </div>
      )}

      {step === 'preview' && preview && <SyncReport res={preview} label={label} colour={colour} />}
      {step === 'done' && result && (
        <div className="sync-done">
          <CheckCircle2 size={28} strokeWidth={1.5} className="sync-done__icon" />
          <SyncReport res={result} label={label} colour={colour} done />
        </div>
      )}
    </Modal>
  );
}

function SyncReport({
  res,
  label,
  colour,
  done,
}: {
  res: MenuSyncResponse;
  label: (n: string) => string;
  colour: (s: string) => string;
  done?: boolean;
}) {
  return (
    <div className="sync-report">
      {res.targets.map((t) => {
        const rows = (t.result.rows ?? []).filter((r) => r.action === 'new' || r.action === 'update');
        const unchanged = (t.result.rows ?? []).filter((r) => r.action === 'unchanged').length;
        return (
          <section key={t.slug} className="sync-branch">
            <header className="sync-branch__head">
              <span className="branch-dot" style={{ background: colour(t.slug) }} aria-hidden />
              <h4>{label(t.name || t.slug)}</h4>
              {t.status === 'ok' ? (
                <span className="sync-branch__counts">
                  <span className="import-badge new">
                    {t.result.items.created} {done ? 'added' : 'new'}
                  </span>
                  {t.result.items.updated > 0 && (
                    <span className="import-badge update">
                      {t.result.items.updated} {done ? 'updated' : 'update'}
                    </span>
                  )}
                  {unchanged > 0 && <span className="import-badge skip">{unchanged} same</span>}
                </span>
              ) : (
                <span className="sync-branch__error">
                  <AlertTriangle size={13} strokeWidth={1.6} /> {STATUS_COPY[t.status]}
                </span>
              )}
            </header>
            {t.status === 'ok' && t.extras && <ExtrasLine x={t.extras} done={done} />}
            {!done && t.status === 'ok' && rows.length > 0 && (
              <ul className="sync-rows">
                {rows.map((r) => (
                  <li key={`${r.category}\u0000${r.item}`}>
                    <span className={`import-badge ${r.action}`}>{r.action}</span>
                    <span className="sync-rows__item">
                      {r.item}
                      <span className="sync-rows__cat">{r.category}</span>
                    </span>
                    <span className="sync-rows__price">
                      {r.old_price_cents != null && r.old_price_cents !== r.new_price_cents ? (
                        <>
                          <s>{formatNPR(r.old_price_cents)}</s> → {formatNPR(r.new_price_cents)}
                        </>
                      ) : (
                        formatNPR(r.new_price_cents)
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!done && t.status === 'ok' && rows.length === 0 && extrasChanges(t) === 0 && (
              <p className="field-hint">Already matches — nothing to change.</p>
            )}
          </section>
        );
      })}
      {res.not_synced.length > 0 && (
        <p className="field-hint sync-skipped">
          Not synced: {res.not_synced.map((n) => `${n.item} (${n.reason})`).join(' · ')}
        </p>
      )}
    </div>
  );
}

function extrasChanges(t: MenuSyncTarget): number {
  const x = t.extras;
  if (!x) return 0;
  return (
    x.photos + x.stations + x.add_on_groups_new + x.add_on_groups_updated + x.add_on_options_new + x.add_on_options_updated + x.add_on_links
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 photos · 2 add-on groups (5 options) · 4 add-on links · 6 station changes" */
function ExtrasLine({ x, done }: { x: NonNullable<MenuSyncTarget['extras']>; done?: boolean }) {
  const parts: string[] = [];
  if (x.photos) parts.push(plural(x.photos, 'photo'));
  const groups = x.add_on_groups_new + x.add_on_groups_updated;
  const options = x.add_on_options_new + x.add_on_options_updated;
  if (groups || options) parts.push(`${plural(groups, 'add-on group')} (${plural(options, 'option')})`);
  if (x.add_on_links) parts.push(plural(x.add_on_links, 'add-on link'));
  if (x.stations) parts.push(plural(x.stations, 'station change'));
  return (
    <>
      {parts.length > 0 && (
        <p className="sync-extras">
          {done ? 'Also synced: ' : 'Also: '}
          {parts.join(' · ')}
        </p>
      )}
      {(x.missing_stations?.length ?? 0) > 0 && (
        <p className="sync-extras sync-extras--warn">
          <AlertTriangle size={13} strokeWidth={1.6} /> No {x.missing_stations!.join(', ')} station here — those items keep
          their current station. Add it under Stations to route them.
        </p>
      )}
    </>
  );
}

function SyncOption({
  checked,
  onChange,
  title,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <label className="sync-prices">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <strong>{title}</strong>
        <span className="field-hint">{children}</span>
      </span>
    </label>
  );
}
