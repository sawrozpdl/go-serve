import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Pencil,
  Plus,
  FileText,
  Phone,
  Mail,
  CalendarDays,
  CalendarOff,
  Loader2,
  Wallet,
  Trash2,
  LinkIcon,
  User,
  CalendarClock,
  StickyNote,
} from 'lucide-react';

import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { Tabs } from '@/components/Tabs';
import { StaffFormModal } from '@/components/StaffFormModal';
import { StaffDocumentUploadModal } from '@/components/StaffDocumentUploadModal';
import { StaffDocumentLightbox } from '@/components/StaffDocumentLightbox';
import { StaffSchedule } from '@/components/StaffSchedule';
import { StaffPayModal } from '@/components/StaffPayModal';
import {
  useStaff,
  useStaffPay,
  useDeleteStaffPay,
  type Staff,
  type StaffDocument,
} from '@/lib/api';
import { formatRupees } from '@/components/Money';
import { docTypeLabel, formatBytes, isImage, useStaffDocUrl } from '@/lib/staff-docs';
import { Can } from '@/lib/permissions';
import { toast } from '@/lib/toast';

const CADENCE_LABEL: Record<string, string> = {
  monthly: '/ month',
  hourly: '/ hour',
  per_shift: '/ shift',
};

type DetailTab = 'general' | 'payment' | 'schedule' | 'documents';

export function StaffDetailPage() {
  const { id } = useParams();
  const staff = useStaff(id);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);
  const [tab, setTab] = useState<DetailTab>('general');

  const backLink = (
    <Link to="/admin/staff" className="staff-back">
      <ArrowLeft size={13} strokeWidth={1.5} /> Staff
    </Link>
  );

  if (staff.isPending) {
    return (
      <PageShell eyebrow={backLink} title="Staff">
        <LoadingState />
      </PageShell>
    );
  }
  if (staff.isError && !staff.data) {
    return (
      <PageShell eyebrow={backLink} title="Staff">
        <ErrorState onRetry={() => staff.refetch()} />
      </PageShell>
    );
  }
  if (!staff.data) {
    return (
      <PageShell eyebrow={backLink} title="Staff">
        <div className="empty-state">This staff member could not be found.</div>
      </PageShell>
    );
  }

  const s = staff.data;
  const docs = s.documents;

  // Status + employment dates live in the header — the body has room for the
  // four section tabs without burying these at-a-glance facts.
  const headerMeta = (
    <div className="staff-head-meta">
      <span className={`staff-status staff-status--${s.status}`}>{s.status}</span>
      {s.role_title && <span className="staff-head-meta__role">{s.role_title}</span>}
      {s.started_on && (
        <span className="staff-head-meta__fact">
          <CalendarDays size={13} strokeWidth={1.5} /> Started {s.started_on}
        </span>
      )}
      {s.ended_on && (
        <span className="staff-head-meta__fact">
          <CalendarOff size={13} strokeWidth={1.5} /> Ended {s.ended_on}
        </span>
      )}
    </div>
  );

  const tabs = (
    <Tabs<DetailTab>
      ariaLabel="Staff sections"
      active={tab}
      onChange={setTab}
      items={[
        { key: 'general', label: 'General', icon: <User size={14} strokeWidth={1.6} /> },
        { key: 'payment', label: 'Payment', icon: <Wallet size={14} strokeWidth={1.6} /> },
        { key: 'schedule', label: 'Schedule', icon: <CalendarClock size={14} strokeWidth={1.6} /> },
        {
          key: 'documents',
          label: 'Documents',
          icon: <FileText size={14} strokeWidth={1.6} />,
          badge: docs.length > 0 ? <span className="tab-count">{docs.length}</span> : undefined,
        },
      ]}
    />
  );

  return (
    <PageShell
      eyebrow={backLink}
      title={s.full_name}
      subtitle={headerMeta}
      tabs={tabs}
      actions={
        <Can perm="staff:update">
          <button className="btn" onClick={() => setEditing(true)}>
            <Pencil size={14} /> Edit
          </button>
        </Can>
      }
    >
      {tab === 'general' && <GeneralSection staff={s} />}

      {tab === 'payment' && <CompensationSection staff={s} />}

      {tab === 'schedule' && <StaffSchedule staff={s} />}

      {tab === 'documents' && (
        <>
          <div className="staff-docs-head">
            <h3>Documents</h3>
            <Can perm="staff:upload_document">
              <button className="btn small primary" onClick={() => setAdding(true)}>
                <Plus size={14} /> Add document
              </button>
            </Can>
          </div>

          {docs.length === 0 ? (
            <div className="panel staff-empty">
              <FileText size={26} strokeWidth={1.5} />
              <h3>No documents</h3>
              <p>Attach scans or PDFs — citizenship, driver’s licence, contracts and more.</p>
              <Can perm="staff:upload_document">
                <button className="btn primary" onClick={() => setAdding(true)}>
                  <Plus size={14} /> Add document
                </button>
              </Can>
            </div>
          ) : (
            <div className="staff-doc-grid">
              {docs.map((d, i) => (
                <StaffDocTile key={d.id} staffId={s.id} doc={d} onOpen={() => setViewer(i)} />
              ))}
            </div>
          )}
        </>
      )}

      {editing && <StaffFormModal open onClose={() => setEditing(false)} staff={s} />}
      {adding && (
        <StaffDocumentUploadModal
          open
          onClose={() => setAdding(false)}
          staffId={s.id}
          staffName={s.full_name}
        />
      )}
      {viewer !== null && docs[viewer] && (
        <StaffDocumentLightbox
          staffId={s.id}
          documents={docs}
          index={viewer}
          onClose={() => setViewer(null)}
          onIndexChange={setViewer}
        />
      )}
    </PageShell>
  );
}

