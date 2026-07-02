/**
 * MenuGrid — category chips + item grid for ordering. Presentational: it reads
 * the menu catalog and reports add/remove back through the controller's
 * callbacks; it holds no order state. Rendered on the phone add-items screen
 * (floor/[orderId]/menu) and in the tablet split-view — a plain screen, so it
 * uses native scrolling (no bottom-sheet scroll region).
 */
import { useState } from 'react';
import { View, ScrollView, type StyleProp, type ViewStyle } from 'react-native';
import { Plus } from 'lucide-react-native';
import type { MenuItem } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Grid } from '@/components/ui/Grid';
import { Stepper } from '@/components/ui/Stepper';
import { AppIcon } from '@/components/ui/Icon';
import { useTheme } from '@/theme';
import { useLayout } from '@/lib/layout';
import { formatNPR } from '@/lib/format';
import { useMenuCategories, useMenuItems, usePopularMenuItems } from '@/api/menu';
import type { OrderController } from './useOrderController';

/** Pseudo-category id for the "Popular" filter (frequently-used items). */
const POPULAR_CAT = '__popular__';

export function MenuGrid({
  ctrl,
  style,
}: {
  ctrl: OrderController;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const layout = useLayout();
  const categories = useMenuCategories();
  const items = useMenuItems();
  const popular = usePopularMenuItems();
  // null = "use the default" — resolved below so we never setState in an effect.
  const [catId, setCatId] = useState<string | null>(null);

  const cats = categories.data ?? [];
  const popularItems = (popular.data ?? []).filter((i) => i.is_active);
  const hasPopular = popularItems.length > 0;
  // Default (mirrors web): Popular when it has items, else the first category.
  const effectiveCat = catId ?? (hasPopular ? POPULAR_CAT : (cats[0]?.id ?? POPULAR_CAT));

  const chips = [
    ...(hasPopular ? [{ id: POPULAR_CAT, label: 'Popular', icon: 'Flame' as string | undefined }] : []),
    ...cats.map((c) => ({ id: c.id, label: c.name, icon: c.icon as string | undefined })),
  ];

  const visible =
    effectiveCat === POPULAR_CAT
      ? popularItems
      : (items.data ?? []).filter((i) => i.is_active && i.category_id === effectiveCat);

  // Many categories would wrap into 4-5 rows and eat half the screen. Past a
  // couple of rows' worth, cap it to two rows that scroll sideways instead
  // (column-major pairs → exactly two rows). Few categories keep the natural wrap.
  const twoRow = chips.length > 6;
  const cols = layout.columns(160, 2, 5);

  const chip = (c: (typeof chips)[number]) => {
    const active = effectiveCat === c.id;
    return (
      <Chip
        key={c.id}
        label={c.label}
        selected={active}
        onPress={() => setCatId(c.id)}
        icon={
          c.icon ? (
            <AppIcon
              name={c.icon}
              size={15}
              color={active ? theme.colors.stamp.brand.fg : theme.colors.textMuted}
            />
          ) : undefined
        }
      />
    );
  };

  return (
    <View style={[{ flex: 1 }, style]}>
      {twoRow ? (
        // Fixed height + flexGrow:0 — a horizontal ScrollView in a flex-column
        // otherwise stretches to fill the height and shoves the grid down.
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, height: 88, marginBottom: theme.spacing[3] }}
          contentContainerStyle={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[2], alignItems: 'flex-start' }}
        >
          {Array.from({ length: Math.ceil(chips.length / 2) }, (_, i) => chips.slice(i * 2, i * 2 + 2)).map(
            (pair, i) => (
              <View key={i} style={{ gap: theme.spacing[2], alignItems: 'flex-start' }}>
                {pair.map(chip)}
              </View>
            ),
          )}
        </ScrollView>
      ) : (
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: theme.spacing[2],
            paddingHorizontal: theme.spacing[5],
            paddingBottom: theme.spacing[3],
          }}
        >
          {chips.map(chip)}
        </View>
      )}

      {/* Item grid — its own scroll region so categories are never clipped. */}
      <ScrollView
        style={{ flex: 1 }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[8],
          gap: theme.spacing[3],
        }}
      >
        <Grid columns={cols}>
          {visible.map((mi) => (
            <MenuItemCard
              key={mi.id}
              item={mi}
              count={ctrl.pendingQtyByItem.get(mi.id) ?? 0}
              onAdd={() => ctrl.addMenuItem(mi)}
              onRemove={() => ctrl.removeMenuItem(mi)}
            />
          ))}
        </Grid>
      </ScrollView>
    </View>
  );
}

function MenuItemCard({
  item,
  count,
  onAdd,
  onRemove,
}: {
  item: MenuItem;
  count: number;
  onAdd: () => void;
  onRemove: () => void;
}) {
  const theme = useTheme();
  const selected = count > 0;
  return (
    <Card
      level={2}
      selected={selected}
      onPress={onAdd}
      accessibilityLabel={`add-${item.name}`}
      style={{ gap: theme.spacing[2] }}
    >
      {/* line 1: icon · name — name gets the full width so short names stay on
          one line (dense); long ones wrap to 2 so "Americano (Single)" vs
          "(Double)" stays readable. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2] }}>
        <View
          style={{
            width: 28,
            height: 28,
            borderRadius: theme.radii.sm,
            // Opaque tint so it never reads as a hard dark box under elevation.
            backgroundColor: selected ? theme.colors.primaryTint : theme.colors.surfaces[1],
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AppIcon name={item.icon} size={16} color={theme.colors.stamp.brand.fg} />
        </View>
        <AppText style={{ fontFamily: theme.fonts.bodyMedium, flex: 1 }} numberOfLines={2}>
          {item.name}
        </AppText>
      </View>

      {/* line 2 — selected: the stepper gets the full row (a 2-col card is too
          narrow for price + a full stepper side by side). Unselected: price +
          the Add hint. */}
      {selected ? (
        // Nested Pressables in Stepper capture their own touch, so +/- never
        // fires the card's add-on-tap.
        <Stepper value={count} min={0} onIncrement={onAdd} onDecrement={onRemove} label={item.name} />
      ) : (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing[2] }}>
          <MonoText size="sm" muted>
            {formatNPR(item.price_cents)}
          </MonoText>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1] }}>
            <Plus size={15} color={theme.colors.textFaint} strokeWidth={2.5} />
            <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
              Add
            </AppText>
          </View>
        </View>
      )}
    </Card>
  );
}
