/**
 * Add-on picker — opens when a waiter taps an item that has add-on groups.
 * Items WITHOUT groups never open this, so the ordinary one-tap add stays as
 * fast as it was.
 *
 * `size="medium"` (not the default "hug") because the group list is unbounded:
 * only a fixed-height sheet gives AppSheet.ScrollView a scroll region, and a
 * scroll view inside a hug sheet renders perfectly and silently never scrolls.
 *
 * The confirm button lives in the sheet's pinned `footer` so it stays reachable
 * regardless of list length.
 */
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { Check } from 'lucide-react-native';
import {
  addOnsUnitCents,
  resolveAddOnRows,
  resolveModifierGroups,
  type MenuCategory,
  type MenuItem,
  type ModifierGroup,
  type OrderItemAddOn,
} from '@cafe-mgmt/api-types';
import { AppSheet } from '@/components/ui/AppSheet';
import { Button } from '@/components/ui/Button';
import { PressableScale } from '@/components/ui/PressableScale';
import { Stepper } from '@/components/ui/Stepper';
import { AppText, MonoText } from '@/components/ui/Text';
import { DottedLeader } from '@/components/ui/DottedLeader';
import { useTheme } from '@/theme';
import { formatNPR } from '@/lib/format';

type Picks = Record<string, number>;

export function AddOnSheet({
  item,
  category,
  groups,
  loading,
  onClose,
  onConfirm,
}: {
  /** null = closed. Also the remount key, so picks never leak between dishes. */
  item: MenuItem | null;
  category: MenuCategory | undefined;
  groups: ModifierGroup[];
  /** Catalog still in flight — say so rather than claiming there are none. */
  loading?: boolean;
  onClose: () => void;
  onConfirm: (addOns: OrderItemAddOn[]) => void;
}) {
  const effective = useMemo(
    () => (item ? resolveModifierGroups(item, category, groups) : []),
    [item, category, groups],
  );
  return (
    <AppSheet open={item !== null} onClose={onClose} title={item?.name ?? ''} size="medium">
      {item ? (
        <Body key={item.id} item={item} groups={effective} loading={loading} onConfirm={onConfirm} />
      ) : null}
    </AppSheet>
  );
}

