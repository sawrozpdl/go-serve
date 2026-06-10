import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Plus, FileText, Phone, Mail, CalendarDays, Loader2 } from 'lucide-react';

import { ErrorState } from '@/components/ErrorState';
import { LoadingState } from '@/components/LoadingState';
import { PageShell } from '@/components/PageShell';
import { StaffFormModal } from '@/components/StaffFormModal';
import { StaffDocumentUploadModal } from '@/components/StaffDocumentUploadModal';
import { StaffDocumentLightbox } from '@/components/StaffDocumentLightbox';
import { useStaff, type StaffDocument } from '@/lib/api';
import { docTypeLabel, formatBytes, isImage, useStaffDocUrl } from '@/lib/staff-docs';
import { Can } from '@/lib/permissions';

export function StaffDetailPage() {
  const { id } = useParams();
  const staff = useStaff(id);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [viewer, setViewer] = useState<number | null>(null);

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
  if (staff.isError) {
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

  return (
    <PageShell
      eyebrow={backLink}
      title={s.full_name}
      subtitle={s.role_title || 'Staff'}
      actions={
        <Can perm="staff:update">
          <button className="btn" onClick={() => setEditing(true)}>
            <Pencil size={14} /> Edit
          </button>
        </Can>
      }
    >
      <div className="panel staff-profile">
        <span className={`staff-status staff-status--${s.status}`}>{s.status}</span>
        <div className="staff-profile__facts">
          {s.phone && (
            <span>
              <Phone size={14} strokeWidth={1.5} /> {s.phone}
            </span>
          )}
          {s.email && (
            <span>
              <Mail size={14} strokeWidth={1.5} /> {s.email}
            </span>
          )}
          {s.started_on && (
            <span>
              <CalendarDays size={14} strokeWidth={1.5} /> Started {s.started_on}
            </span>
          )}
        </div>
        {s.notes && <p className="staff-profile__notes">{s.notes}</p>}
      </div>

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
