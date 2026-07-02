/**
 * Settings → Printing. Tenant-wide toggles (printing on, kitchen-ticket on,
 * paper width) live on the tenant; the per-device print role + the printer's
 * IP:port live locally (MMKV). A test-print button verifies the connection.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText, MonoText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { ToggleRow, SegmentedField } from '@/components/ui/Field';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantSettings, useUpdateTenantPreferences } from '@/api/tenant';
import { usePrintConfig, DEFAULT_PORT, type PrintWidth } from '@/printing/printerConfig';
import { printTestSlip } from '@/printing/kot';
import { normalizeBase, scanForPrinters } from '@/printing/discovery';
import { toast } from '@/lib/toast';

const WIDTHS: { value: PrintWidth; label: string }[] = [
  { value: '80', label: '80mm' },
  { value: '58', label: '58mm' },
];

export default function PrintingSettings() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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

  const [scanBase, setScanBase] = useState('');
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<string[]>([]);

  async function runScan() {
    const base = normalizeBase(scanBase || ip || rIp);
    if (!base) return toast.error('Enter your Wi-Fi range', 'e.g. 192.168.1 or a printer IP');
    setScanning(true);
    setFound([]);
    try {
      await scanForPrinters(base, { onFound: (hit) => setFound((f) => (f.includes(hit) ? f : [...f, hit])) });
    } catch (e) {
      toast.error('Scan failed', (e as Error).message);
    } finally {
      setScanning(false);
    }
  }

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
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Printing" />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[8],
          gap: theme.spacing[6],
        }}
      >
        {/* Tenant-wide */}
        <Section title="Workspace">
          <Card>
            <View style={{ gap: theme.spacing[4] }}>
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
                </>
              ) : null}
            </View>
          </Card>
          {prefs?.printingEnabled ? (
            <>
              <SegmentedField
                label="Paper width"
                value={width}
                options={WIDTHS}
                onChange={(w) => updatePrefs.mutate({ receiptWidth: w })}
              />
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
        </Section>

        {/* Discovery */}
        <Section title="Find printers on Wi-Fi">
          <TextField
            label="Network range"
            value={scanBase}
            onChangeText={setScanBase}
            placeholder={ip || rIp || '192.168.1'}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            accessibilityLabel="scan-base"
          />
          <Button
            title={scanning ? `Scanning… ${found.length} found` : 'Scan for printers'}
            variant="secondary"
            disabled={scanning}
            onPress={runScan}
          />
          {found.map((f) => (
            <Card
              key={f}
              style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}
            >
              <MonoText>{f}</MonoText>
              <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
                <AssignChip label="Kitchen" onPress={() => { setIp(f); toast.success('Set kitchen IP', f); }} />
                <AssignChip label="Receipt" onPress={() => { setRIp(f); toast.success('Set receipt IP', f); }} />
              </View>
            </Card>
          ))}
          {!scanning && found.length === 0 ? (
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Scans your Wi-Fi for printers on port {DEFAULT_PORT}. Assign a result below, then Save.
            </AppText>
          ) : null}
        </Section>

        {/* This device — kitchen printer */}
        <Section title="Kitchen printer (this device)">
          <Card>
            <ToggleRow
              label="Auto-print kitchen tickets here"
              hint="Only this till prints — avoids every tablet printing a copy"
              value={role.kitchen}
              onValueChange={(v) => setRole({ kitchen: v })}
            />
          </Card>
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
        </Section>

        {/* This device — receipt printer */}
        <Section title="Receipt printer (this device)">
          <Card>
            <ToggleRow
              label="Auto-print receipts here"
              hint="Print the customer receipt on this device when a tab is closed"
              value={role.receipt}
              onValueChange={(v) => setRole({ receipt: v })}
            />
          </Card>
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
        </Section>
      </ScrollView>
    </View>
  );
}

function AssignChip({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`assign-${label}`}
      style={{
        paddingHorizontal: theme.spacing[3],
        paddingVertical: theme.spacing[2],
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        borderColor: theme.colors.primary,
      }}
    >
      <AppText style={{ color: theme.colors.primary, fontSize: theme.text.sm, fontFamily: theme.fonts.bodySemi }}>
        {label}
      </AppText>
    </Pressable>
  );
}
