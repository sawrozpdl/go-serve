/**
 * Tab detail — order-taking. All state/handlers live in useOrderController; this
 * file only composes them. On a phone the ticket stands alone and "Add items"
 * pushes the full-screen menu (floor/[orderId]/menu); a tablet shows the menu +
 * ticket side by side. (A brand-new walk-in opens the menu screen directly from
 * the floor, then lands here once its first item creates the order.)
 */
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { formatQty } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { AppSheet } from '@/components/ui/AppSheet';
import { SettleSheet } from '@/components/settle/SettleSheet';
import { useOrderController } from '@/components/order/useOrderController';
import { TicketPanel } from '@/components/order/TicketPanel';
import { MenuGrid } from '@/components/order/MenuGrid';
import { VoidReasonSheet } from '@/components/order/VoidReasonSheet';
import { MoveTableSheet } from '@/components/order/MoveTableSheet';
import { useTheme } from '@/theme';
import { useLayout } from '@/lib/layout';

export default function TabDetail() {
  const theme = useTheme();
  const router = useRouter();
  const { splitView } = useLayout();
  const ctrl = useOrderController();

  const sheets = (
    <>
      <SendRecapSheet ctrl={ctrl} />

      <RenameSheet
        open={ctrl.renameOpen}
        current={ctrl.order.table_label ?? ''}
        onClose={() => ctrl.setRenameOpen(false)}
        onSave={ctrl.renameOrder}
      />

      <VoidReasonSheet
        target={ctrl.voidTarget}
        onClose={() => ctrl.setVoidTarget(null)}
        onConfirm={(reason) => {
          if (ctrl.voidTarget) ctrl.voidLine(ctrl.voidTarget.id, reason);
          ctrl.setVoidTarget(null);
        }}
      />

      <MoveTableSheet ctrl={ctrl} />

      <AppSheet open={ctrl.cancelOpen} onClose={() => ctrl.setCancelOpen(false)} title="Cancel this tab?">
        <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3] }}>
          <AppText variant="muted">
            Frees the table and discards the tab. Only works while nothing has been sent to the kitchen.
          </AppText>
          <Button
            title="Cancel tab"
            variant="danger"
            loading={ctrl.cancelPending}
            onPress={async () => {
              const ok = await ctrl.cancelOrder();
              ctrl.setCancelOpen(false);
              if (ok) router.back();
            }}
          />
          <Button title="Keep tab" variant="ghost" onPress={() => ctrl.setCancelOpen(false)} />
        </View>
      </AppSheet>

      {ctrl.orderId ? (
        <SettleSheet
          open={ctrl.settleOpen}
          orderId={ctrl.orderId}
          tableLabel={ctrl.tableLabel}
          onClose={() => ctrl.setSettleOpen(false)}
          onClosed={() => {
            ctrl.setSettleOpen(false);
            router.back();
          }}
        />
      ) : null}
    </>
  );

  if (splitView) {
    return (
      <View style={{ flex: 1, flexDirection: 'row', backgroundColor: theme.colors.bg }}>
        <MenuGrid ctrl={ctrl} style={{ flex: 3, paddingTop: theme.spacing[6] }} />
        <View style={{ width: 1, backgroundColor: theme.colors.border }} />
        <TicketPanel
          ctrl={ctrl}
          onBack={() => router.back()}
          onCancel={() => ctrl.setCancelOpen(true)}
          onMove={() => ctrl.setMoveOpen(true)}
          style={{ flex: 2, minWidth: 360 }}
        />
        {sheets}
      </View>
    );
  }

  return (
    <>
      <TicketPanel
        ctrl={ctrl}
        onBack={() => router.back()}
        onAddItems={() =>
          router.push({ pathname: '/floor/[orderId]/menu', params: { orderId: ctrl.orderId ?? 'new' } })
        }
        onCancel={() => ctrl.setCancelOpen(true)}
        onMove={() => ctrl.setMoveOpen(true)}
      />
      {sheets}
    </>
  );
}

/** Long-press Send opens this recap — a mini docket of the pending lines with a
 * single confirm. (Default send is direct; this is the review path.) */
function SendRecapSheet({ ctrl }: { ctrl: ReturnType<typeof useOrderController> }) {
  const theme = useTheme();
  return (
    <AppSheet open={ctrl.confirmSend} onClose={() => ctrl.setConfirmSend(false)} title="Send to kitchen?">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3] }}>
        <View style={{ gap: theme.spacing[2] }}>
          {ctrl.pending.map((it) => (
            <View key={it.id} style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
              <MonoText weight="bold" style={{ color: theme.colors.stamp.brand.fg }}>
                {formatQty(it.qty)}×
              </MonoText>
              <AppText style={{ flexShrink: 1 }}>{it.menu_item_name}</AppText>
              {it.notes ? (
                <AppText style={{ color: theme.colors.stamp.brand.fg, fontStyle: 'italic', fontSize: theme.text.sm }}>
                  {it.notes}
                </AppText>
              ) : null}
            </View>
          ))}
        </View>
        <Button title={`Confirm — send ${ctrl.pending.length}`} onPress={ctrl.doSend} loading={ctrl.sendPending} />
      </View>
    </AppSheet>
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
    <AppSheet open={open} onClose={onClose} title="Name this tab">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3] }}>
        <AppSheet.TextInput
          value={value}
          onChangeText={setValue}
          placeholder="e.g. Ram, table by the window"
          placeholderTextColor={theme.colors.textFaint}
          autoFocus
          style={{
            color: theme.colors.text,
            backgroundColor: theme.colors.surfaces[2],
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing[4],
            paddingVertical: theme.spacing[4],
            fontFamily: theme.fonts.body,
            fontSize: theme.text.lg,
          }}
        />
        <Button title="Save" onPress={() => onSave(value.trim())} />
      </View>
    </AppSheet>
  );
}
