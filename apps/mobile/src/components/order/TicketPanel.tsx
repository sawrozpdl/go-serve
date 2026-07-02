/**
 * TicketPanel — the order as a paper docket: monospaced head, dotted-leader
 * ticket lines, a perforation, then the mono total; a pinned action bar below.
 * Presentational — all state/handlers come from the controller. Sending is
 * direct (tap Send N); hold Send to open the recap sheet.
 */
import { useState } from 'react';
import { View, ScrollView, Pressable, TextInput } from 'react-native';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Pencil, Printer, Trash2, StickyNote } from 'lucide-react-native';
import type { OrderItemRow } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { Stepper } from '@/components/ui/Stepper';
import { DottedLeader } from '@/components/ui/DottedLeader';
import { Perforation } from '@/components/ui/Perforation';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTheme, type Theme } from '@/theme';
import { stampPunch } from '@/theme/motion';
import { formatNPR, timeAgo } from '@/lib/format';
import type { StampTone } from '@cafe-mgmt/design-tokens';
import type { OrderController } from './useOrderController';

const SENT_STAMP: Record<string, { label: string; tone: StampTone } | undefined> = {
  in_progress: { label: 'Sent', tone: 'brand' },
  ready: { label: 'Ready', tone: 'success' },
  served: { label: 'Served', tone: 'neutral' },
};

