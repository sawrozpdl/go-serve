import { useMemo, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';

import { Modal } from '@/components/Modal';
import { formatNPR } from '@/components/Money';
import {
  addOnsUnitCents,
  resolveModifierGroups,
  type AddOnChoice,
  type MenuCategory,
  type MenuItem,
  type ModifierGroup,
} from '@cafe-mgmt/api-types';

/**
 * Add-on picker shown when a cashier taps an item that has add-on groups.
 *
 * Items with NO groups never open this — TabPage keeps its instant-add path, so
 * the common case stays one tap and the till doesn't get slower for a menu that
 * doesn't use add-ons.
 *
 * The running total in the footer is the line's real price (item + add-ons),
 * because that is the number the cashier reads back to the customer. It's
 * computed with addOnsUnitCents, the same rounding the server and the SQL
 * invariant use, so what's shown here is exactly what gets charged.
 */

/** How many of one modifier are currently picked. */
type Picks = Record<string, number>;

export function AddOnSheet({
  open,
  item,
  category,
  groups,
  onClose,
  onConfirm,
}: {
  open: boolean;
  item: MenuItem | null;
  category: MenuCategory | undefined;
  groups: ModifierGroup[];
  onClose: () => void;
  onConfirm: (addOns: AddOnChoice[]) => void;
}) {
  const effective = useMemo(
    () => (item ? resolveModifierGroups(item, category, groups) : []),
    [item, category, groups],
  );

  if (!item) return null;

  return (
    <Modal
      open={open}
      title={item.name}
      subtitle={`${formatNPR(item.price_cents)} · choose add-ons`}
      onClose={onClose}
    >
      {/* Keyed on the item so opening a DIFFERENT dish remounts with empty
          picks. The picks live in the body precisely so this key resets them —
          holding them in the parent would carry one dish's choices onto the
          next. */}
      <AddOnSheetBody key={item.id} item={item} groups={effective} onConfirm={onConfirm} />
    </Modal>
  );
}

function AddOnSheetBody({
  item,
  groups,
  onConfirm,
}: {
  item: MenuItem;
  groups: ModifierGroup[];
  onConfirm: (addOns: AddOnChoice[]) => void;
}) {
  const [picks, setPicks] = useState<Picks>({});
  const chosen: AddOnChoice[] = useMemo(
    () =>
      Object.entries(picks)
        .filter(([, qty]) => qty > 0)
        .map(([modifier_id, qty]) => ({ modifier_id, qty })),
    [picks],
  );

  // Price the sheet from the catalog rows the user can actually see, so the
  // footer total can't drift from what's on screen.
  const priceByID = useMemo(() => {
    const m = new Map<string, number>();
    for (const g of groups) for (const mod of g.modifiers) m.set(mod.id, mod.price_cents);
    return m;
  }, [groups]);

  const addOnCents = addOnsUnitCents(
    chosen.map((c) => ({ price_cents: priceByID.get(c.modifier_id) ?? 0, qty: c.qty ?? 1 })),
  );
  const lineCents = item.price_cents + addOnCents;

  // A required group with nothing picked blocks the add — the same rule the API
  // enforces, surfaced here so the cashier sees WHY rather than getting a 400.
  // NB the parens around `picks[mod.id] ?? 0` matter: `??` binds looser than
  // `>`, so without them this counts every modifier as picked.
  const countIn = (g: ModifierGroup) =>
    g.modifiers.reduce((n, mod) => n + ((picks[mod.id] ?? 0) > 0 ? 1 : 0), 0);
  const unmet = groups.filter((g) => g.min_select > 0 && countIn(g) < g.min_select);

  const bump = (g: ModifierGroup, modID: string, delta: number) => {
    const cur = picks[modID] ?? 0;
    const next = Math.max(0, cur + delta);
    // Enforce max_select client-side too. For a single-choice group (max 1) this
    // makes picking a second option REPLACE the first, which is what a size
    // picker should do — rejecting the tap would just feel broken.
    if (delta > 0 && g.max_select != null) {
      const others = g.modifiers.filter((m) => m.id !== modID && (picks[m.id] ?? 0) > 0);
      const distinct = others.length + (next > 0 ? 1 : 0);
      if (distinct > g.max_select) {
        if (g.max_select === 1) {
          const cleared: Picks = { ...picks };
          for (const o of others) delete cleared[o.id];
          setPicks({ ...cleared, [modID]: next });
          return;
        }
        return; // multi-select group already full — ignore the tap
      }
    }
    const copy: Picks = { ...picks };
    if (next === 0) delete copy[modID];
    else copy[modID] = next;
    setPicks(copy);
  };

  return (
    <div className="addon-sheet">
      {groups.length === 0 ? (
        <div className="drill-empty">No add-ons configured for this item.</div>
      ) : (
        groups.map((g) => (
          <div key={g.id} className="addon-group">
            <div className="addon-group-head">
              <span>{g.name}</span>
              <span className="addon-group-rule">{groupRule(g)}</span>
            </div>
            {g.modifiers.length === 0 ? (
              <div className="drill-empty">Nothing in this group yet.</div>
            ) : (
              g.modifiers
                .filter((m) => m.is_active)
                .map((mod) => {
                  const qty = picks[mod.id] ?? 0;
                  const single = g.max_select === 1;
                  return (
                    <div key={mod.id} className={`addon-row${qty > 0 ? ' is-picked' : ''}`}>
                      <button
                        type="button"
                        className="addon-row-main"
                        aria-pressed={qty > 0}
                        onClick={() => bump(g, mod.id, qty > 0 && single ? -1 : 1)}
                      >
                        <span className="addon-row-check">{qty > 0 && <Check size={13} strokeWidth={2.4} />}</span>
                        <span className="addon-row-name">{mod.name}</span>
                        <span className="addon-row-price">
                          {mod.price_cents > 0 ? `+ ${formatNPR(mod.price_cents)}` : 'free'}
                        </span>
                      </button>
                      {/* A single-choice group is a radio, so no stepper: a
                          "×2 Large" is meaningless. Multi-select groups can
                          take doubles (double cheese). */}
                      {!single && (
                        <span className="addon-row-step">
                          <button
                            type="button"
                            className="btn icon"
                            aria-label={`one less ${mod.name}`}
                            disabled={qty === 0}
                            onClick={() => bump(g, mod.id, -1)}
                          >
                            <Minus size={13} strokeWidth={2} />
                          </button>
                          <span className="addon-row-qty">{qty}</span>
                          <button
                            type="button"
                            className="btn icon"
                            aria-label={`one more ${mod.name}`}
                            onClick={() => bump(g, mod.id, 1)}
                          >
                            <Plus size={13} strokeWidth={2} />
                          </button>
                        </span>
                      )}
                    </div>
                  );
                })
            )}
          </div>
        ))
      )}

      <div className="addon-foot">
        {unmet.length > 0 && (
          <div className="addon-unmet" role="status">
            Pick {unmet.map((g) => g.name).join(', ')} to continue.
          </div>
        )}
        <button
          type="button"
          className="btn primary addon-confirm"
          disabled={unmet.length > 0}
          onClick={() => onConfirm(chosen)}
        >
          Add · {formatNPR(lineCents)}
        </button>
      </div>
    </div>
  );
}

/** Human-readable selection rule, so the cashier knows what's expected before
 *  hitting a validation message. */
function groupRule(g: { min_select: number; max_select?: number | null }): string {
  const { min_select: min, max_select: max } = g;
  if (min > 0 && max === min) return min === 1 ? 'pick one' : `pick ${min}`;
  if (min > 0 && max != null) return `pick ${min}–${max}`;
  if (min > 0) return `pick at least ${min}`;
  if (max === 1) return 'optional · pick one';
  if (max != null) return `optional · up to ${max}`;
  return 'optional';
}
