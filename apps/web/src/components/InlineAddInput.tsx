import { useState, type KeyboardEvent } from 'react';
import { Plus } from 'lucide-react';

type Props = {
  placeholder?: string;
  buttonLabel?: string;
  /** Called with the trimmed value when the user submits. Return false to
   *  reject the value (e.g. duplicate) — input is preserved so they can fix it. */
  onAdd: (value: string) => boolean | void;
  /** Disable the input + button (e.g. while a parent operation runs). */
  disabled?: boolean;
  maxLength?: number;
  /** Width of the button column. Use 'auto' for a button sized to its text,
   *  or pass a fixed value (e.g. 120). Default: 'auto'. */
  buttonWidth?: 'auto' | number;
};

/** Paired text input + add-button row.
 *  Layout: `grid-template-columns: 1fr auto` so the input takes the available
 *  width and the button sizes to its content — the two stay vertically aligned
 *  at equal height regardless of label length. Replaces the older
 *  `.row-inputs { 1fr 1fr }` pattern when one side is an action. */
export function InlineAddInput({
  placeholder,
  buttonLabel = 'Add',
  onAdd,
  disabled,
  maxLength,
  buttonWidth = 'auto',
}: Props) {
  const [draft, setDraft] = useState('');

  const submit = () => {
    const v = draft.trim();
    if (!v) return;
    const result = onAdd(v);
    if (result !== false) setDraft('');
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="inline-add"
      style={
        buttonWidth === 'auto'
          ? undefined
          : { gridTemplateColumns: `1fr ${buttonWidth}px` }
      }
    >
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        placeholder={placeholder}
        disabled={disabled}
        maxLength={maxLength}
      />
      <button
        type="button"
        className="btn"
        onClick={submit}
        disabled={disabled || !draft.trim()}
      >
        <Plus size={12} strokeWidth={1.5} />
        {buttonLabel}
      </button>
    </div>
  );
}
