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
import { useRef, useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Outlet, PrinterConn, TenantPreferences } from '@cafe-mgmt/api-types';
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
import { useOutlets } from '@/api/outlets';
import { DEFAULT_PORT, outletTarget, type PrinterTarget } from '@/printing/printerConfig';
import { printTestSlip } from '@/printing/kot';
import { printSampleReceipt, type TenantTaxInfo } from '@/printing/receipt';
import { normalizeBase, scanForPrinters } from '@/printing/discovery';
import { probePrinter } from '@/printing/tcpPrinter';
import { toast } from '@/lib/toast';

export default function PrintingSettings() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const settings = useTenantSettings();
  const outlets = useOutlets();
  const prefs = settings.data?.preferences;

  // Cook dockets route per outlet now — list each outlet's printer. Receipt is
  // still its own tenant-wide list (front counter).
  const outletsWithPrinter = (outlets.data ?? []).filter((o) => !!o.printer_ip?.trim());
  const receipt = (prefs?.receiptPrinters ?? []).filter((p) => p.type === 'network' && !!p.ip?.trim());
  const firstIp = outletsWithPrinter[0]?.printer_ip?.trim() || receipt[0]?.ip || '';

  const tenant = settings.data
    ? {
        name: settings.data.name,
        vat_mode: settings.data.vat_mode,
        vat_pct: settings.data.vat_pct,
        service_charge_pct: settings.data.service_charge_pct,
      }
    : undefined;
  const scanWidth = prefs?.receiptWidth ?? '80';

  const [scanBase, setScanBase] = useState('');
  const [scanning, setScanning] = useState(false);
  const [found, setFound] = useState<string[]>([]);
  const scanSignal = useRef<{ cancelled: boolean } | null>(null);

  async function runScan() {
    // While a sweep runs the same button reads "Stop" — flag it cancelled and
    // let the in-flight probes settle; the finally below clears `scanning`.
    if (scanning) {
      if (scanSignal.current) scanSignal.current.cancelled = true;
      return;
    }
    const typed = scanBase.trim();
    const fullIp = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(typed) ? typed : null;
    const base = normalizeBase(typed || firstIp);
    if (!base) return toast.error('Enter your Wi-Fi range', 'e.g. 192.168.1 or a printer IP');
    setScanning(true);
    setFound([]);
    try {
      if (fullIp) {
        // Exact IP typed — check just that host instead of sweeping the /24
        // (the sweep takes minutes at the native 2-connection limit).
        const ok = await probePrinter(fullIp, DEFAULT_PORT, 4000);
        if (ok) setFound([fullIp]);
        else toast.error(`No printer at ${fullIp}`, `Nothing answered on port ${DEFAULT_PORT}`);
        return;
      }
      const signal = { cancelled: false };
      scanSignal.current = signal;
      await scanForPrinters(base, {
        signal,
        onFound: (hit) => setFound((f) => (f.includes(hit) ? f : [...f, hit])),
      });
    } catch (e) {
      toast.error('Scan failed', (e as Error).message);
    } finally {
      scanSignal.current = null;
      setScanning(false);
    }
  }

  // Printing config is an admin/owner surface (matches web's tenant:update gate).
  if (me.data && !can(me.data, 'tenant:update')) return <Redirect href="/more" />;

  const printingOn = !!prefs?.printingEnabled;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Printing" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[8],
          gap: theme.spacing[6],
        }}
        keyboardShouldPersistTaps="handled"
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

        <Section title="Outlet printers">
          {outletsWithPrinter.length > 0 ? (
            outletsWithPrinter.map((o) => <OutletPrinterRow key={o.id} outlet={o} />)
          ) : (
            <EmptyHint text="No outlet printers configured yet. Add them on the web dashboard (Outlets)." />
          )}
        </Section>

        <Section title="Receipt printers">
          {receipt.length > 0 ? (
            receipt.map((p) => <PrinterRow key={p.id} printer={p} kind="receipt" tenant={tenant} prefs={prefs} />)
          ) : (
            <EmptyHint text="No receipt printers configured on the web dashboard yet." />
          )}
        </Section>

        <Section title="Find a printer's IP">
          <TextField
            label="Network range"
            value={scanBase}
            onChangeText={setScanBase}
            placeholder={firstIp || '192.168.1'}
            keyboardType="numbers-and-punctuation"
            autoCapitalize="none"
            accessibilityLabel="scan-base"
          />
          <Button
            title={scanning ? `Stop · ${found.length} found so far` : 'Scan for printers'}
            variant="secondary"
            onPress={runScan}
          />
          {found.map((f) => (
            <ScanHitRow key={f} ip={f} width={scanWidth} tenant={tenant} prefs={prefs} />
          ))}
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {found.length > 0
              ? 'Print sample to check it’s the right one, then enter its IP on the web dashboard to add it.'
              : `Type an exact IP to check just that printer, or a range like 192.168.1 to sweep your Wi-Fi for printers on port ${DEFAULT_PORT}. Sweeping the full range takes a few minutes.`}
          </AppText>
        </Section>
      </ScrollView>
      </KeyboardAvoidingView>
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

