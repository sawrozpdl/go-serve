import { useRef, useState } from 'react';
import { ImagePlus, Trash2, Loader2 } from 'lucide-react';

import { useUploadMenuImage } from '@/lib/api';
import { toast } from '@/lib/toast';

type Props = {
  /** Current image URL, or null/'' when none is set. */
  value: string | null | undefined;
  /** Called with the new object URL on a successful upload, or '' on remove. */
  onChange: (url: string) => void;
  /** Preview aspect — 'wide' for category banners, 'square' for item photos. */
  aspect?: 'wide' | 'square';
  /** Short helper text under the control. */
  hint?: string;
};

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

// A self-contained image picker: shows the current image (or an empty drop
// target), uploads the chosen file to the catalog image endpoint, and reports
// the resulting URL back via onChange. Used by the category + item editors.
export function ImageUploadField({ value, onChange, aspect = 'wide', hint }: Props) {
  const upload = useUploadMenuImage();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const pick = () => inputRef.current?.click();

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!ALLOWED.includes(file.type)) {
      toast.error('Unsupported image', 'Use PNG, JPEG, WEBP, or SVG.');
      return;
    }
    if (file.size > MAX_BYTES) {
      toast.error('Image too large', 'Maximum size is 5 MB.');
      return;
    }
    try {
      const { url } = await upload.mutateAsync(file);
      onChange(url);
    } catch (e: unknown) {
      toast.error('Upload failed', (e as { message?: string }).message ?? 'Please try again.');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="img-upload">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        hidden
        onChange={(e) => void handleFile(e.target.files?.[0])}
      />

      {value ? (
        <div className={`img-upload__preview img-upload__preview--${aspect}`}>
          <img src={value} alt="" />
          <div className="img-upload__overlay">
            <button type="button" className="btn small" onClick={pick} disabled={upload.isPending}>
              {upload.isPending ? <Loader2 size={14} className="spin" /> : <ImagePlus size={14} />}
              Replace
            </button>
            <button
              type="button"
              className="btn small danger"
              onClick={() => onChange('')}
              disabled={upload.isPending}
            >
              <Trash2 size={14} /> Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={`img-upload__drop img-upload__drop--${aspect}${dragOver ? ' is-over' : ''}`}
          onClick={pick}
          disabled={upload.isPending}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void handleFile(e.dataTransfer.files?.[0]);
          }}
        >
          {upload.isPending ? (
            <Loader2 size={20} className="spin" />
          ) : (
            <>
              <ImagePlus size={20} strokeWidth={1.5} />
              <span>Add a photo</span>
            </>
          )}
        </button>
      )}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}
