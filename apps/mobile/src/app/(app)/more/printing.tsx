/**
 * Settings → Printing.
 *
 * Printer configuration is tenant-wide: set once, pulled by every device via
 * `useTenantSettings`. This screen used to be read-only, which produced the
 * single worst loop in the app — the phone would SCAN the Wi-Fi, find the
 * printer, print a sample to prove it was the right one, and then tell the
 * operator to go and type that IP into a web dashboard. The phone is the only
 * device that can scan a LAN at all (a browser cannot), so it was the one tool
 * that could finish the job and the one that refused to.
 *
 * "Add this printer" closes that loop. Everything else here — the toggles, the
 * paper width, the receipt header and footer — is the same tenant preference
 * object, and is editable for the same reason: the person setting up a printer
 * is standing next to it, not at a laptop.
 *
 * Gated on `tenant:update`, matching web.
 */
import { useRef, useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { Redirect } from 'expo-router';
import { Plus, Trash2 } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Outlet, PrinterConn, TenantPreferences } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { ToggleRow, SegmentedField } from '@/components/ui/Field';
import { StackHeader } from '@/components/ui/StackHeader';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { ImageField } from '@/components/ui/ImageField';
import { useLayout, readableContent } from '@/lib/layout';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useTenantSettings, useUpdateTenantPreferences } from '@/api/tenant';
import { useOutlets } from '@/api/outlets';
import { useUploadReceiptImage } from '@/api/uploads';
import { DEFAULT_PORT, outletTarget, type PrinterTarget } from '@/printing/printerConfig';
import { printTestSlip } from '@/printing/kot';
import { printSampleReceipt, type TenantTaxInfo } from '@/printing/receipt';
import { normalizeBase, scanForPrinters } from '@/printing/discovery';
import { probePrinter } from '@/printing/tcpPrinter';
import { toast } from '@/lib/toast';