export function TicketPanel({
  ctrl,
  onBack,
  style,
}: {
  ctrl: OrderController;
  onBack?: () => void;
  style?: object;
}) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { order, items, pending, sent, tableLabel } = ctrl;
  const isWalkIn = !order.service_table_id;

  return (
    <View style={[{ flex: 1, backgroundColor: theme.colors.bg }, style]}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[8],
          gap: theme.spacing[4],
        }}
      >
        {/* Header */}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          {onBack ? (
            <Pressable onPress={onBack} hitSlop={10} accessibilityLabel="back">
              <ChevronLeft size={26} color={theme.colors.stamp.brand.fg} />
            </Pressable>
          ) : null}
          <Pressable
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}
            onPress={() => isWalkIn && ctrl.setRenameOpen(true)}
            accessibilityLabel="tab-title"
          >
            <MonoText size="2xl" weight="bold">
              {tableLabel}
            </MonoText>
            {isWalkIn ? <Pencil size={15} color={theme.colors.textFaint} /> : null}
          </Pressable>
        </View>

        {ctrl.isLoading ? (
          <Card level={2} padded style={{ gap: theme.spacing[2] }}>
            <MonoText size="2xs" muted>
              LOADING…
            </MonoText>
          </Card>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<StickyNote size={28} color={theme.colors.textMuted} />}
            title="This tab is empty"
            hint="Tap Add items to start the order."
          />
        ) : (
          <Card level={2} padded style={{ overflow: 'hidden', gap: theme.spacing[3] }}>
            {/* docket head */}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <MonoText size="2xs" muted style={{ letterSpacing: 1.4 }}>
                DOCKET · {tableLabel.toUpperCase()}
              </MonoText>
              <MonoText size="2xs" muted>
                {timeAgo(order.opened_at)}
              </MonoText>
            </View>
            <View style={{ height: 1, backgroundColor: theme.colors.border }} />

            {/* lines */}
            <View style={{ gap: theme.spacing[3] }}>
              {items.map((it) => (
                <DocketLine
                  key={it.id}
                  item={it}
                  editable={it.kitchen_status === 'pending' && !!ctrl.orderId}
                  canVoid={ctrl.canVoid}
                  syncing={ctrl.queuedIds.has(it.id)}
                  onQty={(qty) => ctrl.setQty(it.id, qty)}
                  onNotes={(notes) => ctrl.setNote(it.id, notes)}
                  onVoid={() => ctrl.voidLine(it.id)}
                />
              ))}
            </View>

            <Perforation />

            {/* total */}
            <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }}>
              <MonoText size="2xs" muted style={{ letterSpacing: 1.6 }}>
                TOTAL
              </MonoText>
              <MonoText size="display" weight="bold">
                {formatNPR(order.live_subtotal_cents)}
              </MonoText>
            </View>
          </Card>
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
          gap: theme.spacing[2],
        }}
      >
        {ctrl.canSend && pending.length > 0 ? (
          <AppText variant="faint" style={{ fontSize: theme.text.xs, textAlign: 'center' }}>
            {pending.length} new item{pending.length === 1 ? '' : 's'} ready to fire · hold Send to review
          </AppText>
        ) : null}
        <View style={{ flexDirection: 'row', gap: theme.spacing[3], alignItems: 'center' }}>
          {ctrl.canAdd ? (
            <View style={{ flex: 1 }}>
              <Button title="Add items" variant="secondary" onPress={() => ctrl.setMenuOpen(true)} />
            </View>
          ) : null}
          {ctrl.canSend && pending.length > 0 ? (
            <View style={{ flex: 1 }}>
              <Button
                title={`Send ${pending.length}`}
                onPress={ctrl.doSend}
                onLongPress={() => ctrl.setConfirmSend(true)}
                loading={ctrl.sendPending}
              />
            </View>
          ) : ctrl.canSettle && items.length > 0 ? (
            <View style={{ flex: 1 }}>
              <Button title="Settle" onPress={() => ctrl.setSettleOpen(true)} />
            </View>
          ) : null}
          {ctrl.kitchenPrinter && sent.length > 0 ? (
            <Pressable
              onPress={ctrl.doReprint}
              hitSlop={8}
              accessibilityLabel="reprint"
              style={{
                width: theme.touch.comfortable + 4,
                height: theme.touch.comfortable + 4,
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
        {ctrl.canSettle && pending.length > 0 && items.length > 0 ? (
          <Button title="Settle tab" variant="ghost" onPress={() => ctrl.setSettleOpen(true)} />
        ) : null}
      </View>
    </View>
  );
}

function DocketLine({
  item,
  editable,
  canVoid,
  syncing,
  onQty,
  onNotes,
  onVoid,
}: {
  item: OrderItemRow;
  editable: boolean;
  canVoid: boolean;
  syncing: boolean;
  onQty: (qty: number) => void;
  onNotes: (notes: string) => void;
  onVoid: () => void;
}) {
  const theme = useTheme();
  const [editingNote, setEditingNote] = useState(false);
  const [note, setNote] = useState(item.notes ?? '');
  const stamp = SENT_STAMP[item.kitchen_status];

  return (
    <View style={{ gap: theme.spacing[1] }}>
      {/* ticket-line idiom: [qty×] name ····· price */}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
        {!editable ? (
          <MonoText weight="bold" style={{ color: theme.colors.stamp.brand.fg }}>
            {item.qty}×
          </MonoText>
        ) : null}
        <AppText style={{ fontFamily: theme.fonts.bodyMedium, flexShrink: 1 }}>{item.menu_item_name}</AppText>
        <DottedLeader />
        <MonoText>{formatNPR(item.line_cents)}</MonoText>
      </View>

      {/* note — amber italic, under the name */}
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
            backgroundColor: theme.colors.surfaces[1],
            borderRadius: theme.radii.sm,
            paddingHorizontal: theme.spacing[3],
            paddingVertical: theme.spacing[2],
            fontFamily: theme.fonts.body,
          }}
        />
      ) : item.notes ? (
        <Pressable
          onPress={() => editable && setEditingNote(true)}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: theme.spacing[3] }}
        >
          <AppText
            style={{ color: theme.colors.stamp.brand.fg, fontStyle: 'italic', fontSize: theme.text.sm, flexShrink: 1 }}
          >
            {item.notes}
          </AppText>
        </Pressable>
      ) : null}

      {/* controls (pending) or status stamp (sent) */}
      {editable ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[4], marginTop: theme.spacing[1] }}>
          <Stepper value={item.qty} min={0} onIncrement={() => onQty(item.qty + 1)} onDecrement={() => onQty(item.qty - 1)} label={item.menu_item_name} />
          <IconAction icon="note" label="Note" onPress={() => setEditingNote(true)} color={theme.colors.stamp.brand.fg} theme={theme} />
          {canVoid ? (
            <IconAction icon="remove" label="Remove" onPress={onVoid} color={theme.colors.dangerFg} theme={theme} />
          ) : null}
        </View>
      ) : stamp ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <Animated.View entering={stampPunch}>
            <Stamp size="sm" tone={stamp.tone} label={stamp.label} />
          </Animated.View>
          {syncing ? (
            <MonoText size="2xs" muted>
              not synced
            </MonoText>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function IconAction({
  icon,
  label,
  onPress,
  color,
  theme,
}: {
  icon: 'note' | 'remove';
  label: string;
  onPress: () => void;
  color: string;
  theme: Theme;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={6} accessibilityLabel={label} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      {icon === 'note' ? <Pencil size={14} color={color} /> : <Trash2 size={14} color={color} />}
      <AppText style={{ color, fontSize: theme.text.sm }}>{label}</AppText>
    </Pressable>
  );
}