function Body({
  item,
  groups,
  loading,
  onConfirm,
}: {
  item: MenuItem;
  groups: ModifierGroup[];
  loading?: boolean;
  onConfirm: (addOns: OrderItemAddOn[]) => void;
}) {
  const theme = useTheme();
  const [picks, setPicks] = useState<Picks>({});

  // Priced rows, resolved from the groups THIS sheet is rendering — so the
  // footer total, the ticket line and the server all agree by construction.
  const chosen: OrderItemAddOn[] = useMemo(
    () =>
      resolveAddOnRows(
        groups,
        Object.entries(picks)
          .filter(([, qty]) => qty > 0)
          .map(([modifier_id, qty]) => ({ modifier_id, qty })),
      ),
    [picks, groups],
  );

  const lineCents = item.price_cents + addOnsUnitCents(chosen);

  // Parens matter: `??` binds looser than `>`.
  const countIn = (g: ModifierGroup) =>
    g.modifiers.reduce((n, mod) => n + ((picks[mod.id] ?? 0) > 0 ? 1 : 0), 0);
  const unmet = groups.filter((g) => g.min_select > 0 && countIn(g) < g.min_select);

  const setQty = (g: ModifierGroup, modID: string, next: number) => {
    const qty = Math.max(0, next);
    // A single-choice group behaves as a radio: picking another option replaces
    // the current one. Refusing the tap would just read as broken.
    if (qty > 0 && g.max_select != null) {
      const others = g.modifiers.filter((m) => m.id !== modID && (picks[m.id] ?? 0) > 0);
      if (others.length + 1 > g.max_select) {
        if (g.max_select === 1) {
          const cleared: Picks = { ...picks };
          for (const o of others) delete cleared[o.id];
          setPicks({ ...cleared, [modID]: qty });
          return;
        }
        return; // multi-select group already full
      }
    }
    const copy: Picks = { ...picks };
    if (qty === 0) delete copy[modID];
    else copy[modID] = qty;
    setPicks(copy);
  };

  return (
    <>
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[6],
          gap: theme.spacing[4],
        }}
      >
        {groups.length === 0 ? (
          <AppText variant="faint">
            {loading ? 'Loading add-ons…' : 'No add-ons configured for this item.'}
          </AppText>
        ) : (
          groups.map((g) => (
            <View key={g.id} style={{ gap: theme.spacing[1] }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'baseline',
                  justifyContent: 'space-between',
                  paddingBottom: theme.spacing[1],
                  borderBottomWidth: 1,
                  borderBottomColor: theme.colors.border,
                }}
              >
                <AppText variant="label">{g.name}</AppText>
                <MonoText size="2xs" muted>
                  {groupRule(g)}
                </MonoText>
              </View>
              {g.modifiers
                .filter((m) => m.is_active)
                .map((mod) => {
                  const qty = picks[mod.id] ?? 0;
                  const single = g.max_select === 1;
                  return (
                    <View
                      key={mod.id}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: theme.spacing[2],
                        paddingVertical: theme.spacing[2],
                      }}
                    >
                      {/* The row itself is the hit target — this is used on a
                          phone mid-service, not with a mouse. */}
                      <PressableScale
                        accessibilityLabel={`addon-${mod.name}`}
                        accessibilityState={{ selected: qty > 0 }}
                        onPress={() => setQty(g, mod.id, qty > 0 && single ? 0 : qty + 1)}
                        style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}
                      >
                        <View
                          style={{
                            width: 20,
                            height: 20,
                            borderRadius: theme.radii.sm,
                            borderWidth: 1,
                            borderColor: qty > 0 ? theme.colors.primary : theme.colors.border,
                            backgroundColor: qty > 0 ? theme.colors.primary : 'transparent',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {qty > 0 ? <Check size={13} strokeWidth={3} color={theme.colors.bg} /> : null}
                        </View>
                        <AppText numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>
                          {mod.name}
                        </AppText>
                        <DottedLeader />
                        <MonoText size="xs" muted>
                          {mod.price_cents > 0 ? `+${formatNPR(mod.price_cents)}` : 'free'}
                        </MonoText>
                      </PressableScale>
                      {/* No stepper on a single-choice group — "×2 Large" is
                          meaningless. Multi-select groups take doubles. */}
                      {!single ? (
                        <Stepper
                          value={qty}
                          onIncrement={() => setQty(g, mod.id, qty + 1)}
                          onDecrement={() => setQty(g, mod.id, qty - 1)}
                          min={0}
                          label={mod.name}
                        />
                      ) : null}
                    </View>
                  );
                })}
            </View>
          ))
        )}
      </AppSheet.ScrollView>

      <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
        {unmet.length > 0 ? (
          <AppText variant="faint" style={{ fontSize: theme.text.xs, color: theme.colors.stamp.warn.fg }}>
            Still needed: {unmet.map((g) => g.name).join(', ')}
          </AppText>
        ) : null}
        <Button
          title={`Add · ${formatNPR(lineCents)}`}
          onPress={() => onConfirm(chosen)}
          disabled={unmet.length > 0}
          accessibilityLabel="addon-confirm"
        />
      </View>
    </>
  );
}

/** Human-readable selection rule, so the waiter knows what's expected before
 *  hitting a validation message. */
function groupRule(g: { min_select: number; max_select?: number | null }): string {
  const { min_select: min, max_select: max } = g;
  if (min > 0 && max === min) return min === 1 ? 'pick one' : `pick ${min}`;
  if (min > 0 && max != null) return `pick ${min}-${max}`;
  if (min > 0) return `pick ${min}+`;
  if (max === 1) return 'optional';
  if (max != null) return `up to ${max}`;
  return 'optional';
}