export default function PrintingSettings() {
  const theme = useTheme();
  const layout = useLayout();
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

  const update = useUpdateTenantPreferences();
  const uploadReceiptImage = useUploadReceiptImage();

  /** Replace the receipt-printer list wholesale (the pref is one array). */
  const saveReceiptPrinters = (next: PrinterConn[], done?: () => void) =>
    update.mutate(
      { receiptPrinters: next },
      { onSuccess: done, onError: (e) => toast.error('Could not save', (e as Error).message) },
    );

  const addPrinter = (ip: string) => {
    const all = prefs?.receiptPrinters ?? [];
    if (all.some((p) => p.ip.trim() === ip)) {
      return toast.error('Already added', `${ip} is already a receipt printer.`);
    }
    saveReceiptPrinters(
      [
        ...all,
        {
          // Derived from the IP rather than a clock: it is already unique
          // among printers (the guard above enforces it), stable across a
          // reload, and pure — a Date.now() here is a React Compiler
          // purity error inside a component body.
          id: `pr-${ip}`,
          type: 'network',
          ip,
          port: DEFAULT_PORT,
          width: scanWidth,
        },
      ],
      () => toast.success(`${ip} added`, 'It will print receipts on every device.'),
    );
  };

  const removePrinter = (p: PrinterConn) =>
    Alert.alert('Remove this printer?', `${p.label || p.ip} will stop receiving receipts.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          saveReceiptPrinters(
            (prefs?.receiptPrinters ?? []).filter((x) => x.id !== p.id),
            () => toast.success('Printer removed'),
          ),
      },
    ]);

  // Receipt header/footer are free text, so they keep an explicit Save —
  // a half-typed address is not a preference. null = untouched.
  const savedHeader = prefs?.receiptHeader ?? '';
  const savedFooter = prefs?.receiptFooter ?? '';
  const [headerEdit, setHeaderEdit] = useState<string | null>(null);
  const [footerEdit, setFooterEdit] = useState<string | null>(null);
  const header = headerEdit ?? savedHeader;
  const footer = footerEdit ?? savedFooter;
  const textDirty = header !== savedHeader || footer !== savedFooter;
  const saveText = () =>
    update.mutate(
      { receiptHeader: header, receiptFooter: footer },
      {
        onSuccess: () => {
          setHeaderEdit(null);
          setFooterEdit(null);
          toast.success('Receipt wording saved');
        },
        onError: (e) => toast.error('Could not save', (e as Error).message),
      },
    );

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
          ...readableContent(layout),
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[8],
          gap: theme.spacing[6],
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Section title="What prints">
          <Card>
            <View style={{ gap: theme.spacing[4] }}>
              <ToggleRow
                label="Printing"
                hint="Master switch. Off means no print action appears anywhere."
                value={printingOn}
                onValueChange={(v) => update.mutate({ printingEnabled: v })}
              />
              {printingOn ? (
                <>
                  <ToggleRow
                    label="Kitchen dockets"
                    hint="Print a cook docket to the station's printer when a tab is sent"
                    value={!!prefs?.printKitchenTicket}
                    onValueChange={(v) => update.mutate({ printKitchenTicket: v })}
                  />
                  <ToggleRow
                    label="Customer receipts"
                    hint="Print a receipt to the counter printer when a tab is settled"
                    value={!!prefs?.printCustomerReceipt}
                    onValueChange={(v) => update.mutate({ printCustomerReceipt: v })}
                  />
                  <SegmentedField
                    label="Paper width"
                    value={scanWidth}
                    options={[
                      { value: '80', label: '80mm' },
                      { value: '58', label: '58mm' },
                    ]}
                    onChange={(receiptWidth) => update.mutate({ receiptWidth })}
                  />
                </>
              ) : null}
            </View>
          </Card>
        </Section>

        <Section title="Receipt wording">
          <Card>
            <View style={{ gap: theme.spacing[3] }}>
              <TextField
                label="Header"
                value={header}
                onChangeText={setHeaderEdit}
                placeholder={settings.data?.name ?? 'Cafe name, address, PAN…'}
                multiline
                accessibilityLabel="receipt-header"
                style={{ minHeight: 88, textAlignVertical: 'top' }}
              />
              <TextField
                label="Footer"
                value={footer}
                onChangeText={setFooterEdit}
                placeholder="Thank you!"
                multiline
                accessibilityLabel="receipt-footer"
                style={{ minHeight: 72, textAlignVertical: 'top' }}
              />
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                Printed at the top and foot of every customer receipt. Blank header falls back to
                the workspace name.
              </AppText>
              <Button
                title="Save wording"
                onPress={saveText}
                loading={update.isPending}
                disabled={!textDirty}
              />
              {/* Saved on its own rather than with the wording: the upload has
                  already happened by the time onChange fires, so making the
                  operator press Save again to keep it would be a trap. */}
              <ImageField
                label="Receipt image"
                hint="A small black-and-white image above the footer — usually a payment QR."
                value={prefs?.receiptImageUrl}
                onChange={(receiptImageUrl) =>
                  update.mutate(
                    { receiptImageUrl },
                    { onError: (e) => toast.error('Could not save', (e as Error).message) },
                  )
                }
                upload={uploadReceiptImage.mutateAsync}
              />
              {prefs?.receiptImageUrl ? (
                <TextField
                  label="Caption under the image"
                  value={prefs.receiptImageLabel ?? ''}
                  onChangeText={(receiptImageLabel) => update.mutate({ receiptImageLabel })}
                  placeholder="Use this QR to pay"
                  accessibilityLabel="receipt-image-label"
                />
              ) : null}
            </View>
          </Card>
        </Section>

        <Section title="Station printers">
          {outletsWithPrinter.length > 0 ? (
            outletsWithPrinter.map((o) => <OutletPrinterRow key={o.id} outlet={o} />)
          ) : (
            <EmptyHint text="No station printers configured yet. Add them on the web dashboard (Stations)." />
          )}
        </Section>

        <Section title="Receipt printers">
          {receipt.length > 0 ? (
            receipt.map((p) => (
              <PrinterRow
                key={p.id}
                printer={p}
                kind="receipt"
                tenant={tenant}
                prefs={prefs}
                onRemove={() => removePrinter(p)}
              />
            ))
          ) : (
            <EmptyHint text="No receipt printers yet. Scan below to find one and add it." />
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
            <ScanHitRow
              key={f}
              ip={f}
              width={scanWidth}
              tenant={tenant}
              prefs={prefs}
              added={receipt.some((p) => p.ip.trim() === f)}
              adding={update.isPending}
              onAdd={() => addPrinter(f)}
            />
          ))}
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {found.length > 0
              ? 'Print a sample to check it is the right one, then add it — no trip to a laptop.'
              : `Type an exact IP to check just that printer, or a range like 192.168.1 to sweep your Wi-Fi for printers on port ${DEFAULT_PORT}. Sweeping the full range takes a few minutes.`}
          </AppText>
        </Section>
      </ScrollView>
      </KeyboardAvoidingView>
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
  onRemove,
}: {
  printer: PrinterConn;
  kind: 'kitchen' | 'receipt';
  tenant?: TenantTaxInfo;
  prefs?: TenantPreferences;
  onRemove?: () => void;
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
        {onRemove ? (
          <Button
            title=""
            variant="ghost"
            accessibilityLabel={`remove-printer-${printer.ip}`}
            icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
            onPress={onRemove}
          />
        ) : null}
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
  added,
  adding,
  onAdd,
}: {
  ip: string;
  width: '58' | '80';
  tenant?: TenantTaxInfo;
  prefs?: TenantPreferences;
  added: boolean;
  adding: boolean;
  onAdd: () => void;
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
    <Card style={{ gap: theme.spacing[3] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
        <MonoText style={{ flex: 1 }}>{ip}</MonoText>
        <Button title="Test print" variant="secondary" onPress={testPrint} loading={printing} />
      </View>
      {/* The loop this screen used to leave open: the phone is the only device
          that can scan a LAN, so it has to be the one that can finish. */}
      {added ? (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          Already a receipt printer.
        </AppText>
      ) : (
        <Button
          title="Add this printer"
          icon={<Plus size={16} color={theme.colors.ink[50]} />}
          onPress={onAdd}
          loading={adding}
        />
      )}
    </Card>
  );
}
