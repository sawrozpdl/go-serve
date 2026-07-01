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

  const width: PrintWidth = (prefs?.receiptWidth as PrintWidth) ?? '80';
  const [ip, setIp] = useState(kitchenPrinter?.ip ?? '');
  const [port, setPort] = useState(String(kitchenPrinter?.port ?? DEFAULT_PORT));
  const [testing, setTesting] = useState(false);

  const savePrinter = () => {
    const p = parseInt(port, 10);
    if (!ip.trim() || !Number.isFinite(p)) {
      toast.error('Enter a printer IP and port');
      return;
    }
    setKitchenPrinter({ ip: ip.trim(), port: p, width });
    toast.success('Printer saved');
  };

  async function onTest() {
    const target = kitchenPrinter ?? (ip.trim() ? { ip: ip.trim(), port: parseInt(port, 10) || DEFAULT_PORT, width } : null);
    if (!target) {
      toast.error('Save a printer first');
      return;
    }
    setTesting(true);
    try {
      await printTestSlip(target);
      toast.success('Test slip sent');
    } catch (e) {
      toast.error('Could not reach printer', (e as Error).message);
    } finally {
      setTesting(false);
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
              <View style={{ gap: theme.spacing[2] }}>
                <AppText>Paper width</AppText>
                <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
                  {(['80', '58'] as PrintWidth[]).map((w) => (
                    <WidthChip key={w} width={w} active={width === w} onPress={() => updatePrefs.mutate({ receiptWidth: w })} />
                  ))}
                </View>
              </View>
            </>
          ) : null}
        </View>

        {/* This device */}
        <View style={{ gap: theme.spacing[3] }}>
          <AppText variant="label">This device</AppText>
          <ToggleRow
            label="Auto-print kitchen tickets here"
            hint="Only this till prints — avoids every tablet printing a copy"
            value={role.kitchen}
            onValueChange={(v) => setRole({ kitchen: v })}
          />
          <TextField
            label="Kitchen printer IP"
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
          <Button title="Save printer" variant="secondary" onPress={savePrinter} />
          <Button title="Test print" onPress={onTest} loading={testing} />
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
