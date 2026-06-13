import { useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';

import { DatePicker } from '@/components/DatePicker';
import { Modal } from '@/components/Modal';
import {
  useCreateStaff,
  useUpdateStaff,
  useMembers,
  type Staff,
  type SalaryCadence,
} from '@/lib/api';
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

  const members = useMembers();

  const [fullName, setFullName] = useState(staff?.full_name ?? '');
  const [roleTitle, setRoleTitle] = useState(staff?.role_title ?? '');
  const [phone, setPhone] = useState(staff?.phone ?? '');
  const [email, setEmail] = useState(staff?.email ?? '');
  const [status, setStatus] = useState<'active' | 'inactive'>(staff?.status ?? 'active');
  const [startedOn, setStartedOn] = useState(staff?.started_on ?? '');
  const [endedOn, setEndedOn] = useState(staff?.ended_on ?? '');
  const [salary, setSalary] = useState(staff?.salary_amount != null ? String(staff.salary_amount) : '');
  const [cadence, setCadence] = useState<SalaryCadence>(staff?.salary_cadence ?? 'monthly');
  const [userId, setUserId] = useState(staff?.user_id ?? '');
  const [notes, setNotes] = useState(staff?.notes ?? '');

  const activeMembers = (members.data ?? []).filter((m) => m.status === 'active');
  const pending = create.isPending || update.isPending;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const name = fullName.trim();
    if (!name) return;
    const salaryNum = salary.trim() === '' ? null : parseFloat(salary);
    if (salaryNum != null && (!Number.isFinite(salaryNum) || salaryNum < 0)) {
      toast.error('Invalid salary', 'Enter a positive amount or leave it blank.');
      return;
    }
    const prevUserId = staff?.user_id ?? '';
    const body = {
      full_name: name,
      role_title: roleTitle.trim(),
      phone: phone.trim(),
      email: email.trim(),
      status,
      started_on: startedOn || null,
      ended_on: endedOn || null,
      salary_amount: salaryNum,
      salary_cadence: cadence,
      // Link is associative only — name/email above stay independently editable.
      ...(userId ? { user_id: userId } : prevUserId ? { clear_user_id: true } : {}),
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
            <label>Salary</label>
            <input
              inputMode="decimal"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="Amount in रू (optional)"
            />
          </div>
          <div>
            <label>Pay cadence</label>
            <select value={cadence} onChange={(e) => setCadence(e.target.value as SalaryCadence)}>
              <option value="monthly">Monthly</option>
              <option value="hourly">Hourly</option>
              <option value="per_shift">Per shift</option>
            </select>
          </div>
        </div>

        <label>App account</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Not linked</option>
          {staff?.user_id && !activeMembers.some((m) => m.user_id === staff.user_id) && (
            // Preserve a current link even if that member is no longer active/listed.
            <option value={staff.user_id}>{staff.user_email ?? staff.user_name ?? 'Linked account'}</option>
          )}
          {activeMembers.map((m) => (
            <option key={m.user_id} value={m.user_id}>
              {m.name || m.email}
            </option>
          ))}
        </select>

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
            <DatePicker
              value={startedOn}
              onChange={setStartedOn}
              max={new Date().toISOString().slice(0, 10)}
              placeholder="Pick a date"
            />
          </div>
        </div>

        <div className="row-inputs">
          <div>
            <label>End date</label>
            <DatePicker value={endedOn} onChange={setEndedOn} placeholder="If they've left" />
          </div>
          <div aria-hidden />
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
