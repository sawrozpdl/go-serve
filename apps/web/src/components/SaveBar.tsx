import { type ReactNode } from 'react';
import { Save } from 'lucide-react';

type Props = {
  dirty: boolean;
  saving?: boolean;
  onSave?: () => void;
  /** Render a custom submit instead of the built-in button. Use when the
   *  surrounding <form> drives the submit (the SaveBar is inside the form). */
  submitButton?: ReactNode;
  /** Override the default "unsaved" / "all saved" labels. */
  dirtyLabel?: string;
  cleanLabel?: string;
  busyLabel?: string;
  saveLabel?: string;
};

export function SaveBar({
  dirty,
  saving,
  onSave,
  submitButton,
  dirtyLabel = 'unsaved changes',
  cleanLabel = 'all changes saved',
  busyLabel = 'Saving…',
  saveLabel = 'Save changes',
}: Props) {
  return (
    <div className="savebar" role="region" aria-label="Save changes">
      <div className="savebar__status">
        {dirty ? (
          <span className="savebar__dirty">{dirtyLabel}</span>
        ) : (
          <span className="savebar__clean">{cleanLabel}</span>
        )}
      </div>
      {submitButton ?? (
        <button
          type="button"
          className="btn primary"
          disabled={saving || !dirty}
          onClick={onSave}
        >
          <Save size={14} strokeWidth={1.5} />
          {saving ? busyLabel : saveLabel}
        </button>
      )}
    </div>
  );
}
