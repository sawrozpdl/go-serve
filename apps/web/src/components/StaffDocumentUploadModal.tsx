import { useRef, useState, type FormEvent } from 'react';
import { UploadCloud, Loader2, FileText } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { useUploadStaffDocument } from '@/lib/api';
import { DOC_TYPE_PRESETS, formatBytes } from '@/lib/staff-docs';
import { toast } from '@/lib/toast';

type Props = {
  open: boolean;
  onClose: () => void;
  staffId: string;
  staffName: string;
};

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

// Attach a typed document (citizenship, licence, …) to a staff member.
export function StaffDocumentUploadModal({ open, onClose, staffId, staffName }: Props) {
  const upload = useUploadStaffDocument(staffId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [docType, setDocType] = useState<string>(DOC_TYPE_PRESETS[0].key);
  const [customLabel, setCustomLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const isOther = docType === 'other';

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    if (!ALLOWED.includes(f.type)) {
      toast.error('Unsupported file', 'Use PDF, PNG, JPEG, or WEBP.');
      return;
    }
    if (f.size > MAX_BYTES) {
      toast.error('File too large', 'Maximum size is 10 MB.');
      return;
    }
    setFile(f);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    try {
      await upload.mutateAsync({
        file,
        docType,
        label: isOther ? customLabel.trim() : undefined,
      });
      toast.success('Document added', `Saved to ${staffName}.`);
      onClose();
    } catch (err) {
      toast.error('Upload failed', (err as { message?: string }).message ?? 'Please try again.');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add document" subtitle={staffName}>
      <form onSubmit={onSubmit}>
        <label>Document type</label>
        <select value={docType} onChange={(e) => setDocType(e.target.value)}>
          {DOC_TYPE_PRESETS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>

        {isOther && (
          <>
            <label>Label</label>
            <input
              value={customLabel}
              onChange={(e) => setCustomLabel(e.target.value)}
              placeholder="e.g. Provident fund form"
            />
          </>
        )}

        <label>File</label>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,image/png,image/jpeg,image/webp"
          hidden
          onChange={(e) => pickFile(e.target.files?.[0])}
        />
        {file ? (
          <div className="staff-doc-pick">
            <FileText size={18} strokeWidth={1.5} />
            <div className="staff-doc-pick__meta">
              <span className="staff-doc-pick__name">{file.name}</span>
              <span className="staff-doc-pick__size">{formatBytes(file.size)}</span>
            </div>
            <button type="button" className="btn small" onClick={() => inputRef.current?.click()}>
              Change
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={`staff-doc-drop${dragOver ? ' is-over' : ''}`}
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              pickFile(e.dataTransfer.files?.[0]);
            }}
          >
            <UploadCloud size={22} strokeWidth={1.5} />
            <span>Drop a file or click to browse</span>
            <span className="staff-doc-drop__hint">PDF, PNG, JPEG or WEBP · up to 10 MB</span>
          </button>
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose} disabled={upload.isPending}>
            Cancel
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={upload.isPending || !file || (isOther && !customLabel.trim())}
          >
            {upload.isPending ? <Loader2 size={14} className="spin" /> : null}
            Upload
          </button>
        </div>
      </form>
    </Modal>
  );
}
