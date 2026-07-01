/**
 * Tab detail — order-taking. `orderId === 'new'` is a draft (created on first
 * add). Entering an EMPTY tab opens the menu sheet immediately so a waiter can
 * start ringing items with zero extra taps. Add via the menu sheet (icon cards
 * that show a live count badge), adjust qty / notes, void, then send to the
 * kitchen (pre-send confirm) — which also prints a KOT on a kitchen-print device.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { View, ScrollView, Pressable, TextInput, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import { ChevronLeft, Pencil, Trash2, Printer, Minus, Plus } from 'lucide-react-native';
import { resolveTableLabel, type Order, type OrderItemRow, type MenuItem } from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Sheet } from '@/components/ui/Sheet';
import { AppIcon } from '@/components/ui/Icon';
import { SettleSheet } from '@/components/settle/SettleSheet';
import { useTheme, hexToRgba } from '@/theme';
import { useMenuCategories, useMenuItems } from '@/api/menu';
import { useTenantSettings } from '@/api/tenant';
import {
  useOrder,
  useOpenOrder,
  useAddOrderItems,
  useUpdateOrderItem,
  useVoidOrderItem,
  useSendOrderToKitchen,
  useRenameOrder,
} from '@/api/orders';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { formatNPR } from '@/lib/format';
import { usePrintConfig } from '@/printing/printerConfig';
import { shouldPrintKot, selectCookBoundPending, printKitchenDocket } from '@/printing/kot';
import { toast } from '@/lib/toast';

export default function TabDetail() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ orderId: string; tableId?: string; tableName?: string }>();
  const isDraft = params.orderId === 'new';

  const [createdId, setCreatedId] = useState<string | null>(null);
  const orderId = isDraft ? createdId : params.orderId;

  const me = useMe();
  const settings = useTenantSettings();
  const menuItems = useMenuItems();
  const categories = useMenuCategories();
  const orderQ = useOrder(orderId ?? undefined);

  const openOrder = useOpenOrder();
  const addItems = useAddOrderItems();
  const updateItem = useUpdateOrderItem();
  const voidItem = useVoidOrderItem();
  const send = useSendOrderToKitchen();
  const rename = useRenameOrder();

  const prefs = settings.data?.preferences;
  const role = usePrintConfig((s) => s.role);
  const kitchenPrinter = usePrintConfig((s) => s.kitchenPrinter);
  const stackItems = prefs?.stackItems ?? true;

  const canAdd = can(me.data, 'order:add_items') || can(me.data, 'order:create');
  const canSend = can(me.data, 'order:send_kitchen');
  const canVoid = can(me.data, 'order:void_item');
  const canSettle = can(me.data, 'order:settle');

  // A brand-new tab opens the menu immediately so ordering starts with no extra
  // taps (lazy initial state — avoids a setState-in-effect cascade).
  const [menuOpen, setMenuOpen] = useState<boolean>(() => isDraft);
  const [confirmSend, setConfirmSend] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [settleOpen, setSettleOpen] = useState(false);

  const draft: Order = useMemo(
    () => ({
      id: '',
      service_table_id: params.tableId ?? null,
      service_table_name: params.tableName ?? null,
      table_label: '',
      status: 'open',
      opened_by_user_id: '',
      opened_at: new Date().toISOString(),
      notes: '',
      subtotal_cents: 0,
      discount_cents: 0,
      tax_cents: 0,
      service_charge_cents: 0,
      total_cents: 0,
      live_subtotal_cents: 0,
      items: [],
      items_pending: 0,
      items_in_progress: 0,
      items_ready: 0,
      items_served: 0,
      items_total: 0,
      paid_cents: 0,
    }),
    [params.tableId, params.tableName],
  );
  const order = orderId ? (orderQ.data ?? draft) : draft;
  const items = (order.items ?? []).filter((i) => !i.voided_at);
  const pending = items.filter((i) => i.kitchen_status === 'pending');
  const sent = items.filter((i) => i.kitchen_status === 'in_progress' || i.kitchen_status === 'ready');
  const tableLabel = resolveTableLabel(order);

  // Live pending qty per menu item — powers the count badges in the menu sheet.
  // (Plain compute; React Compiler memoizes it — a manual useMemo here can't be
  // preserved because `pending` is a fresh array each render.)
  const pendingQtyByItem = new Map<string, number>();
  for (const it of pending) pendingQtyByItem.set(it.menu_item_id, (pendingQtyByItem.get(it.menu_item_id) ?? 0) + it.qty);

  const ensureRef = useRef<Promise<string> | null>(null);
  const ensureOrderId = useCallback(async (): Promise<string> => {
    if (orderId) return orderId;
    if (ensureRef.current) return ensureRef.current;
    ensureRef.current = openOrder
      .mutateAsync({ service_table_id: params.tableId ?? null })
      .then((o) => {
        setCreatedId(o.id);
        return o.id;
      })
      .finally(() => {
        ensureRef.current = null;
      });
    return ensureRef.current;
  }, [orderId, openOrder, params.tableId]);

  const addMenuItem = useCallback(
    async (mi: MenuItem) => {
      void Haptics.selectionAsync();
      const id = await ensureOrderId();
      const stack =
        stackItems &&
        (order.items ?? []).find(
          (i) => i.menu_item_id === mi.id && i.kitchen_status === 'pending' && !i.voided_at && !i.notes,
        );
      if (stack) {
        updateItem.mutate({ orderId: id, itemId: stack.id, patch: { qty: stack.qty + 1 } });
      } else {
        addItems.mutate({
          orderId: id,
          items: [{ id: Crypto.randomUUID(), menu_item_id: mi.id, qty: 1 }],
          optimistic: { menu_item_name: mi.name, unit_price_cents: mi.price_cents },
        });
      }
    },
    [ensureOrderId, stackItems, order.items, updateItem, addItems],
  );

  // Remove one of a just-added item straight from the menu sheet — symmetric
  // with add: decrement the stackable (note-free) pending line, voiding it at 1.
  // Falls back to the most recent pending line so − always does something when a
  // count is shown. Only pending lines are touchable (sent items can't unsend).
  const removeMenuItem = useCallback(
    (mi: MenuItem) => {
      if (!orderId) return;
      const lines = (order.items ?? []).filter(
        (i) => i.menu_item_id === mi.id && i.kitchen_status === 'pending' && !i.voided_at,
      );
      if (lines.length === 0) return;
      const line = lines.find((i) => !i.notes) ?? lines[lines.length - 1];
      void Haptics.selectionAsync();
      if (line.qty <= 1) voidItem.mutate({ orderId, itemId: line.id });
      else updateItem.mutate({ orderId, itemId: line.id, patch: { qty: line.qty - 1 } });
    },
    [orderId, order.items, voidItem, updateItem],
  );

  async function doSend() {
    if (!orderId) return;
    const docket = selectCookBoundPending(order, menuItems.data ?? [], categories.data ?? [], prefs);
    setConfirmSend(false);
    try {
      const res = await send.mutateAsync(orderId);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast.success(`${res.sent} item${res.sent === 1 ? '' : 's'} sent to kitchen`);
      if (shouldPrintKot(prefs, role) && kitchenPrinter && docket.length > 0) {
        try {
          await printKitchenDocket({ items: docket, tableLabel, printer: kitchenPrinter });
        } catch (e) {
          toast.error('Sent, but printing failed', (e as Error).message);
        }
      }
    } catch (e) {
      toast.error('Could not send', (e as Error).message);
    }
  }

  async function doReprint() {
    if (!kitchenPrinter || sent.length === 0) return;
    try {
      await printKitchenDocket({ items: sent, tableLabel, printer: kitchenPrinter, reprint: true });
      toast.success('Reprinted kitchen ticket');
    } catch (e) {
      toast.error('Reprint failed', (e as Error).message);
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[10],
          gap: theme.spacing[4],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <ChevronLeft size={26} color={theme.colors.primary} />
          </Pressable>
          <Pressable
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}
            onPress={() => !order.service_table_id && setRenameOpen(true)}
            accessibilityLabel="tab-title"
          >
            <Heading style={{ fontSize: 26 }}>{tableLabel}</Heading>
            {!order.service_table_id ? <Pencil size={15} color={theme.colors.textFaint} /> : null}
          </Pressable>
        </View>

        {orderQ.isLoading && orderId ? (
          <ActivityIndicator color={theme.colors.primary} style={{ marginTop: theme.spacing[6] }} />
        ) : items.length === 0 ? (
          <View style={{ alignItems: 'center', gap: theme.spacing[2], paddingVertical: theme.spacing[8] }}>
            <AppText variant="muted">This tab is empty.</AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Tap “Add items” to start the order.
            </AppText>
          </View>
        ) : (
          <View style={{ gap: theme.spacing[2] }}>
            {items.map((it) => (
              <LineItem
                key={it.id}
                item={it}
                editable={it.kitchen_status === 'pending' && !!orderId}
                canVoid={canVoid}
                onQty={(qty) =>
                  qty <= 0
                    ? voidItem.mutate({ orderId: orderId!, itemId: it.id })
                    : updateItem.mutate({ orderId: orderId!, itemId: it.id, patch: { qty } })
                }
                onNotes={(notes) => updateItem.mutate({ orderId: orderId!, itemId: it.id, patch: { notes } })}
                onVoid={() => voidItem.mutate({ orderId: orderId!, itemId: it.id })}
              />
            ))}
          </View>
        )}
      </ScrollView>

      {/* Action bar */}
      <View
        style={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[3],
          paddingBottom: insets.bottom + theme.spacing[3],
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          backgroundColor: theme.colors.surface,
          gap: theme.spacing[3],
        }}
      >
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <AppText variant="muted">
            {items.length} item{items.length === 1 ? '' : 's'}
          </AppText>
          <AppText style={{ fontFamily: theme.fonts.bodyBold, fontSize: 18 }}>
            {formatNPR(order.live_subtotal_cents)}
          </AppText>
        </View>
        <View style={{ flexDirection: 'row', gap: theme.spacing[3], alignItems: 'center' }}>
          {canAdd ? (
            <View style={{ flex: 1 }}>
              <Button title="Add items" variant="secondary" onPress={() => setMenuOpen(true)} />
            </View>
          ) : null}
          {canSend && pending.length > 0 ? (
            <View style={{ flex: 1 }}>
              <Button title={`Send ${pending.length}`} onPress={() => setConfirmSend(true)} loading={send.isPending} />
            </View>
          ) : canSettle && items.length > 0 ? (
            <View style={{ flex: 1 }}>
              <Button title="Settle" onPress={() => setSettleOpen(true)} />
            </View>
          ) : null}
          {kitchenPrinter && sent.length > 0 ? (
            <Pressable
              onPress={doReprint}
              hitSlop={8}
              accessibilityLabel="reprint"
              style={{
                width: 52,
                height: 52,
                borderRadius: theme.radii.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Printer size={20} color={theme.colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
        {canSettle && pending.length > 0 && items.length > 0 ? (
          <Button title="Settle tab" variant="ghost" onPress={() => setSettleOpen(true)} />
        ) : null}
      </View>

      <MenuSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onAdd={addMenuItem}
        onRemove={removeMenuItem}
        pendingQtyByItem={pendingQtyByItem}
        pendingCount={pending.reduce((n, i) => n + i.qty, 0)}
      />
      <Sheet
        open={confirmSend}
        onClose={() => setConfirmSend(false)}
        title="Send to kitchen?"
      >
        <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3] }}>
          <View style={{ gap: theme.spacing[1] }}>
            {pending.map((it) => (
              <View key={it.id} style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <AppText>
                  {it.qty}× {it.menu_item_name}
                </AppText>
                {it.notes ? (
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                    {it.notes}
                  </AppText>
                ) : null}
              </View>
            ))}
          </View>
          <Button title={`Confirm — send ${pending.length}`} onPress={doSend} loading={send.isPending} />
        </View>
      </Sheet>
      <RenameSheet
        open={renameOpen}
        current={order.table_label ?? ''}
        onClose={() => setRenameOpen(false)}
        onSave={(label) => {
          if (orderId) rename.mutate({ orderId, table_label: label });
          setRenameOpen(false);
        }}
      />
      {orderId ? (
        <SettleSheet
          open={settleOpen}
          orderId={orderId}
          tableLabel={tableLabel}
          onClose={() => setSettleOpen(false)}
          onClosed={() => {
            setSettleOpen(false);
            router.back();
          }}
        />
      ) : null}
    </View>
  );
}

