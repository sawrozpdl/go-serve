import { useMemo, useState } from 'react';
import { Pin, PinOff, Trash2, Plus, UserPlus } from 'lucide-react';

import {
  useAdminPeople,
  useAdminCreatePerson,
  useAdminSetRelationship,
  useAdminTenantNotes,
  useAdminAddTenantNote,
  useAdminPinTenantNote,
  useAdminDeleteTenantNote,
  type AdminTenantDetail,
  type AcquisitionSource,
} from '@/lib/api';
// A runtime value, so imported from the shared package rather than through
// lib/api's type-only re-export block.
import { ACQUISITION_SOURCES } from '@cafe-mgmt/api-types';
import { SearchSelect } from '@/components/SearchSelect';
import { DatePicker } from '@/components/DatePicker';
import { QueryState } from '@/components/QueryState';
import { useConfirm } from '@/components/ConfirmDialog';
import { fmtDayLong } from '@/lib/dates';

/** Who owns this café relationship, plus our private timeline of notes about
 *  them. Nothing here is visible to the café itself. */
export function RelationshipTab({ id, t }: { id: string; t: AdminTenantDetail }) {
  const people = useAdminPeople();
  const save = useAdminSetRelationship(id);
  const createPerson = useAdminCreatePerson();

  const [onboarder, setOnboarder] = useState(t.onboarded_by_person_id ?? '');
  const [rm, setRm] = useState(t.relationship_manager_id ?? '');
  const [source, setSource] = useState<AcquisitionSource>(t.acquisition_source);
  const [ownerName, setOwnerName] = useState(t.owner_name);
  const [onboardedOn, setOnboardedOn] = useState(t.onboarded_on?.slice(0, 10) ?? '');

  // An explicit "nobody" row rather than a clear affordance: unassigned is a
  // real, choosable state here, not the absence of a choice.
  const options = useMemo(
    () => [
      { value: '', label: '— nobody —' },
      ...(people.data?.people ?? []).map((p) => ({ value: p.id, label: p.name })),
    ],
    [people.data],
  );

  const dirty =
    onboarder !== (t.onboarded_by_person_id ?? '') ||
    rm !== (t.relationship_manager_id ?? '') ||
    source !== t.acquisition_source ||
    ownerName !== t.owner_name ||
    onboardedOn !== (t.onboarded_on?.slice(0, 10) ?? '');

  // Adding a person inline: the common flow is "this café was signed up by
  // someone who isn't in the list yet", and bouncing to another page to add
  // them would lose the half-filled form.
  const addPerson = async (name: string, field: 'onboarder' | 'rm') => {
    const created = await createPerson.mutateAsync({ name, kind: 'agent' });
    if (field === 'onboarder') {
      setOnboarder(created.id);
      if (!rm) setRm(created.id); // mirror the server's default
    } else {
      setRm(created.id);
    }
  };

  const onSave = () => {
    save.mutate({
      onboarded_by_person_id: onboarder || null,
      relationship_manager_id: rm || null,
      // Always explicit from this form: both selects are visible, so whatever
      // they show is the intent — including "nobody".
      rm_provided: true,
      onboarded_on: onboardedOn || null,
      acquisition_source: source,
      owner_name: ownerName,
    });
  };

  return (
    <div className="super-detail-grid">
      <section className="panel">
        <div className="panel-head"><h3>Relationship</h3></div>
        <p className="hint">
          Internal only — the café never sees any of this.
        </p>

        <div className="field">
          <label>Onboarded by</label>
          <SearchSelect
            value={onboarder}
            onChange={(v) => {
              setOnboarder(v);
              if (!rm) setRm(v); // first pick seeds the manager too
            }}
            options={options}
            placeholder="nobody recorded"
          />
          <InlineAddPerson busy={createPerson.isPending} onAdd={(n) => void addPerson(n, 'onboarder')} />
        </div>

        <div className="field">
          <label>Relationship manager</label>
          <SearchSelect
            value={rm}
            onChange={setRm}
            options={options}
            placeholder="unassigned"
          />
          {onboarder && rm && onboarder === rm && (
            <div className="field-hint">Same person who signed them up.</div>
          )}
          {onboarder && rm && onboarder !== rm && (
            <div className="field-hint">Handed over from whoever onboarded them.</div>
          )}
          <InlineAddPerson busy={createPerson.isPending} onAdd={(n) => void addPerson(n, 'rm')} />
        </div>

        <div className="field">
          <label>How they came to us</label>
          <select value={source} onChange={(e) => setSource(e.target.value as AcquisitionSource)}>
            {ACQUISITION_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Onboarded on</label>
          <DatePicker value={onboardedOn} onChange={setOnboardedOn} placeholder="not recorded" compact />
        </div>

        <div className="field">
          <label>Owner’s name</label>
          <input
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="the human we actually talk to"
          />
          <div className="field-hint">
            {t.owner_email
              ? <>Signs in as <strong>{t.owner_email}</strong>.</>
              : 'The owner hasn’t accepted their invite yet, so there’s no login to show.'}
            {t.contact_phone && <> · {t.contact_phone}</>}
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn primary" disabled={!dirty || save.isPending} onClick={onSave}>
            {save.isPending ? 'Saving…' : 'Save relationship'}
          </button>
        </div>
      </section>

      <NotesPanel id={id} />
    </div>
  );
}

/** A one-field "add someone new" affordance that sits under each picker. */
function InlineAddPerson({ busy, onAdd }: { busy: boolean; onAdd: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');

  if (!open) {
    return (
      <button type="button" className="linklike" onClick={() => setOpen(true)}>
        <UserPlus size={12} strokeWidth={1.8} /> Add someone new
      </button>
    );
  }
  const submit = () => {
    if (!name.trim()) return;
    onAdd(name.trim());
    setName('');
    setOpen(false);
  };
  return (
    <div className="super-inline" style={{ marginTop: 6 }}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        placeholder="their name"
        autoFocus
      />
      <button type="button" className="btn" disabled={busy || !name.trim()} onClick={submit}>Add</button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}

function NotesPanel({ id }: { id: string }) {
  const q = useAdminTenantNotes(id);
  const add = useAdminAddTenantNote(id);
  const pin = useAdminPinTenantNote(id);
  const del = useAdminDeleteTenantNote(id);
  const confirm = useConfirm();
  const [draft, setDraft] = useState('');

  const notes = q.data?.notes ?? [];

  const submit = async () => {
    if (!draft.trim()) return;
    await add.mutateAsync({ body: draft.trim() });
    setDraft('');
  };

  const onDelete = async (noteId: string) => {
    if (await confirm({ title: 'Delete this note?', danger: true, confirmLabel: 'Delete' })) {
      del.mutate(noteId);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head"><h3>Notes</h3></div>
      <p className="hint">What we know about this café that the data doesn’t say.</p>

      <div className="field">
        <textarea
          rows={3}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Owner mentioned they're opening a second branch in Pokhara…"
        />
        <div className="modal-actions" style={{ marginTop: 6 }}>
          <button className="btn" disabled={!draft.trim() || add.isPending} onClick={() => void submit()}>
            <Plus size={14} strokeWidth={1.8} style={{ marginRight: 4 }} />
            {add.isPending ? 'Saving…' : 'Add note'}
          </button>
        </div>
      </div>

      <QueryState
        isPending={q.isPending}
        isError={q.isError}
        error={q.error}
        refetch={q.refetch}
        isEmpty={notes.length === 0}
        errorTitle="Could not load notes"
        emptyTitle="No notes yet"
        emptyHint="Anything worth remembering before the next call."
        compact
      >
        <ul className="tenant-notes">
          {notes.map((n) => (
            <li key={n.id} className={n.pinned ? 'is-pinned' : undefined}>
              <p>{n.body}</p>
              <div className="tenant-note-meta">
                <span>{n.author_name || 'someone'} · {fmtDayLong(n.created_at)}</span>
                <span className="super-row-actions">
                  <button
                    className="btn icon"
                    title={n.pinned ? 'Unpin' : 'Pin to the top'}
                    onClick={() => pin.mutate({ id: n.id, pinned: !n.pinned })}
                  >
                    {n.pinned
                      ? <PinOff size={13} strokeWidth={1.7} />
                      : <Pin size={13} strokeWidth={1.7} />}
                  </button>
                  <button className="btn icon" title="Delete" onClick={() => void onDelete(n.id)}>
                    <Trash2 size={13} strokeWidth={1.7} />
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </QueryState>
    </section>
  );
}
