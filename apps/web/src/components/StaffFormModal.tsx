import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useCreateStaff, useUpdateStaff, type Staff } from '@/lib/api';
import { toast } from '@/lib/toast';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Provided in edit mode; omitted to create a new staff member. */
  staff?: Staff;
};

// Create / edit a staff profile. Standalone employee record — no login account.
export function StaffFormModal({ open, onClose, staff }: Props) {
  const editing = !!staff;
  const create = useCreateStaff();
  const update = useUpdateStaff(staff?.id ?? '');

  const [fullName, setFullName] = useState(staff?.full_name ?? '');
  const [roleTitle, setRoleTitle] = useState(staff?.role_title ?? '');
  const [phone, setPhone] = useState(staff?.phone ?? '');
  const [email, setEmail] = useState(staff?.email ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(staff?.status ?? 'active');
  const [startedOn, setStartedOn] = useState(staff?.started_on ?? '');
  const [notes, setNotes] = useState(staff?.notes ?? '');

  const pending = create.isPending || update.isPending;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const name = fullName.trim();
    if (!name) return;
    const body = {
      full_name: name,
      role_title: roleTitle.trim(),
      phone: phone.trim(),
      email: email.trim(),
      status,
      started_on: startedOn || null,
      notes: notes.trim(),
    };
    try {
      if (editing) await update.mutateAsync(body);
      else await create.mutateAsync(body);
      toast.success(editing ? 'Staff updated' : 'Staff added', name);
      onClose();
    } catch (err) {
      toast.error('Could not save', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit staff' : 'Add staff'}>
      <form onSubmit={onSubmit}>
        <label>Full name</label>
        <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Aarav Sharma" autoFocus />

        <label>Job title</label>
        <input value={roleTitle} onChange={(e) => setRoleTitle(e.target.value)} placeholder="e.g. Barista" />

        <div className="row-inputs">
          <div>
            <label>Phone</label>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
          </div>
          <div>
            <label>Email</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
          </div>
        </div>

        <div className="row-inputs">
          <div>
            <label>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'inactive')}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
          <div>
            <label>Start date</label>
            <input type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)} />
          </div>
        </div>

        <label>Notes</label>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything worth recording" />

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={pending}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={pending || !fullName.trim()}>
            {pending ? <Loader2 size={14} className="spin" /> : null}
            {editing ? 'Save changes' : 'Add staff'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