function LineItem({
  item,
  editable,
  canVoid,
  onQty,
  onNotes,
  onVoid,
}: {
  item: OrderItemRow;
  editable: boolean;
  canVoid: boolean;
  onQty: (qty: number) => void;
  onNotes: (notes: string) => void;
  onVoid: () => void;
}) {
  const theme = useTheme();
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(item.notes ?? '');
  const statusTone: Record<string, string> = {
    pending: theme.colors.textFaint,
    in_progress: theme.colors.warnFgTile,
    ready: theme.colors.successFg,
    served: theme.colors.textFaint,
  };

  return (
    <View
      style={{
        backgroundColor: theme.colors.card,
        borderRadius: theme.radii.md,
        borderTopWidth: 1,
        borderTopColor: theme.colors.bevel,
        padding: theme.spacing[3],
        gap: theme.spacing[2],
        ...theme.elevation.card,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
        <View style={{ flex: 1 }}>
          <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{item.menu_item_name}</AppText>
          <AppText style={{ color: statusTone[item.kitchen_status], fontSize: theme.text.xs }}>
            {item.kitchen_status.replace('_', ' ')}
          </AppText>
        </View>
        {editable ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
            <Stepper icon="minus" onPress={() => onQty(item.qty - 1)} />
            <AppText style={{ fontFamily: theme.fonts.bodySemi, minWidth: 20, textAlign: 'center' }}>
              {item.qty}
            </AppText>
            <Stepper icon="plus" onPress={() => onQty(item.qty + 1)} />
          </View>
        ) : (
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>×{item.qty}</AppText>
        )}
        <AppText style={{ minWidth: 64, textAlign: 'right', fontFamily: theme.fonts.bodySemi }}>
          {formatNPR(item.line_cents)}
        </AppText>
      </View>

      {editingNote ? (
        <TextInput
          value={note}
          onChangeText={setNote}
          placeholder="Add a note (e.g. no sugar)"
          placeholderTextColor={theme.colors.textFaint}
          autoFocus
          onBlur={() => {
            setEditingNote(false);
            if (note !== (item.notes ?? '')) onNotes(note);
          }}
          style={{
            color: theme.colors.text,
            backgroundColor: theme.colors.bg,
            borderRadius: theme.radii.sm,
            paddingHorizontal: theme.spacing[3],
            paddingVertical: theme.spacing[2],
            fontFamily: theme.fonts.body,
          }}
        />
      ) : item.notes ? (
        <Pressable onPress={() => editable && setEditingNote(true)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Pencil size={12} color={theme.colors.textFaint} />
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {item.notes}
          </AppText>
        </Pressable>
      ) : editable ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing[5] }}>
          <IconAction icon="note" label="Note" onPress={() => setEditingNote(true)} color={theme.colors.primary} />
          {canVoid ? (
            <IconAction icon="remove" label="Remove" onPress={onVoid} color={theme.colors.dangerFg} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function IconAction({ icon, label, onPress, color }: { icon: 'note' | 'remove'; label: string; onPress: () => void; color: string }) {
  const theme = useTheme();
  return (
    <Pressable onPress={onPress} hitSlop={6} accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {icon === 'note' ? <Pencil size={14} color={color} /> : <Trash2 size={14} color={color} />}
      <AppText style={{ color, fontSize: theme.text.sm }}>{label}</AppText>
    </Pressable>
  );
}

function Stepper({ icon, onPress }: { icon: 'plus' | 'minus'; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={icon === 'plus' ? 'increment' : 'decrement'}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      hitSlop={8}
      style={{
        width: 32,
        height: 32,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {icon === 'plus' ? <Plus size={16} color={theme.colors.text} /> : <Minus size={16} color={theme.colors.text} />}
    </Pressable>
  );
}

function MenuSheet({
  open,
  onClose,
  onAdd,
  onRemove,
  pendingQtyByItem,
  pendingCount,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (mi: MenuItem) => void;
  onRemove: (mi: MenuItem) => void;
  pendingQtyByItem: Map<string, number>;
  pendingCount: number;
}) {
  const theme = useTheme();
  const categories = useMenuCategories();
  const items = useMenuItems();
  const [catId, setCatId] = useState<string | null>(null);

  const visible = (items.data ?? []).filter((i) => i.is_active && (!catId || i.category_id === catId));

  return (
    <Sheet open={open} onClose={onClose} title="Add items" full>
      {/* Category chips — wrap to two rows so there's little scrolling. */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2], paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[3] }}>
        <CategoryChip label="All" active={!catId} onPress={() => setCatId(null)} />
        {(categories.data ?? []).map((c) => (
          <CategoryChip key={c.id} label={c.name} iconName={c.icon} active={catId === c.id} onPress={() => setCatId(c.id)} />
        ))}
      </View>

      {/* Item grid — its own scroll region so categories are never clipped. */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: theme.spacing[5], paddingTop: 0, gap: theme.spacing[3], paddingBottom: theme.spacing[8] }}
      >
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[3] }}>
          {visible.map((mi) => {
            const count = pendingQtyByItem.get(mi.id) ?? 0;
            return (
              <MenuItemCard key={mi.id} item={mi} count={count} onAdd={() => onAdd(mi)} onRemove={() => onRemove(mi)} />
            );
          })}
        </View>
      </ScrollView>

      <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
        <Button title={pendingCount > 0 ? `Done · ${pendingCount} on tab` : 'Done'} onPress={onClose} />
      </View>
    </Sheet>
  );
}

function CategoryChip({ label, iconName, active, onPress }: { label: string; iconName?: string; active: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: theme.spacing[3],
        height: 38,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: active ? theme.colors.primary : theme.colors.border,
        backgroundColor: active ? theme.colors.primaryWash : 'transparent',
      }}
    >
      {iconName ? <AppIcon name={iconName} size={15} color={active ? theme.colors.primary : theme.colors.textMuted} /> : null}
      <AppText style={{ color: active ? theme.colors.primary : theme.colors.textMuted, fontSize: theme.text.sm, fontFamily: active ? theme.fonts.bodySemi : theme.fonts.body }}>
        {label}
      </AppText>
    </Pressable>
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
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`add-${item.name}`}
      onPress={onAdd}
      style={({ pressed }) => ({
        width: '48%',
        minHeight: 96,
        backgroundColor: selected ? theme.colors.primaryWash : theme.colors.card,
        borderColor: selected ? theme.colors.primary : theme.colors.border,
        borderWidth: selected ? 1.5 : 1,
        borderRadius: theme.radii.lg,
        padding: theme.spacing[3],
        justifyContent: 'space-between',
        transform: [{ scale: pressed ? 0.97 : 1 }],
        ...theme.elevation.card,
      })}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: theme.radii.sm,
            // Tint the chip to the surface it sits on so it never reads as a
            // hard dark box — amber-tinted once selected, quiet otherwise.
            backgroundColor: selected ? hexToRgba(theme.colors.primary, 0.2) : theme.colors.surface,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <AppIcon name={item.icon} size={18} color={theme.colors.primary} />
        </View>
        {selected ? (
          <QtyStepper count={count} onAdd={onAdd} onRemove={onRemove} />
        ) : (
          <View
            accessible={false}
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.border,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Plus size={14} color={theme.colors.textFaint} strokeWidth={2.5} />
          </View>
        )}
      </View>
      <View>
        <AppText style={{ fontFamily: theme.fonts.bodyMedium }} numberOfLines={2}>
          {item.name}
        </AppText>
        <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
          {formatNPR(item.price_cents)}
        </AppText>
      </View>
    </Pressable>
  );
}

