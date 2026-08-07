import { useState } from 'react';
import { ACQUISITION_SOURCES } from '@cafe-mgmt/api-types';

import type { LeadInput, PlatformPerson, AcquisitionSource } from '@/lib/api';
import { Modal } from '@/components/Modal';
import { DatePicker } from '@/components/DatePicker';

/** The create/edit form, shared so the two can't drift. Mirrors PersonModal:
 *  plain useState, no form library — the super pages don't use one. */
export function LeadModal({
  title,
  subtitle,
  initial,
  busy,
  people,
  onClose,
  onSave,
}: {
  title: string;
  subtitle?: string;
  initial: LeadInput;
  busy: boolean;
  people: PlatformPerson[];
  onClose: () => void;
  onSave: (input: LeadInput) => Promise<void>;
}) {
  const [form, setForm] = useState<LeadInput>(initial);
  const patch = (p: Partial<LeadInput>) => setForm((f) => ({ ...f, ...p }));

  // Matches the server rule: a café name, plus at least one way to reach them.
  const reachable = !!(form.email?.trim() || form.phone?.trim());
  const canSave = form.cafe_name.trim() !== '' && reachable && !busy;

  return (
    <Modal open title={title} subtitle={subtitle} onClose={onClose}>
      <div className="field">
        <label>Café name</label>
        <input
          value={form.cafe_name}
          onChange={(e) => patch({ cafe_name: e.target.value })}
          placeholder="Himalayan Java, Jhamsikhel"
          autoFocus
        />
      </div>
      <div className="field">
        <label>Contact person</label>
        <input
          value={form.contact_name ?? ''}
          onChange={(e) => patch({ contact_name: e.target.value })}
          placeholder="who you actually speak to"
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label>Phone</label>
          <input
            type="tel"
            value={form.phone ?? ''}
            onChange={(e) => patch({ phone: e.target.value })}
            placeholder="98…"
          />
        </div>
        <div className="field">
          <label>Email</label>
          <input
            type="email"
            value={form.email ?? ''}
            onChange={(e) => patch({ email: e.target.value })}
            placeholder="optional"
          />
        </div>
      </div>
      {!reachable && (
        <div className="field-hint">Give at least a phone number or an email — otherwise there’s no way to follow up.</div>
      )}

      <div className="field-row">
        <div className="field">
          <label>Source</label>
          <select
            value={form.source ?? 'outbound'}
            onChange={(e) => patch({ source: e.target.value as AcquisitionSource })}
          >
            {ACQUISITION_SOURCES.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <div className="field-hint">Carried onto the café as its acquisition source when this lead is won.</div>
        </div>
        <div className="field">
          <label>Owner</label>
          <select
            value={form.owner_person_id ?? ''}
            onChange={(e) => patch({ owner_person_id: e.target.value || null })}
          >
            <option value="">— nobody —</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <div className="field-hint">Becomes the café’s relationship manager on conversion.</div>
        </div>
      </div>

      <div className="field-row">
        <div className="field">
          <label>Next follow-up</label>
          <DatePicker
            value={form.next_follow_up_at ?? ''}
            onChange={(v) => patch({ next_follow_up_at: v || null })}
            placeholder="not booked"
          />
          <div className="field-hint">Overdue follow-ups show up on the overview and in the morning email.</div>
        </div>
        <div className="field">
          <label>Expected seats</label>
          <input
            type="number"
            min={1}
            value={form.expected_seats ?? ''}
            onChange={(e) => patch({ expected_seats: e.target.value ? Number(e.target.value) : null })}
            placeholder="optional"
          />
        </div>
      </div>

      <div className="field">
        <label>Notes</label>
        <textarea
          rows={2}
          value={form.notes ?? ''}
          onChange={(e) => patch({ notes: e.target.value })}
          placeholder="what they run today, what they're unhappy with, who decides"
        />
      </div>

      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!canSave} onClick={() => void onSave(form)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </Modal>
  );
}
