import { type ReactNode } from 'react';

export type TabItem<K extends string = string> = {
  key: K;
  label: ReactNode;
  icon?: ReactNode;
  badge?: ReactNode;
};

type Props<K extends string> = {
  items: TabItem<K>[];
  active: K;
  onChange: (key: K) => void;
  ariaLabel?: string;
};

/** Horizontal tab strip used by Settings, Owners, and any page that splits
 *  content into named sections. Pairs with `<PageShell tabs={...}>` for
 *  sticky placement under the header. */
export function Tabs<K extends string>({ items, active, onChange, ariaLabel }: Props<K>) {
  return (
    <div className="page-tabs" role="tablist" aria-label={ariaLabel}>
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          onClick={() => onChange(t.key)}
        >
          {t.icon}
          {t.label}
          {t.badge}
        </button>
      ))}
    </div>
  );
}