/** One outlet's printer row — test fires a kitchen test slip to its IP. */
function OutletPrinterRow({ outlet }: { outlet: Outlet }) {
  const theme = useTheme();
  const [testing, setTesting] = useState(false);
  const target = outletTarget(outlet);

  async function test() {
    if (!target) return;
    setTesting(true);
    try {
      await printTestSlip(target);
      toast.success(`Test slip sent to ${outlet.name}`);
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
          <AppText style={{ fontFamily: theme.fonts.bodySemi }}>{outlet.name}</AppText>
          <MonoText style={{ color: theme.colors.textFaint, fontSize: theme.text.sm }}>
            {outlet.printer_ip}:{outlet.printer_port || DEFAULT_PORT} · {outlet.printer_width}mm
          </MonoText>
        </View>
        <Button title="Test" variant="secondary" onPress={test} loading={testing} disabled={!target} />
      </View>
    </Card>
  );
}

function PrinterRow({
  printer,
  kind,
  tenant,
  prefs,
}: {
  printer: PrinterConn;
  kind: 'kitchen' | 'receipt';
  tenant?: TenantTaxInfo;
  prefs?: TenantPreferences;
}) {
  const theme = useTheme();
  const [testing, setTesting] = useState(false);

  async function test() {
    setTesting(true);
    try {
      const target: PrinterTarget = { ip: printer.ip.trim(), port: printer.port || DEFAULT_PORT, width: printer.width };
      if (kind === 'receipt' && tenant) {
        await printSampleReceipt(target, tenant, prefs);
        toast.success('Sample receipt sent');
      } else {
        await printTestSlip(target);
        toast.success('Test slip sent');
      }
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
        <Button title={kind === 'receipt' ? 'Test receipt' : 'Test'} variant="secondary" onPress={test} loading={testing} />
      </View>
    </Card>
  );
}

/** A freshly-discovered IP from the scan — lets you fire a sample receipt at it
 *  before you've saved it anywhere, to confirm it's the right printer. */
function ScanHitRow({
  ip,
  width,
  tenant,
  prefs,
}: {
  ip: string;
  width: '58' | '80';
  tenant?: TenantTaxInfo;
  prefs?: TenantPreferences;
}) {
  const theme = useTheme();
  const [printing, setPrinting] = useState(false);

  async function testPrint() {
    setPrinting(true);
    try {
      const target: PrinterTarget = { ip, port: DEFAULT_PORT, width };
      if (tenant) {
        await printSampleReceipt(target, tenant, prefs);
      } else {
        await printTestSlip(target);
      }
      toast.success('Sample receipt sent');
    } catch (e) {
      toast.error('Could not reach printer', (e as Error).message);
    } finally {
      setPrinting(false);
    }
  }

  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: theme.spacing[3] }}>
      <MonoText style={{ flex: 1 }}>{ip}</MonoText>
      <Button title="Test print" variant="secondary" onPress={testPrint} loading={printing} />
    </Card>
  );
}
