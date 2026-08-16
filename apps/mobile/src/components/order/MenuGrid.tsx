/**
 * MenuGrid — category chips + item grid for ordering. Presentational: it reads
 * the menu catalog and reports add/remove back through the controller's
 * callbacks; it holds no order state. Rendered on the phone add-items screen
 * (floor/[orderId]/menu) and in the tablet split-view — a plain screen, so it
 * uses native scrolling (no bottom-sheet scroll region).
 */
import { memo, useCallback } from 'react';
import { View, ScrollView, type StyleProp, type ViewStyle } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Plus } from 'lucide-react-native';
import { formatQty, type MenuItem } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Stepper } from '@/components/ui/Stepper';
import { AppIcon } from '@/components/ui/Icon';
import { useTheme } from '@/theme';
import { useLayout } from '@/lib/layout';
import { formatNPR } from '@/lib/format';
import { useDisplayPrefs, posScaleFactor } from '@/stores/displayPrefs';
import { useMenuUi } from '@/stores/menuUi';
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
  const scale = posScaleFactor(useDisplayPrefs((s) => s.posScale));
  const categories = useMenuCategories();
  const items = useMenuItems();
  const popular = usePopularMenuItems();
  // Kept in a store, not local state: this screen is re-pushed on every "Add
  // items", so component state would reset the category to Popular after each
  // add. null = "use the default" — resolved below so we never setState in an
  // effect.
  const catId = useMenuUi((s) => s.catId);
  const setCatId = useMenuUi((s) => s.setCatId);

  const cats = categories.data ?? [];
  const popularItems = (popular.data ?? []).filter((i) => i.is_active);
  const hasPopular = popularItems.length > 0;
  // Treat "still loading" as Popular: resolving to cats[0] first and flipping
  // once /menu/popular lands inserts a chip at index 0 mid-render, which jumps
  // the chip row (and can cross the two-row threshold below).
  const showPopular = hasPopular || popular.isPending;
  // Default (mirrors web): Popular when it has items, else the first category.
  const fallbackCat = showPopular ? POPULAR_CAT : (cats[0]?.id ?? POPULAR_CAT);
  // A remembered category can vanish — deleted, or belonging to a workspace the
  // user has since switched away from. Only honour one that still exists.
  const remembered =
    catId && (catId === POPULAR_CAT ? showPopular : cats.some((c) => c.id === catId)) ? catId : null;
  const effectiveCat = remembered ?? fallbackCat;

  const chips = [
    ...(showPopular ? [{ id: POPULAR_CAT, label: 'Popular', icon: 'Flame' as string | undefined }] : []),
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
  // Bigger scale → wider min tile → fewer, larger cards.
  const cols = layout.columns(Math.round(160 * scale), 2, 5);
  // Grid gap between cards — matches the old Grid default so the layout reads
  // the same; applied as per-cell margins since FlashList packs columns flush.
  const gap = theme.spacing[2] + 2;

  // The controller rebuilds pendingQtyByItem as a fresh Map on every render
  // (including the 5s poll fallback), so handing that Map to extraData would
  // re-render every mounted cell for nothing. A value signature changes only
  // when a count actually does.
  const qtySig = Array.from(ctrl.pendingQtyByItem, ([id, qty]) => `${id}:${qty}`).join(',');
  const qtyFor = ctrl.pendingQtyByItem;

  const renderItem = useCallback(
    ({ item: mi }: { item: MenuItem }) => (
      <View style={{ flex: 1, marginHorizontal: gap / 2, marginBottom: gap }}>
        <MenuItemCard
          item={mi}
          count={qtyFor.get(mi.id) ?? 0}
          scale={scale}
          // tapMenuItem, not addMenuItem: items with add-on groups need the
          // picker first. Items without groups fall straight through, so an
          // ordinary add is still one tap.
          onAdd={ctrl.tapMenuItem}
          onRemove={ctrl.removeMenuItem}
        />
      </View>
    ),
    // qtySig, not qtyFor: the Map's identity churns, its contents don't.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qtySig, gap, scale, ctrl.tapMenuItem, ctrl.removeMenuItem],
  );

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
              size={Math.round(16 * scale)}
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

      {/* Item grid — virtualized so a big catalog mounts only the visible cards.
          Its own scroll region keeps the category chips from being clipped. */}
      <FlashList
        data={visible}
        numColumns={cols}
        keyExtractor={(mi) => mi.id}
        // Nudge FlashList to re-render visible cards so a just-added qty shows
        // (MenuItemCard is memoized, so untouched cards short-circuit).
        extraData={qtySig}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5] - gap / 2,
          paddingBottom: theme.spacing[8],
        }}
        renderItem={renderItem}
      />
    </View>
  );
}

const MenuItemCard = memo(function MenuItemCard({
  item,
  count,
  scale,
  onAdd,
  onRemove,
}: {
  item: MenuItem;
  count: number;
  scale: number;
  onAdd: (item: MenuItem) => void;
  onRemove: (item: MenuItem) => void;
}) {
  const theme = useTheme();
  const selected = count > 0;
  const tile = Math.round(28 * scale);
  return (
    <Card
      level={2}
      selected={selected}
      onPress={() => onAdd(item)}
      accessibilityLabel={`add-${item.name}`}
      // Tighter vertical padding than the Card default (spacing[3]) so the menu
      // fits more rows per screen; horizontal padding stays at the base.
      style={{ gap: theme.spacing[2], paddingVertical: theme.spacing[2] }}
    >
      {/* line 1: icon · name — name gets the full width so short names stay on
          one line (dense); long ones wrap to 2 so "Americano (Single)" vs
          "(Double)" stays readable. */}
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: theme.spacing[2] }}>
        <View
          style={{
            width: tile,
            height: tile,
            borderRadius: theme.radii.sm,
            // Opaque tint so it never reads as a hard dark box under elevation.
            backgroundColor: selected ? theme.colors.primaryTint : theme.colors.surfaces[1],
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AppIcon name={item.icon} size={Math.round(18 * scale)} color={theme.colors.stamp.brand.fg} />
        </View>
        <AppText
          style={{ fontFamily: theme.fonts.bodyMedium, flex: 1, fontSize: Math.round(15 * scale) }}
          numberOfLines={2}
        >
          {item.name}
        </AppText>
      </View>

      {/* line 2 — selected: the stepper gets the full row (a 2-col card is too
          narrow for price + a full stepper side by side). Unselected: price +
          the Add hint.
          The row reserves the stepper's height in BOTH states: letting the card
          grow on the first tap re-lays out the whole FlashList grid under the
          user's finger, which reads as a flicker/jump mid-order. */}
      <View style={{ minHeight: theme.touch.min + 2, justifyContent: 'center' }}>
        {selected ? (
          // Nested Pressables in Stepper capture their own touch, so +/- never
          // fires the card's add-on-tap.
          <Stepper value={count} min={0} format={formatQty} onIncrement={() => onAdd(item)} onDecrement={() => onRemove(item)} label={item.name} />
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing[2] }}>
            <MonoText size="sm" muted numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>
              {formatNPR(item.price_cents)}
            </MonoText>
            <View
              style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[1], flexShrink: 0 }}
            >
              <Plus size={15} color={theme.colors.textFaint} strokeWidth={2.5} />
              <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
                Add
              </AppText>
            </View>
          </View>
        )}
      </View>
    </Card>
  );
});
