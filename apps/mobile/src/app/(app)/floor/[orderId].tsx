/**
 * Tab detail — the order-taking screen. `orderId === 'new'` is a draft (the
 * order is created on the first add). Add items via the full-screen menu sheet,
 * adjust qty / notes, void, then send to the kitchen (with a pre-send confirm).
 * On a kitchen-print device with a configured printer, sending also prints a KOT
 * (cook-bound lines snapshotted BEFORE the send, since they flip to in_progress).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { View, ScrollView, Pressable, Modal, TextInput, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as Crypto from 'expo-crypto';
import {
  resolveTableLabel,
  type Order,
  type OrderItemRow,
  type MenuItem,
} from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/theme';
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

  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);

  // Synthetic draft so the screen renders before the order exists.
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

  // Create-on-first-add, deduped across rapid taps.
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

  async function doSend() {
    if (!orderId) return;
    // Snapshot cook-bound lines NOW — the success refetch flips them to in_progress.
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
    // Items already in the kitchen's hands — reprint them as-is.
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
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <AppText style={{ color: theme.colors.primary, fontSize: 22 }}>‹</AppText>
          </Pressable>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => !order.service_table_id && setRenameOpen(true)}
            accessibilityLabel="tab-title"
          >
            <Heading style={{ fontSize: 26 }}>{tableLabel}</Heading>
          </Pressable>
        </View>

        {/* Line items */}
        {orderQ.isLoading && orderId ? (
          <ActivityIndicator color={theme.colors.primary} />
        ) : items.length === 0 ? (
          <AppText variant="muted">No items yet. Tap “Add items” to start the order.</AppText>
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

      {/* Sticky action bar */}
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
          <AppText style={{ fontFamily: theme.fonts.bodyBold, fontSize: theme.text.lg }}>
            {formatNPR(order.live_subtotal_cents)}
          </AppText>
        </View>
        <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
          {canAdd ? (
            <View style={{ flex: 1 }}>
              <Button title="Add items" variant="secondary" onPress={() => setMenuOpen(true)} />
            </View>
          ) : null}
          {canSend && pending.length > 0 ? (
            <View style={{ flex: 1 }}>
              <Button title={`Send ${pending.length}`} onPress={() => setConfirmSend(true)} loading={send.isPending} />
            </View>
          ) : null}
        </View>
        {kitchenPrinter && sent.length > 0 ? (
          <Button title="Reprint kitchen ticket" variant="ghost" onPress={doReprint} />
        ) : null}
      </View>

      <MenuSheet
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onAdd={addMenuItem}
        pendingCount={pending.reduce((n, i) => n + i.qty, 0)}
      />
      <PreSendSheet
        open={confirmSend}
        onClose={() => setConfirmSend(false)}
        pending={pending}
        onConfirm={doSend}
        sending={send.isPending}
      />
      <RenameSheet
        open={renameOpen}
        current={order.table_label ?? ''}
        onClose={() => setRenameOpen(false)}
        onSave={(label) => {
          if (orderId) rename.mutate({ orderId, table_label: label });
          setRenameOpen(false);
        }}
      />
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
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: theme.radii.md,
        padding: theme.spacing[3],
        gap: theme.spacing[2],
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
            <Stepper label="−" onPress={() => onQty(item.qty - 1)} />
            <AppText style={{ fontFamily: theme.fonts.bodySemi, minWidth: 20, textAlign: 'center' }}>
              {item.qty}
            </AppText>
            <Stepper label="+" onPress={() => onQty(item.qty + 1)} />
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
        <Pressable onPress={() => editable && setEditingNote(true)}>
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            » {item.notes}
          </AppText>
        </Pressable>
      ) : editable ? (
        <View style={{ flexDirection: 'row', gap: theme.spacing[4] }}>
          <Pressable onPress={() => setEditingNote(true)} hitSlop={6}>
            <AppText style={{ color: theme.colors.primary, fontSize: theme.text.sm }}>+ Note</AppText>
          </Pressable>
          {canVoid ? (
            <Pressable onPress={onVoid} hitSlop={6}>
              <AppText style={{ color: theme.colors.dangerFg, fontSize: theme.text.sm }}>Remove</AppText>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function Stepper({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label === '+' ? 'increment' : 'decrement'}
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      hitSlop={8}
      style={{
        width: 30,
        height: 30,
        borderRadius: 15,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <AppText style={{ fontSize: 18, color: theme.colors.text }}>{label}</AppText>
    </Pressable>
  );
}

/** Bottom sheet: browse the menu by category and tap to add. */
function MenuSheet({
  open,
  onClose,
  onAdd,
  pendingCount,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (mi: MenuItem) => void;
  pendingCount: number;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const categories = useMenuCategories();
  const items = useMenuItems();
  const [catId, setCatId] = useState<string | null>(null);

  const visible = (items.data ?? []).filter((i) => i.is_active && (!catId || i.category_id === catId));

  return (
    <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: theme.colors.bg, paddingTop: theme.spacing[4] }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: theme.spacing[5] }}>
          <Heading style={{ fontSize: 24 }}>Add items</Heading>
          <Pressable onPress={onClose} hitSlop={10} accessibilityLabel="close-menu">
            <AppText style={{ color: theme.colors.primary, fontFamily: theme.fonts.bodySemi }}>Done</AppText>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: theme.spacing[3], maxHeight: 44 }} contentContainerStyle={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[2] }}>
          <Chip label="All" active={!catId} onPress={() => setCatId(null)} />
          {(categories.data ?? []).map((c) => (
            <Chip key={c.id} label={c.name} active={catId === c.id} onPress={() => setCatId(c.id)} />
          ))}
        </ScrollView>

        <ScrollView contentContainerStyle={{ padding: theme.spacing[5], gap: theme.spacing[3], paddingBottom: insets.bottom + 80 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[3] }}>
            {visible.map((mi) => (
              <Pressable
                key={mi.id}
                accessibilityRole="button"
                accessibilityLabel={`add-${mi.name}`}
                onPress={() => onAdd(mi)}
                style={{
                  width: '48%',
                  minHeight: 84,
                  backgroundColor: theme.colors.card,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: theme.radii.md,
                  padding: theme.spacing[3],
                  justifyContent: 'space-between',
                }}
              >
                <AppText style={{ fontFamily: theme.fonts.bodyMedium }} numberOfLines={2}>
                  {mi.name}
                </AppText>
                <AppText variant="muted">{formatNPR(mi.price_cents)}</AppText>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Pressable
          onPress={onClose}
          style={{
            position: 'absolute',
            left: theme.spacing[5],
            right: theme.spacing[5],
            bottom: insets.bottom + theme.spacing[3],
            backgroundColor: theme.colors.primary,
            borderRadius: theme.radii.md,
            paddingVertical: theme.spacing[4],
            alignItems: 'center',
          }}
        >
          <AppText style={{ color: theme.colors.onBrand, fontFamily: theme.fonts.bodySemi }}>
            Done{pendingCount > 0 ? ` · ${pendingCount} on tab` : ''}
          </AppText>
        </Pressable>
      </View>
    </Modal>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      style={{
        paddingHorizontal: theme.spacing[4],
        height: 36,
        justifyContent: 'center',
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: active ? theme.colors.primary : theme.colors.border,
        backgroundColor: active ? theme.colors.card : 'transparent',
      }}
    >
      <AppText style={{ color: active ? theme.colors.primary : theme.colors.textMuted, fontSize: theme.text.sm }}>
        {label}
      </AppText>
    </Pressable>
  );
}

function PreSendSheet({
  open,
  onClose,
  pending,
  onConfirm,
  sending,
}: {
  open: boolean;
  onClose: () => void;
  pending: OrderItemRow[];
  onConfirm: () => void;
  sending: boolean;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose} />
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radii.xl,
          borderTopRightRadius: theme.radii.xl,
          padding: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[4],
          gap: theme.spacing[3],
        }}
      >
        <Heading style={{ fontSize: 22 }}>Send to kitchen?</Heading>
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
        <Button title={`Confirm — send ${pending.length}`} onPress={onConfirm} loading={sending} />
        <Button title="Back" variant="ghost" onPress={onClose} />
      </View>
    </Modal>
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
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState(current);
  return (
    <Modal visible={open} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose} />
      <View
        style={{
          backgroundColor: theme.colors.surface,
          borderTopLeftRadius: theme.radii.xl,
          borderTopRightRadius: theme.radii.xl,
          padding: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[4],
          gap: theme.spacing[3],
        }}
      >
        <Heading style={{ fontSize: 22 }}>Name this tab</Heading>
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder="e.g. Ram, Table by window"
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
    </Modal>
  );
}