/** Compact amber stepper for a selected menu card. The − / + are nested
 * Pressables so they capture their own touch and never trigger the card's
 * add-on-tap. − removes one (voiding the line at zero). */
function QtyStepper({ count, onAdd, onRemove }: { count: number; onAdd: () => void; onRemove: () => void }) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        height: 26,
        borderRadius: 13,
        backgroundColor: theme.colors.primary,
        ...theme.elevation.card,
      }}
    >
      <Pressable
        onPress={onRemove}
        accessibilityRole="button"
        accessibilityLabel="remove-one"
        hitSlop={6}
        style={{ width: 28, height: 26, alignItems: 'center', justifyContent: 'center' }}
      >
        <Minus size={14} color={theme.colors.onBrand} strokeWidth={3} />
      </Pressable>
      <AppText
        style={{
          color: theme.colors.onBrand,
          fontSize: theme.text.sm,
          fontFamily: theme.fonts.bodyBold,
          minWidth: 14,
          textAlign: 'center',
        }}
      >
        {count}
      </AppText>
      <Pressable
        onPress={onAdd}
        accessibilityRole="button"
        accessibilityLabel="add-one"
        hitSlop={6}
        style={{ width: 28, height: 26, alignItems: 'center', justifyContent: 'center' }}
      >
        <Plus size={14} color={theme.colors.onBrand} strokeWidth={3} />
      </Pressable>
    </View>
  );
}

function RenameSheet({
  open,
  current,
  onClose,
  onSave,
}: {
  open: boolean;
  current: string;
  onClose: () => void;
  onSave: (label: string) => void;
}) {
  const theme = useTheme();
  const [value, setValue] = useState(current);
  return (
    <Sheet open={open} onClose={onClose} title="Name this tab">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3] }}>
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder="e.g. Ram, table by the window"
          placeholderTextColor={theme.colors.textFaint}
          autoFocus
          style={{
            color: theme.colors.text,
            backgroundColor: theme.colors.card,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing[4],
            paddingVertical: theme.spacing[4],
            fontFamily: theme.fonts.body,
            fontSize: theme.text.lg,
          }}
        />
        <Button title="Save" onPress={() => onSave(value.trim())} />
      </View>
    </Sheet>
  );
}