function GeneralSection({ staff: s }: { staff: Staff }) {
  const hasContact = s.phone || s.email || s.user_id;

  return (
    <div className="panel staff-general">
      <div className="staff-general__grid">
        {s.phone && (
          <div className="staff-fact">
            <span className="staff-fact__label">
              <Phone size={13} strokeWidth={1.5} /> Phone
            </span>
            <a className="staff-fact__value" href={`tel:${s.phone}`}>
              {s.phone}
            </a>
          </div>
        )}
        {s.email && (
          <div className="staff-fact">
            <span className="staff-fact__label">
              <Mail size={13} strokeWidth={1.5} /> Email
            </span>
            <a className="staff-fact__value" href={`mailto:${s.email}`}>
              {s.email}
            </a>
          </div>
        )}
        {s.user_id && (
          <div className="staff-fact">
            <span className="staff-fact__label">
              <LinkIcon size={13} strokeWidth={1.5} /> App account
            </span>
            <span className="staff-fact__value">
              {s.user_email ?? s.user_name ?? 'Linked'}
            </span>
          </div>
        )}
        {s.started_on && (
          <div className="staff-fact">
            <span className="staff-fact__label">
              <CalendarDays size={13} strokeWidth={1.5} /> Started
            </span>
            <span className="staff-fact__value num">{s.started_on}</span>
          </div>
        )}
        {s.ended_on && (
          <div className="staff-fact">
            <span className="staff-fact__label">
              <CalendarOff size={13} strokeWidth={1.5} /> Ended
            </span>
            <span className="staff-fact__value num">{s.ended_on}</span>
          </div>
        )}
      </div>

      {s.notes ? (
        <div className="staff-general__notes">
          <span className="staff-fact__label">
            <StickyNote size={13} strokeWidth={1.5} /> Notes
          </span>
          <p>{s.notes}</p>
        </div>
      ) : !hasContact ? (
        <p className="staff-general__empty">
          No contact details yet — use Edit to add a phone, email or notes.
        </p>
      ) : null}
    </div>
  );
}

function CompensationSection({ staff }: { staff: Staff }) {
  const pay = useStaffPay(staff.id);
  const del = useDeleteStaffPay(staff.id);
  const [recording, setRecording] = useState(false);

  const removePayment = async (id: string) => {
    if (!window.confirm('Delete this payment record?')) return;
    try {
      await del.mutateAsync(id);
      toast.success('Payment removed');
    } catch (err) {
      toast.error('Could not remove', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  const list = pay.data ?? [];

  return (
    <div className="panel staff-pay">
      <div className="staff-pay__head">
        <div className="staff-pay__title">
          <Wallet size={16} strokeWidth={1.6} />
          <h3>Compensation</h3>
        </div>
        <Can perm="staff:update">
          <button className="btn small primary" onClick={() => setRecording(true)}>
            <Plus size={14} /> Record payment
          </button>
        </Can>
      </div>

      <div className="staff-pay__salary">
        {staff.salary_amount != null ? (
          <>
            <span className="staff-pay__amount num">{formatRupees(staff.salary_amount)}</span>
            <span className="staff-pay__cadence">{CADENCE_LABEL[staff.salary_cadence] ?? ''}</span>
          </>
        ) : (
          <span className="staff-pay__none">No salary set — edit the profile to add one.</span>
        )}
      </div>

      {list.length > 0 && (
        <div className="staff-pay__history">
          <div className="staff-pay__history-head">Pay history</div>
          <ul className="staff-pay__list">
            {list.map((p) => (
              <li key={p.id} className="staff-pay__row">
                <span className="staff-pay__row-date num">{p.paid_on}</span>
                <span className="staff-pay__row-amount num">{formatRupees(p.amount)}</span>
                <span className="staff-pay__row-meta">
                  {p.period_label && <span className="staff-pay__row-period">{p.period_label}</span>}
                  {p.note && <span className="staff-pay__row-note">{p.note}</span>}
                </span>
                <Can perm="staff:update">
                  <button
                    className="btn icon small staff-pay__del"
                    title="Delete payment"
                    onClick={() => void removePayment(p.id)}
                    disabled={del.isPending}
                  >
                    <Trash2 size={13} />
                  </button>
                </Can>
              </li>
            ))}
          </ul>
        </div>
      )}

      {recording && (
        <StaffPayModal
          open
          onClose={() => setRecording(false)}
          staffId={staff.id}
          staffName={staff.full_name}
        />
      )}
    </div>
  );
}

function StaffDocTile({
  staffId,
  doc,
  onOpen,
}: {
  staffId: string;
  doc: StaffDocument;
  onOpen: () => void;
}) {
  const image = isImage(doc.mime_type);
  // Only fetch a preview for images; PDFs show a file glyph (cheaper + clearer).
  const { url, loading } = useStaffDocUrl(staffId, doc.id, image);

  return (
    <button type="button" className="staff-doc-tile" onClick={onOpen} title={docTypeLabel(doc)}>
      <div className="staff-doc-tile__thumb">
        {image && url ? (
          <img src={url} alt={docTypeLabel(doc)} />
        ) : image && loading ? (
          <Loader2 size={20} className="spin" />
        ) : (
          <FileText size={30} strokeWidth={1.25} />
        )}
        {!image && <span className="staff-doc-tile__ext">PDF</span>}
      </div>
      <div className="staff-doc-tile__label">{docTypeLabel(doc)}</div>
      <div className="staff-doc-tile__sub">{formatBytes(doc.size_bytes)}</div>
    </button>
  );
}
