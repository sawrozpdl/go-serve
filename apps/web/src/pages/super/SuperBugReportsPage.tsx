import { useEffect, useState } from 'react';
import { Mail, Paperclip, Trash2, ExternalLink } from 'lucide-react';

import {
  useAdminBugReports,
  useAdminBugReport,
  useAdminUpdateBugReport,
  useAdminDeleteBugReport,
  fetchBugAttachmentBlob,
  type AdminBugReport,
  type AdminBugAttachment,
  type BugKind,
  type BugStatus,
} from '@/lib/api';
import { Modal } from '@/components/Modal';
import { useConfirm } from '@/components/ConfirmDialog';
import { toast } from '@/lib/toast';

const KIND_EMOJI: Record<BugKind, string> = { bug: '🐛', idea: '💡', question: '❓', other: '💬' };
const MOOD_EMOJI: Record<number, string> = { 1: '😤', 2: '😟', 3: '😐', 4: '🙂', 5: '😄' };

const STATUS_META: Record<BugStatus, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'warn' },
  in_progress: { label: 'In progress', cls: '' },
  resolved: { label: 'Resolved', cls: 'ok' },
  wont_fix: { label: "Won't fix", cls: '' },
  closed: { label: 'Closed', cls: 'ok' },
};

const STATUS_FILTERS: { key: string; label: string; countKey?: 'open' | 'in_progress' | 'resolved' | 'total' }[] = [
  { key: 'open', label: 'Open', countKey: 'open' },
  { key: 'in_progress', label: 'In progress', countKey: 'in_progress' },
  { key: 'resolved', label: 'Resolved', countKey: 'resolved' },
  { key: 'all', label: 'All', countKey: 'total' },
];

