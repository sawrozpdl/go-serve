import { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Search, X } from 'lucide-react';

import { usePopover } from './usePopover';

export type SearchSelectOption = { value: string; label: string };

type Props = {
  options: SearchSelectOption[];
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** When true, the user can type a value not in the option list. */
  allowCustom?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  id?: string;
};

/** Compact searchable select — combo-box pattern. Filters by `label`,
 * supports keyboard nav, and optionally accepts free-text via allowCustom.
 * Designed for short lists (<50 items). */
export function SearchSelect({
  options,
  value,
  onChange,
  placeholder = 'select…',
  allowCustom = false,
  required,
  autoFocus,
  id,
}: Props) {
  const fallbackId = useId();
  const inputId = id ?? fallbackId;
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  // The list is portalled to <body> and positioned fixed: as an absolutely
  // positioned child it was clipped by any ancestor scroller, which is why the
  // report builder's "Whole month" dropdown was unusable. `matchWidth` keeps it
  // the width of the field, as `.ssel-pop`'s left/right:0 used to.
  const clearQuery = useCallback(() => setQuery(''), []);
  const pop = usePopover<HTMLDivElement, HTMLDivElement>({
    width: 0, // unused: matchWidth takes the trigger's width
    matchWidth: true,
    onClose: clearQuery,
  });
  const { open, setOpen, close } = pop;

  const selectedOpt = options.find((o) => o.value === value);
  // The visible text is the chosen label, OR — if free-text is on and the
  // typed value isn't a known option — the raw value, OR the placeholder.
  const displayText = selectedOpt?.label ?? (allowCustom ? value : '');

  const matches = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;

  useEffect(() => {
    if (open) setHighlight(0);
  }, [open, query]);

  const commit = (v: string) => {
    onChange(v);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(matches.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      if (open && matches[highlight]) {
        e.preventDefault();
        commit(matches[highlight].value);
      } else if (allowCustom && query.trim()) {
        e.preventDefault();
        commit(query.trim());
      }
    }
    // Escape is handled by usePopover, which also clears the query on close.
  };

  return (
    <div className={`ssel ${open ? 'open' : ''}`} ref={pop.triggerRef}>
      {!open ? (
        <button
          type="button"
          id={inputId}
          className="ssel-trigger"
          onClick={() => setOpen(true)}
          autoFocus={autoFocus}
        >
          <span className={displayText ? 'ssel-val' : 'ssel-ph'}>
            {displayText || placeholder}
          </span>
          {value && !required && (
            <span
              role="button"
              tabIndex={-1}
              className="ssel-x"
              onClick={(e) => {
                e.stopPropagation();
                commit('');
              }}
              aria-label="clear"
            >
              <X size={12} strokeWidth={1.5} />
            </span>
          )}
          <ChevronDown size={14} strokeWidth={1.5} className="ssel-chev" />
        </button>
      ) : (
        <div className="ssel-active">
          <Search size={14} strokeWidth={1.5} className="ssel-search-ic" />
          <input
            autoFocus
            value={query}
            placeholder={allowCustom ? 'type or pick…' : 'search…'}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
      )}

      {open &&
        createPortal(
          <div className="ssel-pop" ref={pop.popRef} role="listbox" style={pop.style}>
            {matches.length === 0 && !allowCustom && (
              <div className="ssel-empty">No matches</div>
            )}
            {matches.map((o, i) => (
              <button
                type="button"
                key={o.value}
                role="option"
                aria-selected={o.value === value}
                className={`ssel-opt ${i === highlight ? 'hl' : ''} ${o.value === value ? 'sel' : ''}`}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(o.value)}
              >
                {o.label}
              </button>
            ))}
            {allowCustom && query.trim() && !options.some((o) => o.label.toLowerCase() === query.trim().toLowerCase()) && (
              <button
                type="button"
                className="ssel-opt custom"
                onClick={() => commit(query.trim())}
              >
                use “{query.trim()}”
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
