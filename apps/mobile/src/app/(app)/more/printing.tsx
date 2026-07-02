/**
 * Settings → Printing (mobile) — read-only + test.
 *
 * Printer configuration now lives tenant-wide: an admin sets the networked
 * printers ONCE on the web dashboard and every device pulls it via
 * `useTenantSettings`. This screen therefore does NOT edit anything — it shows
 * what's configured, lets you fire a Test print to verify a printer is reachable,
 * and offers a Wi-Fi scan to help find a printer's IP (which you then type into
 * the web form, since a browser can't scan the LAN). The screen stays gated on
 * `tenant:update` so staff without settings access don't see it.
 */
import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { PrinterConn } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantSettings } from '@/api/tenant';
import { DEFAULT_PORT } from '@/printing/printerConfig';
import { printTestSlip } from '@/printing/kot';
import { normalizeBase, scanForPrinters } from '@/printing/discovery';
import { toast } from '@/lib/toast';

export default function PrintingSettings() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const settings = useTenantSettings();
  const prefs = settings.data?.preferences;

  const kitchen = (prefs?.kitchenPrinters ?? []).filter((p) => p.type === 'network' && !!p.ip?.trim());
  const receipt = prefs?.receiptSameAsKitchen
    ? kitchen
    : (prefs?.receiptPrinters ?? []).filter((p) => p.type === 'network' && !!p.ip?.trim());

  const [scanBase, setScanBase] = useState('');
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<string[]>([]);

  async function runScan() {
    const base = normalizeBase(scanBase || kitchen[0]?.ip || receipt[0]?.ip || '');
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

  // Printing config is an admin/owner surface (matches web's tenant:update gate).
  if (me.data && !can(me.data, 'tenant:update')) return <Redirect href="/more" />;

  const printingOn = !!prefs?.printingEnabled;

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
        <Card>
          <AppText variant="faint" style={{ fontSize: theme.text.sm, lineHeight: theme.text.sm * 1.5 }}>
            Printers are set up once on the web dashboard (Settings → Printing) and apply to
            every device. This screen shows what&apos;s configured and lets you test a printer.
          </AppText>
        </Card>

        <Section title="Status">
          <Card>
            <View style={{ gap: theme.spacing[3] }}>
              <StatusRow label="Printing" value={printingOn ? 'On' : 'Off'} />
              <StatusRow label="Kitchen tickets" value={prefs?.printKitchenTicket ? 'On' : 'Off'} />
              <StatusRow label="Customer receipts" value={prefs?.printCustomerReceipt ? 'On' : 'Off'} />
            </View>
          </Card>
        </Section>

        <Section title="Kitchen printers">
          {kitchen.length > 0 ? (
            kitchen.map((p) => <PrinterRow key={p.id} printer={p} />)
          ) : (
            <EmptyHint text="No kitchen printers configured on the web dashboard yet." />
          )}
        </Section>

        <Section title="Receipt printers">
          {prefs?.receiptSameAsKitchen ? (
            <EmptyHint text="Same as kitchen printers." />
          ) : receipt.length > 0 ? (
            receipt.map((p) => <PrinterRow key={p.id} printer={p} />)
          ) : (
            <EmptyHint text="No receipt printers configured on the web dashboard yet." />
          )}
        </Section>

        <Section title="Find a printer's IP">
          <TextField
            label="Network range"
            value={scanBase}
            onChangeText={setScanBase}
            placeholder={kitchen[0]?.ip || receipt[0]?.ip || '192.168.1'}
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
            <Card key={f}>
              <MonoText>{f}</MonoText>
            </Card>
          ))}
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {found.length > 0
              ? 'Enter these IPs on the web dashboard to add them.'
              : `Scans your Wi-Fi for printers on port ${DEFAULT_PORT}, so you can enter the IP on the web dashboard.`}
          </AppText>
        </Section>
      </ScrollView>
    </View>
  );
}

function StatusRow({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <AppText>{label}</AppText>
      <AppText style={{ fontFamily: theme.fonts.bodySemi, color: theme.colors.textFaint }}>{value}</AppText>
    </View>
  );
}

function EmptyHint({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
      {text}
    </AppText>
  );
}

function PrinterRow({ printer }: { printer: PrinterConn }) {
  const theme = useTheme();
  const [testing, setTesting] = useState(false);

  async function test() {
    setTesting(true);
    try {
      await printTestSlip({ ip: printer.ip.trim(), port: printer.port || DEFAULT_PORT, width: printer.width });
      toast.success('Test slip sent');
    } catch (e) {
      toast.error('Could not reach printer', (e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card style={{ gap: theme.spacing[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing[3] }}>
        <View style={{ flex: 1 }}>
          {printer.label ? (
            <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{printer.label}</AppText>
          ) : null}
          <MonoText style={{ color: theme.colors.textFaint, fontSize: theme.text.sm }}>
            {printer.ip}:{printer.port || DEFAULT_PORT} · {printer.width}mm
          </MonoText>
        </View>
        <Button title="Test" variant="secondary" onPress={test} loading={testing} />
      </View>
    </Card>
  );
}
