/**
 * Outlets manager — prep destinations (Kitchen, Bar, …) and their printers.
 * Categories/items route to an outlet; each outlet has one network printer and
 * its own KDS board. A single-outlet cafe just has "Kitchen"; adding a second
 * turns on per-outlet routing.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert, type TextInputProps } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Store, Printer, Star } from 'lucide-react-native';
import type { Outlet } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { AppSheet } from '@/components/ui/AppSheet';
import { StackHeader } from '@/components/ui/StackHeader';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useOutlets, useCreateOutlet, useUpdateOutlet, useDeleteOutlet } from '@/api/outlets';
import { toast } from '@/lib/toast';

export default function OutletsManager() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const outlets = useOutlets();

  const [form, setForm] = useState<Outlet | 'new' | null>(null);

  const canManage = can(me.data, 'outlet:create') || can(me.data, 'outlet:update');
  if (me.data && !canManage) return <Redirect href="/more" />;

  const rows = [...(outlets.data ?? [])].sort(
    (a, b) => Number(b.is_default) - Number(a.is_default) || a.sort - b.sort,
  );

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Outlets"
        right={
          <Pressable onPress={() => setForm('new')} hitSlop={10} accessibilityLabel="add-outlet">
            <Plus size={24} color={theme.colors.primary} />
          </Pressable>
        }
      />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[3],
        }}
      >
        {outlets.isLoading ? (
          <View style={{ gap: theme.spacing[3] }}>
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton.Card key={i} lines={1} />
            ))}
          </View>
        ) : outlets.isError ? (
          <ErrorState detail={String(outlets.error)} onRetry={() => void outlets.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Store size={28} color={theme.colors.textMuted} />}
            title="No outlets yet"
            hint="Tap + to add one."
          />
        ) : (
          <Card padded={false}>
            {rows.map((o) => (
              <ListRow
                key={o.id}
                title={o.name}
                subtitle={o.printer_ip ? `${o.printer_ip}:${o.printer_port}` : 'No printer'}
                left={<Store size={20} color={theme.colors.primary} />}
                onPress={() => setForm(o)}
                right={
                  o.is_default ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Star size={13} color={theme.colors.textFaint} />
                      <MonoText size="sm" muted>
                        Default
                      </MonoText>
                    </View>
                  ) : o.printer_ip ? (
                    <Printer size={14} color={theme.colors.textFaint} />
                  ) : undefined
                }
              />
            ))}
          </Card>
        )}
      </ScrollView>

      {form ? <OutletForm entity={form} onClose={() => setForm(null)} /> : null}
    </View>
  );
}

function OutletForm({ entity, onClose }: { entity: Outlet | 'new'; onClose: () => void }) {
  const theme = useTheme();
  const editing = entity !== 'new';
  const create = useCreateOutlet();
  const update = useUpdateOutlet();
  const del = useDeleteOutlet();

  const [name, setName] = useState(editing ? entity.name : '');
  const [printerIp, setPrinterIp] = useState(editing ? entity.printer_ip ?? '' : '');
  const [printerPort, setPrinterPort] = useState(editing ? String(entity.printer_port || 9100) : '9100');
  const [width, setWidth] = useState<'58' | '80'>(editing ? entity.printer_width : '80');

  const save = () => {
    if (!name.trim()) return toast.error('Name is required');
    const patch = {
      name: name.trim(),
      printer_ip: printerIp.trim() || null,
      printer_port: Math.min(65535, Math.max(1, parseInt(printerPort, 10) || 9100)),
      printer_width: width,
    };
    const done = {
      onSuccess: () => {
        toast.success('Saved');
        onClose();
      },
      onError: (e: Error) => toast.error('Could not save', e.message),
    };
    if (editing) update.mutate({ id: entity.id, patch }, done);
    else create.mutate(patch, done);
  };

  const makeDefault = () => {
    if (!editing) return;
    update.mutate(
      { id: entity.id, patch: { is_default: true } },
      {
        onSuccess: () => {
          toast.success(`${entity.name} is now the default`);
          onClose();
        },
        onError: (e) => toast.error('Could not set default', (e as Error).message),
      },
    );
  };

  const confirmDelete = () => {
    if (!editing) return;
    if (entity.is_default) {
      return toast.error('Cannot delete the default outlet', 'Set another outlet as default first.');
    }
    Alert.alert('Delete outlet?', `"${entity.name}" will be removed. Items routed here fall back to the default.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          del.mutate(entity.id, {
            onSuccess: () => {
              toast.success('Deleted');
              onClose();
            },
            onError: (e) => toast.error('Could not delete', (e as Error).message),
          }),
      },
    ]);
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title={editing ? 'Edit outlet' : 'New outlet'}
      full
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
          {editing && !entity.is_default ? <Button title="Make default outlet" variant="ghost" onPress={makeDefault} /> : null}
          {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[6], gap: theme.spacing[4] }}
      >
        <SheetField label="Name" value={name} onChangeText={setName} placeholder="e.g. Bar" autoFocus={!editing} />
        <SheetField
          label="Printer IP (optional)"
          value={printerIp}
          onChangeText={setPrinterIp}
          placeholder="192.168.1.50"
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
        />
        <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
          <View style={{ flex: 1 }}>
            <SheetField
              label="Printer port"
              value={printerPort}
              onChangeText={setPrinterPort}
              placeholder="9100"
              keyboardType="number-pad"
            />
          </View>
          <View style={{ flex: 1, gap: theme.spacing[2] }}>
            <AppText variant="label">Paper width</AppText>
            <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
              {(['80', '58'] as const).map((w) => (
                <Pressable
                  key={w}
                  onPress={() => setWidth(w)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: width === w }}
                  style={{
                    flex: 1,
                    alignItems: 'center',
                    paddingVertical: theme.spacing[3],
                    borderRadius: theme.radii.md,
                    borderWidth: 1,
                    borderColor: width === w ? theme.colors.primary : theme.colors.border,
                    backgroundColor: width === w ? theme.colors.primaryWash : 'transparent',
                  }}
                >
                  <AppText style={{ color: width === w ? theme.colors.primary : theme.colors.textMuted }}>
                    {w}mm
                  </AppText>
                </Pressable>
              ))}
            </View>
          </View>
        </View>
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function fieldStyle(theme: Theme) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaces[2],
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
  };
}

function SheetField({ label, ...props }: { label: string } & TextInputProps) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">{label}</AppText>
      <AppSheet.TextInput placeholderTextColor={theme.colors.textFaint} style={fieldStyle(theme)} {...props} />
    </View>
  );
}
