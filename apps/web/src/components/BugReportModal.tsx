import { useEffect, useRef, useState } from 'react';
import {
  Bug,
  Lightbulb,
  HelpCircle,
  MessageCircle,
  ImagePlus,
  X,
  ChevronDown,
  Loader2,
  PartyPopper,
  Inbox,
} from 'lucide-react';

import { useSubmitBugReport, useMyBugReports, type BugKind, type MyBugReport } from '@/lib/api';
import { toast } from '@/lib/toast';
import { Modal } from '@/components/Modal';

type Props = {
  open: boolean;
  onClose: () => void;
};

const KINDS: { key: BugKind; emoji: string; label: string; placeholder: string; Icon: typeof Bug }[] = [
  {
    key: 'bug',
    emoji: '🐛',
    label: 'Bug',
    placeholder: "What broke? What did you expect to happen instead? The more, the merrier.",
    Icon: Bug,
  },
  {
    key: 'idea',
    emoji: '💡',
    label: 'Idea',
    placeholder: 'What would make GoServe better for you? Dream big — no idea too small.',
    Icon: Lightbulb,
  },
  {
    key: 'question',
    emoji: '❓',
    label: 'Question',
    placeholder: "What's confusing or unclear? Ask away and we'll help.",
    Icon: HelpCircle,
  },
  {
    key: 'other',
    emoji: '💬',
    label: 'Other',
    placeholder: 'Tell us anything — the good, the bad, the weird.',
    Icon: MessageCircle,
  },
];

const MOODS = [
  { v: 1, e: '😤', label: 'Furious' },
  { v: 2, e: '😟', label: 'Annoyed' },
  { v: 3, e: '😐', label: 'Meh' },
  { v: 4, e: '🙂', label: 'Fine' },
  { v: 5, e: '😄', label: 'Great' },
];

const THANK_YOUS = [
  'Caught it! Our gremlin-hunters are on the case. 🐛',
  'Got it — thank you for making GoServe better. 💛',
  'Boom. Logged and on our radar. 🎯',
  'Thank you! We read every single one of these. 🙌',
  'Noted with love. Onwards! ✨',
];

const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;

type Pick = { id: number; file: File; url: string };

