import { Search, X } from 'lucide-react';

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Show clear button when value is non-empty. Default true. */
  clearable?: boolean;
  /** Compact variant — smaller padding/font, useful in dense toolbars. */
  compact?: boolean;
  ariaLabel?: string;
  autoFocus?: boolean;
  /** Constrain the min-width (px). Default 180. */
  minWidth?: number;
};

/** Single reusable search input — icon + bare <input> + optional clear,
 *  framed by an outer wrapper that owns the visual border + focus ring.
 *  The inner <input> is stripped of its default frame so the wrapper looks
 *  like one cohesive control regardless of where it's rendered. */
export function SearchInput({
  value,
  onChange,
  placeholder = 'Search',
  clearable = true,
  compact,
  ariaLabel,
  autoFocus,
  minWidth,
}: Props) {
  return (
    <div
      className={`search-input${compact ? ' search-input--compact' : ''}`}
      style={minWidth ? { minWidth } : undefined}
    >
      <Search size={compact ? 12 : 14} strokeWidth={1.5} aria-hidden />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        type="search"
      />
      {clearable && value && (
        <button
          type="button"
          className="search-input__clear"
          onClick={() => onChange('')}
          aria-label="Clear search"
        >
          <X size={compact ? 12 : 14} strokeWidth={1.5} />
        </button>
      )}
    </div>
  );
}