function relTime(iso: string): string {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function SuperBugReportsPage() {
  const [status, setStatus] = useState('open');
  const [kind, setKind] = useState('all');
  const [priority, setPriority] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('newest');
  const [openId, setOpenId] = useState<string | null>(null);

  const list = useAdminBugReports({ status, kind, priority, q: q.trim(), sort });
  const summary = list.data?.summary ?? { open: 0, in_progress: 0, resolved: 0, total: 0 };
  const reports = list.data?.reports ?? [];

  return (
    <div className="super-page">
      <div className="super-page-head">
        <div>
          <span className="super-eyebrow">Support</span>
          <h1>Bug reports</h1>
        </div>
        <div className="chips">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`chip ${status === f.key ? 'on' : ''}`}
              onClick={() => setStatus(f.key)}
            >
              {f.label}
              {f.countKey != null && <span className="chip-count">{summary[f.countKey]}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="bug-filters">
        <input
          className="bug-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search title, details, cafe, email…"
        />
        <select value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Type">
          <option value="all">All types</option>
          <option value="bug">🐛 Bug</option>
          <option value="idea">💡 Idea</option>
          <option value="question">❓ Question</option>
          <option value="other">💬 Other</option>
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} aria-label="Priority">
          <option value="all">Any priority</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="priority">Priority</option>
        </select>
      </div>

      {list.isError && <div className="banner-error">{list.error?.message ?? 'Failed to load reports'}</div>}

      <div className="super-requests">
        {reports.map((r) => (
          <BugCard key={r.id} report={r} onOpen={() => setOpenId(r.id)} />
        ))}
        {!list.isPending && reports.length === 0 && (
          <div className="empty-state">No reports match these filters.</div>
        )}
      </div>

      {openId && <BugDetailModal id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}

function BugCard({ report: r, onOpen }: { report: AdminBugReport; onOpen: () => void }) {
  const s = STATUS_META[r.status];
  return (
    <button className="panel super-request bug-card" onClick={onOpen}>
      <div className="super-request-main">
        <div className="super-request-title">
          <span className="bug-card-emoji" aria-hidden>
            {KIND_EMOJI[r.kind]}
          </span>
          <strong>{r.title || r.description.slice(0, 80)}</strong>
          <span className={`pill ${s.cls}`}>{s.label}</span>
          {r.priority !== 'normal' && <span className={`bug-prio bug-prio--${r.priority}`}>{r.priority}</span>}
          {r.mood != null && <span title={`mood ${r.mood}/5`}>{MOOD_EMOJI[r.mood]}</span>}
        </div>
        <div className="super-request-meta">
          <span className="bug-cafe">{r.cafe_name || r.tenant_slug}</span>
          <span className="muted">{r.reporter_email || r.reporter_name}</span>
          {r.attachment_count > 0 && (
            <span className="muted">
              <Paperclip size={11} strokeWidth={1.8} /> {r.attachment_count}
            </span>
          )}
          <span className="muted">{relTime(r.created_at)}</span>
        </div>
        {r.title && <p className="super-request-msg">{r.description.slice(0, 160)}</p>}
      </div>
    </button>
  );
}

function BugDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useAdminBugReport(id);
  const update = useAdminUpdateBugReport(id);
  const del = useAdminDeleteBugReport();
  const confirm = useConfirm();

  const [status, setStatus] = useState<BugStatus>('open');
  const [priority, setPriority] = useState('normal');
  const [note, setNote] = useState('');

  const d = detail.data;
  useEffect(() => {
    if (d) {
      setStatus(d.status);
      setPriority(d.priority);
      setNote(d.resolution_note);
    }
  }, [d?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    try {
      await update.mutateAsync({ status, priority, resolution_note: note });
      toast.success('Saved', 'Report updated.');
      onClose();
    } catch (e) {
      toast.error('Could not save', (e as { message?: string }).message ?? 'Please try again.');
    }
  };

  const remove = async () => {
    if (await confirm({ title: 'Delete this report?', message: 'It will be removed from triage.', danger: true, confirmLabel: 'Delete' })) {
      try {
        await del.mutateAsync({ id });
        toast.success('Deleted');
        onClose();
      } catch (e) {
        toast.error('Could not delete', (e as { message?: string }).message ?? 'Please try again.');
      }
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={d ? `${KIND_EMOJI[d.kind]} ${d.title || 'Report'}` : 'Report'}
      subtitle={d ? `${d.cafe_name || d.tenant_slug} · ${relTime(d.created_at)}` : undefined}
    >
      {detail.isPending && <div className="muted">Loading…</div>}
      {detail.isError && <div className="banner-error">Couldn’t load the report.</div>}
      {d && (
        <div className="bug-detail">
          <p className="bug-detail-desc">{d.description}</p>

          <div className="bug-detail-reporter">
            <a href={`mailto:${d.reporter_email}`} className="btn small">
              <Mail size={13} strokeWidth={1.8} /> {d.reporter_email || d.reporter_name}
            </a>
            {d.mood != null && <span className="bug-detail-mood">{MOOD_EMOJI[d.mood]} mood {d.mood}/5</span>}
          </div>

          {d.attachments.length > 0 && (
            <div className="bug-detail-shots">
              {d.attachments.map((a) => (
                <AuthedShot key={a.id} reportId={d.id} att={a} />
              ))}
            </div>
          )}

          <details className="bug-crumbs">
            <summary>Technical breadcrumbs</summary>
            <dl>
              <dt>Page</dt>
              <dd>{d.page_url || '—'}</dd>
              <dt>App</dt>
              <dd>{d.app_version || '—'}</dd>
              <dt>Screen</dt>
              <dd>{d.viewport || '—'}</dd>
              <dt>Browser</dt>
              <dd className="bug-crumbs-ua">{d.user_agent || '—'}</dd>
            </dl>
          </details>

          <div className="bug-triage">
            <div className="field">
              <label>Status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as BugStatus)}>
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="resolved">Resolved</option>
                <option value="wont_fix">Won’t fix</option>
                <option value="closed">Closed</option>
              </select>
            </div>
            <div className="field">
              <label>Priority</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>
          <div className="field">
            <label>Resolution note <span className="muted">(internal)</span></label>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} placeholder="What was done, or why it was closed." />
          </div>

          <div className="modal-actions bug-detail-actions">
            <button className="btn danger" onClick={remove} disabled={del.isPending}>
              <Trash2 size={14} strokeWidth={1.8} /> Delete
            </button>
            <span className="spacer" />
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={save} disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// Private screenshot → authed blob → object URL thumbnail. Opens full size in a
// new tab on click.
function AuthedShot({ reportId, att }: { reportId: string; att: AdminBugAttachment }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let live = true;
    let created: string | null = null;
    fetchBugAttachmentBlob({ kind: 'super' }, reportId, att.id)
      .then((u) => {
        if (live) {
          created = u;
          setSrc(u);
        } else {
          URL.revokeObjectURL(u);
        }
      })
      .catch(() => live && setErr(true));
    return () => {
      live = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [reportId, att.id]);

  if (err) return <div className="bug-shot bug-shot--err">failed</div>;
  if (!src) return <div className="bug-shot bug-shot--loading" />;
  return (
    <a className="bug-shot" href={src} target="_blank" rel="noreferrer" title={att.file_name}>
      <img src={src} alt={att.file_name} />
      <span className="bug-shot-open">
        <ExternalLink size={13} strokeWidth={2} />
      </span>
    </a>
  );
}