export function BugReportModal({ open, onClose }: Props) {
  const [view, setView] = useState<'compose' | 'mine'>('compose');
  const [kind, setKind] = useState<BugKind>('bug');
  const [mood, setMood] = useState<number | undefined>(undefined);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [sent, setSent] = useState<{ ref: string; message: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(0);

  const submit = useSubmitBugReport();
  const mine = useMyBugReports(open && view === 'mine');

  const active = KINDS.find((k) => k.key === kind)!;

  const reset = () => {
    picks.forEach((p) => URL.revokeObjectURL(p.url));
    setPicks([]);
    setKind('bug');
    setMood(undefined);
    setTitle('');
    setDescription('');
    setSent(null);
    submit.reset();
  };

  // Revoke any outstanding object URLs when the modal unmounts.
  useEffect(() => {
    return () => picks.forEach((p) => URL.revokeObjectURL(p.url));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    reset();
    setView('compose');
    onClose();
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const next: Pick[] = [];
    for (const f of Array.from(files)) {
      if (picks.length + next.length >= MAX_FILES) {
        toast.info('Up to 5 screenshots', 'That should be plenty to show us what you mean.');
        break;
      }
      if (!ALLOWED.includes(f.type)) {
        toast.error('Unsupported file', 'Use PNG, JPEG, WEBP, or GIF.');
        continue;
      }
      if (f.size > MAX_BYTES) {
        toast.error('Screenshot too large', `${f.name} is over 5 MB.`);
        continue;
      }
      next.push({ id: ++idRef.current, file: f, url: URL.createObjectURL(f) });
    }
    if (next.length) setPicks((prev) => [...prev, ...next]);
    if (inputRef.current) inputRef.current.value = '';
  };

  const removePick = (id: number) => {
    setPicks((prev) => {
      const p = prev.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.url);
      return prev.filter((x) => x.id !== id);
    });
  };

  const onSubmit = async () => {
    if (!description.trim()) {
      toast.error('Tell us a little more', 'A short description helps us help you.');
      return;
    }
    try {
      const res = await submit.mutateAsync({
        kind,
        mood,
        title: title.trim() || undefined,
        description: description.trim(),
        files: picks.map((p) => p.file),
      });
      picks.forEach((p) => URL.revokeObjectURL(p.url));
      setPicks([]);
      const message = THANK_YOUS[Math.floor(Math.random() * THANK_YOUS.length)] ?? 'Thank you! 🙌';
      setSent({ ref: res.ref, message });
    } catch (e) {
      toast.error('Could not send', (e as { message?: string }).message ?? 'Please try again.');
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={sent ? 'Thank you!' : 'Share feedback'}
      subtitle={sent ? undefined : 'Found a bug, have an idea, or just stuck? We’re all ears.'}
    >
      {sent ? (
        <SuccessView refCode={sent.ref} message={sent.message} onAnother={reset} onDone={close} />
      ) : (
        <>
          <div className="bug-tabs" role="tablist">
            <button
              role="tab"
              aria-selected={view === 'compose'}
              className={`bug-tab${view === 'compose' ? ' on' : ''}`}
              onClick={() => setView('compose')}
            >
              New
            </button>
            <button
              role="tab"
              aria-selected={view === 'mine'}
              className={`bug-tab${view === 'mine' ? ' on' : ''}`}
              onClick={() => setView('mine')}
            >
              Your reports
            </button>
          </div>

          {view === 'mine' ? (
            <MineView loading={mine.isPending} error={mine.isError} reports={mine.data ?? []} onNew={() => setView('compose')} />
          ) : (
            <div className="bug-compose">
              <div className="bug-kinds" role="radiogroup" aria-label="Type">
                {KINDS.map((k) => (
                  <button
                    key={k.key}
                    type="button"
                    role="radio"
                    aria-checked={kind === k.key}
                    className={`bug-kind${kind === k.key ? ' on' : ''}`}
                    onClick={() => setKind(k.key)}
                  >
                    <span className="bug-kind-emoji" aria-hidden>
                      {k.emoji}
                    </span>
                    <span>{k.label}</span>
                  </button>
                ))}
              </div>

              <div className="field">
                <label>Title <span className="muted">(optional)</span></label>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="A one-line summary"
                  maxLength={140}
                />
              </div>

              <div className="field">
                <label>Details</label>
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={active.placeholder}
                  rows={4}
                  autoFocus
                />
              </div>

              <div className="bug-moods" role="radiogroup" aria-label="How are you feeling about this?">
                <span className="bug-moods-label">How’s this making you feel?</span>
                <div className="bug-moods-row">
                  {MOODS.map((m) => (
                    <button
                      key={m.v}
                      type="button"
                      role="radio"
                      aria-checked={mood === m.v}
                      title={m.label}
                      className={`bug-mood${mood === m.v ? ' on' : ''}`}
                      onClick={() => setMood(mood === m.v ? undefined : m.v)}
                    >
                      {m.e}
                    </button>
                  ))}
                </div>
              </div>

              <div className="bug-shots">
                <input
                  ref={inputRef}
                  type="file"
                  accept={ALLOWED.join(',')}
                  multiple
                  hidden
                  onChange={(e) => addFiles(e.target.files)}
                />
                <div className="bug-thumbs">
                  {picks.map((p) => (
                    <div key={p.id} className="bug-thumb">
                      <img src={p.url} alt={p.file.name} />
                      <button type="button" className="bug-thumb-x" onClick={() => removePick(p.id)} aria-label="Remove">
                        <X size={12} strokeWidth={2} />
                      </button>
                    </div>
                  ))}
                  {picks.length < MAX_FILES && (
                    <button type="button" className="bug-add-shot" onClick={() => inputRef.current?.click()}>
                      <ImagePlus size={18} strokeWidth={1.5} />
                      <span>Screenshot</span>
                    </button>
                  )}
                </div>
              </div>

              <details className="bug-crumbs">
                <summary>
                  <ChevronDown size={13} strokeWidth={2} /> Technical breadcrumbs we’ll include
                </summary>
                <p className="bug-crumbs-note">
                  So you don’t have to explain everything — we attach these automatically:
                </p>
                <dl>
                  <dt>Page</dt>
                  <dd>{window.location.pathname}</dd>
                  <dt>App</dt>
                  <dd>v{__APP_VERSION__}</dd>
                  <dt>Screen</dt>
                  <dd>
                    {window.innerWidth}×{window.innerHeight}
                  </dd>
                  <dt>Browser</dt>
                  <dd className="bug-crumbs-ua">{navigator.userAgent}</dd>
                </dl>
              </details>

              <div className="modal-actions">
                <button type="button" className="btn" onClick={close}>
                  Cancel
                </button>
                <button type="button" className="btn primary" onClick={onSubmit} disabled={submit.isPending}>
                  {submit.isPending ? (
                    <>
                      <Loader2 size={14} className="spin" /> Sending…
                    </>
                  ) : (
                    'Send it'
                  )}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function SuccessView({
  refCode,
  message,
  onAnother,
  onDone,
}: {
  refCode: string;
  message: string;
  onAnother: () => void;
  onDone: () => void;
}) {
  return (
    <div className="bug-success">
      <div className="bug-confetti" aria-hidden>
        {Array.from({ length: 26 }).map((_, i) => (
          <span
            key={i}
            className="bug-confetti-piece"
            style={
              {
                '--x': `${Math.round((Math.random() - 0.5) * 240)}px`,
                '--r': `${Math.round(Math.random() * 720 - 360)}deg`,
                '--d': `${(Math.random() * 0.3).toFixed(2)}s`,
                '--h': `${Math.round(Math.random() * 360)}`,
              } as React.CSSProperties
            }
          />
        ))}
      </div>
      <div className="bug-success-badge">
        <PartyPopper size={30} strokeWidth={1.6} />
      </div>
      <h4>{message}</h4>
      <p className="muted">
        Reference <strong className="bug-ref">#{refCode}</strong> — track it under “Your reports”.
      </p>
      <div className="modal-actions bug-success-actions">
        <button type="button" className="btn" onClick={onAnother}>
          Report another
        </button>
        <button type="button" className="btn primary" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function relTime(iso: string): string {
  const then = new Date(iso).getTime();
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

const STATUS_LABEL: Record<MyBugReport['status'], { label: string; cls: string }> = {
  open: { label: 'Open', cls: '' },
  in_progress: { label: 'In progress', cls: 'warn' },
  resolved: { label: 'Resolved', cls: 'ok' },
  wont_fix: { label: "Won't fix", cls: '' },
  closed: { label: 'Closed', cls: 'ok' },
};

const KIND_EMOJI: Record<BugKind, string> = { bug: '🐛', idea: '💡', question: '❓', other: '💬' };

function MineView({
  loading,
  error,
  reports,
  onNew,
}: {
  loading: boolean;
  error: boolean;
  reports: MyBugReport[];
  onNew: () => void;
}) {
  if (loading) return <div className="bug-mine-empty">Loading…</div>;
  if (error) return <div className="banner-error">Couldn’t load your reports.</div>;
  if (reports.length === 0) {
    return (
      <div className="bug-mine-empty">
        <Inbox size={28} strokeWidth={1.4} />
        <p>No reports yet.</p>
        <button type="button" className="btn primary" onClick={onNew}>
          Send your first
        </button>
      </div>
    );
  }
  return (
    <ul className="bug-mine-list">
      {reports.map((r) => {
        const s = STATUS_LABEL[r.status];
        return (
          <li key={r.id} className="bug-mine-item">
            <span className="bug-mine-emoji" aria-hidden>
              {KIND_EMOJI[r.kind]}
            </span>
            <div className="bug-mine-body">
              <span className="bug-mine-title">{r.title || r.description}</span>
              <span className="muted">{relTime(r.created_at)}</span>
            </div>
            <span className={`pill ${s.cls}`}>{s.label}</span>
          </li>
        );
      })}
    </ul>
  );
}
