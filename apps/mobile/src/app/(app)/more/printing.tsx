/**
 * Settings → Printing. Tenant-wide toggles (printing on, kitchen-ticket on,
 * paper width) live on the tenant; the per-device print role + the printer's
 * IP:port live locally (MMKV). A test-print button verifies the connection.
 */
import { useState } from 'react';
import { View, Switch, Pressable } from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { Screen } from '@/components/ui/Screen';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantSettings, useUpdateTenantPreferences } from '@/api/tenant';
import { usePrintConfig, DEFAULT_PORT, type PrintWidth } from '@/printing/printerConfig';
import { printTestSlip } from '@/printing/kot';
import { toast } from '@/lib/toast';

export default function PrintingSettings() {
  const theme = useTheme();
  const router = useRouter();
  const me = useMe();
  const settings = useTenantSettings();
  const updatePrefs = useUpdateTenantPreferences();
  const prefs = settings.data?.preferences;

  const role = usePrintConfig((s) => s.role);
  const setRole = usePrintConfig((s) => s.setRole);
  const kitchenPrinter = usePrintConfig((s) => s.kitchenPrinter);
  const setKitchenPrinter = usePrintConfig((s) => s.setKitchenPrinter);
  const receiptPrinter = usePrintConfig((s) => s.receiptPrinter);
  const setReceiptPrinter = usePrintConfig((s) => s.setReceiptPrinter);

  const width: PrintWidth = (prefs?.receiptWidth as PrintWidth) ?? '80';
  const [ip, setIp] = useState(kitchenPrinter?.ip ?? '');
  const [port, setPort] = useState(String(kitchenPrinter?.port ?? DEFAULT_PORT));
  const [rIp, setRIp] = useState(receiptPrinter?.ip ?? '');
  const [rPort, setRPort] = useState(String(receiptPrinter?.port ?? DEFAULT_PORT));
  const [testing, setTesting] = useState<null | 'kitchen' | 'receipt'>(null);

  const saveKitchen = () => {
    const p = parseInt(port, 10);
    if (!ip.trim() || !Number.isFinite(p)) return toast.error('Enter a printer IP and port');
    setKitchenPrinter({ ip: ip.trim(), port: p, width });
    toast.success('Kitchen printer saved');
  };
  const saveReceipt = () => {
    const p = parseInt(rPort, 10);
    if (!rIp.trim() || !Number.isFinite(p)) return toast.error('Enter a printer IP and port');
    setReceiptPrinter({ ip: rIp.trim(), port: p, width });
    toast.success('Receipt printer saved');
  };

  async function testTarget(kind: 'kitchen' | 'receipt', ipStr: string, portStr: string) {
    const target = ipStr.trim() ? { ip: ipStr.trim(), port: parseInt(portStr, 10) || DEFAULT_PORT, width } : null;
    if (!target) return toast.error('Enter a printer IP first');
    setTesting(kind);
    try {
      await printTestSlip(target);
      toast.success('Test slip sent');
    } catch (e) {
      toast.error('Could not reach printer', (e as Error).message);
    } finally {
      setTesting(null);
    }
  }

  // Printing config is an admin/owner surface (matches web's tenant:update gate).
  if (me.data && !can(me.data, 'tenant:update')) return <Redirect href="/more" />;

  return (
    <Screen scroll>
      <View style={{ gap: theme.spacing[6], paddingTop: theme.spacing[3] }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <AppText style={{ color: theme.colors.primary, fontSize: 22 }}>‹</AppText>
          </Pressable>
          <Heading style={{ fontSize: 26 }}>Printing</Heading>
        </View>

        {/* Tenant-wide */}
        <View style={{ gap: theme.spacing[3] }}>
          <AppText variant="label">Workspace</AppText>
          <ToggleRow
            label="Enable printing"
            hint="Master switch for thermal receipts + kitchen tickets"
            value={!!prefs?.printingEnabled}
            onValueChange={(v) => updatePrefs.mutate({ printingEnabled: v })}
          />
          {prefs?.printingEnabled ? (
            <>
              <ToggleRow
                label="Print kitchen tickets"
                hint="Print a KOT when a tab is sent to the kitchen"
                value={!!prefs?.printKitchenTicket}
                onValueChange={(v) => updatePrefs.mutate({ printKitchenTicket: v })}
              />
              <ToggleRow
                label="Print customer receipts"
                hint="Print an itemized receipt when a tab is settled and closed"
                value={!!prefs?.printCustomerReceipt}
                onValueChange={(v) => updatePrefs.mutate({ printCustomerReceipt: v })}
              />
              <View style={{ gap: theme.spacing[2] }}>
                <AppText>Paper width</AppText>
                <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
                  {(['80', '58'] as PrintWidth[]).map((w) => (
                    <WidthChip key={w} width={w} active={width === w} onPress={() => updatePrefs.mutate({ receiptWidth: w })} />
                  ))}
                </View>
              </View>
              {prefs?.printCustomerReceipt && settings.data ? (
                <>
                  <TextField
                    label="Receipt header"
                    defaultValue={prefs?.receiptHeader ?? ''}
                    onEndEditing={(e) => updatePrefs.mutate({ receiptHeader: e.nativeEvent.text })}
                    placeholder="Cafe name, address…"
                    multiline
                    accessibilityLabel="receipt-header"
                  />
                  <TextField
                    label="Receipt footer"
                    defaultValue={prefs?.receiptFooter ?? ''}
                    onEndEditing={(e) => updatePrefs.mutate({ receiptFooter: e.nativeEvent.text })}
                    placeholder="Thank you! / VAT no. / return policy"
                    multiline
                    accessibilityLabel="receipt-footer"
                  />
                </>
              ) : null}
            </>
          ) : null}
        </View>

        {/* This device — kitchen printer */}
        <View style={{ gap: theme.spacing[3] }}>
          <AppText variant="label">Kitchen printer (this device)</AppText>
          <ToggleRow
            label="Auto-print kitchen tickets here"
            hint="Only this till prints — avoids every tablet printing a copy"
            value={role.kitchen}
            onValueChange={(v) => setRole({ kitchen: v })}
          />
          <TextField
            label="Printer IP"
            value={ip}
            onChangeText={setIp}
            placeholder="192.168.1.50"
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            accessibilityLabel="printer-ip"
          />
          <TextField
            label="Port"
            value={port}
            onChangeText={setPort}
            placeholder={String(DEFAULT_PORT)}
            keyboardType="number-pad"
            accessibilityLabel="printer-port"
          />
          <Button title="Save kitchen printer" variant="secondary" onPress={saveKitchen} />
          <Button title="Test print" onPress={() => testTarget('kitchen', ip, port)} loading={testing === 'kitchen'} />
        </View>

        {/* This device — receipt printer */}
        <View style={{ gap: theme.spacing[3] }}>
          <AppText variant="label">Receipt printer (this device)</AppText>
          <ToggleRow
            label="Auto-print receipts here"
            hint="Print the customer receipt on this device when a tab is closed"
            value={role.receipt}
            onValueChange={(v) => setRole({ receipt: v })}
          />
          <TextField
            label="Printer IP"
            value={rIp}
            onChangeText={setRIp}
            placeholder="Same as kitchen, or a separate printer"
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            accessibilityLabel="receipt-printer-ip"
          />
          <TextField
            label="Port"
            value={rPort}
            onChangeText={setRPort}
            placeholder={String(DEFAULT_PORT)}
            keyboardType="number-pad"
            accessibilityLabel="receipt-printer-port"
          />
          <Button title="Save receipt printer" variant="secondary" onPress={saveReceipt} />
          <Button title="Test print" onPress={() => testTarget('receipt', rIp, rPort)} loading={testing === 'receipt'} />
        </View>
      </View>
    </Screen>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onValueChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.spacing[3],
      }}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{label}</AppText>
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {hint}
        </AppText>
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ true: theme.colors.primary, false: theme.colors.border }}
        thumbColor={theme.colors.ink[50]}
      />
    </View>
  );
}

function WidthChip({ width, active, onPress }: { width: PrintWidth; active: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        flex: 1,
        alignItems: 'center',
        paddingVertical: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: active ? theme.colors.primary : theme.colors.border,
        backgroundColor: active ? theme.colors.card : 'transparent',
      }}
    >
      <AppText style={{ color: active ? theme.colors.primary : theme.colors.textMuted }}>{width}mm</AppText>
    </Pressable>
  );
}
