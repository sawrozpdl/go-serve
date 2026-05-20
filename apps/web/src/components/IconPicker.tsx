import { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';

import { ICON_GROUPS, ICON_REGISTRY, getIconComponent } from './icons';

type Props = {
  value: string;
  onChange: (name: string) => void;
  /** Smaller variant for inline use in compact modals. */
  compact?: boolean;
};

/** Inline icon picker — searchable grid grouped by topic. Empty value
 *  represents "no icon", and the picker exposes a clear button to reset. */
export function IconPicker({ value, onChange, compact }: Props) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ICON_GROUPS;
    return ICON_GROUPS
      .map((g) => ({
        ...g,
        names: g.names.filter((n) => n.toLowerCase().includes(q)),
      }))
      .filter((g) => g.names.length > 0);
  }, [query]);

  const Current = getIconComponent(value);

  return (
    <div className={`icon-picker ${compact ? 'compact' : ''}`}>
      <div className="icon-picker-head">
        <div className="icon-picker-search">
          <Search size={14} strokeWidth={1.5} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search icons"
          />
          {value && (
            <button
              type="button"
              className="icon-picker-clear"
              onClick={() => onChange('')}
              aria-label="Clear icon"
              title="Clear icon"
            >
              <X size={14} strokeWidth={1.5} />
            </button>
          )}
        </div>
        {Current && (
          <div className="icon-picker-current" aria-label={`Selected: ${value}`}>
            <Current size={16} strokeWidth={1.5} />
            <span>{value}</span>
          </div>
        )}
      </div>

      <div className="icon-picker-body">
        {groups.length === 0 && (
          <div className="empty-state" style={{ padding: 12 }}>
            No icons match "{query}".
          </div>
        )}
        {groups.map((g) => (
          <div key={g.label} className="icon-picker-group">
            <div className="icon-picker-group-label">{g.label}</div>
            <div className="icon-picker-grid">
              {g.names.map((name) => {
                const Icon = ICON_REGISTRY[name];
                if (!Icon) return null;
                return (
                  <button
                    key={name}
                    type="button"
                    className={`icon-picker-cell ${value === name ? 'sel' : ''}`}
                    onClick={() => onChange(name)}
                    title={name}
                    aria-label={name}
                  >
                    <Icon size={18} strokeWidth={1.5} />
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Render a stored icon name with a sensible fallback. The fallback is a
 *  small colored dot using the supplied color so existing data without
 *  icons stays visually anchored. */
export function IconGlyph({
  name,
  size = 18,
  color,
  className,
  fallback,
}: {
  name: string | null | undefined;
  size?: number;
  color?: string | null;
  className?: string;
  /** When set, used instead of the colored dot if no icon name matches. */
  fallback?: React.ReactNode;
}) {
  const Icon = getIconComponent(name ?? '');
  if (Icon) {
    return (
      <Icon
        size={size}
        strokeWidth={1.5}
        className={className}
        color={color || undefined}
      />
    );
  }
  if (fallback !== undefined) return <>{fallback}</>;
  return (
    <span
      className={`icon-glyph-dot ${className ?? ''}`}
      style={{ background: color || 'var(--ink-500)', width: size * 0.55, height: size * 0.55 }}
      aria-hidden
    />
  );
}
