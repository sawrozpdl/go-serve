/* EmptyState
 *
 * Replaces the bare `.empty-state` text block with a friendly,
 * cafe-themed graphic + headline + helper. Optional CTA.
 *
 * Use across pages where a list/table can be empty: Floor (no tables),
 * Kitchen (queue empty), Inventory (nothing tracked), Expenses, Top
 * sellers (no sales yet), Tab (no items added yet).
 */

import type { ReactNode } from 'react';
import { SteamingCup } from './SteamingCup';

type Props = {
  icon?: ReactNode;
  /** Optional emoji that floats over the steaming-cup graphic. Falls back
   * to the cup's own steam if not provided. */
  emoji?: string;
  title: string;
  hint?: ReactNode;
  cta?: ReactNode;
  /** Use a smaller, denser variant for in-panel empty states. */
  compact?: boolean;
};

export function EmptyState({ icon, emoji, title, hint, cta, compact = false }: Props) {
  return (
    <div className={`empty-illu${compact ? ' compact' : ''}`}>
      <div className="empty-illu-art" aria-hidden="true">
        {icon ?? <SteamingCup size={compact ? 44 : 72} hero emoji={emoji} />}
      </div>
      <div className="empty-illu-title">{title}</div>
      {hint && <div className="empty-illu-hint">{hint}</div>}
      {cta && <div className="empty-illu-cta">{cta}</div>}
    </div>
  );
}
