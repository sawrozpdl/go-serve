/**
 * Tables manager (M7) — service-table CRUD (name, seats, area, icon). Drives the
 * Floor grid. Live floor status (occupied/dirty) is left to the Floor tab.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert, type TextInputProps } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Users, Armchair } from 'lucide-react-native';
import type { ServiceTable } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ListRow } from '@/components/ui/ListRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppIcon } from '@/components/ui/Icon';
import { StackHeader } from '@/components/ui/StackHeader';
import { IconPickerField } from '@/components/ui/IconPickerField';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useServiceTables, useCreateServiceTable, useUpdateServiceTable, useDeleteServiceTable } from '@/api/tables';
import { toast } from '@/lib/toast';

export default function TablesManager() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const tables = useServiceTables();

  const [form, setForm] = useState<ServiceTable | 'new' | null>(null);

  const canManage = can(me.data, 'table:create') || can(me.data, 'table:update');
  if (me.data && !canManage) return <Redirect href="/more" />;

  const rows = [...(tables.data ?? [])].sort((a, b) => a.sort - b.sort);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Tables"
        right={
          <Pressable onPress={() => setForm('new')} hitSlop={10} accessibilityLabel="add-table">
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
        {tables.isLoading ? (
          <View style={{ gap: theme.spacing[3] }}>
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton.Card key={i} lines={1} />
            ))}
          </View>
        ) : tables.isError ? (
          <ErrorState detail={String(tables.error)} onRetry={() => void tables.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Armchair size={28} color={theme.colors.textMuted} />}
            title="No tables yet"
            hint="Tap + to add one."
          />
        ) : (
          <Card padded={false}>
            {rows.map((t) => (
              <ListRow
                key={t.id}
                title={t.name}
                subtitle={t.area || undefined}
                left={<AppIcon name={t.icon || 'Armchair'} size={20} color={theme.colors.primary} />}
                onPress={() => setForm(t)}
                right={
                  t.capacity ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Users size={13} color={theme.colors.textFaint} />
                      <MonoText size="sm" muted>
                        {t.capacity}
                      </MonoText>
                    </View>
                  ) : undefined
                }
              />
            ))}
          </Card>
        )}
      </ScrollView>

      {form ? <TableForm entity={form} onClose={() => setForm(null)} /> : null}
    </View>
  );
}

function TableForm({ entity, onClose }: { entity: ServiceTable | 'new'; onClose: () => void }) {
  const theme = useTheme();
  const editing = entity !== 'new';
  const create = useCreateServiceTable();
  const update = useUpdateServiceTable();
  const del = useDeleteServiceTable();

  const [name, setName] = useState(editing ? entity.name : '');
  const [capacity, setCapacity] = useState(editing ? String(entity.capacity || '') : '');
  const [area, setArea] = useState(editing ? entity.area : '');
  const [icon, setIcon] = useState(editing ? entity.icon : '');

  const save = () => {
    if (!name.trim()) return toast.error('Name is required');
    const patch = {
      name: name.trim(),
      capacity: parseInt(capacity, 10) || 0,
      area: area.trim(),
      icon,
    };
    const done = { onSuccess: () => { toast.success('Saved'); onClose(); }, onError: (e: Error) => toast.error('Could not save', e.message) };
    if (editing) update.mutate({ id: entity.id, patch }, done);
    else create.mutate(patch, done);
  };

  const confirmDelete = () => {
    if (!editing) return;
    Alert.alert('Delete table?', `"${entity.name}" will be removed from the floor.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () =>
          del.mutate(entity.id, {
            onSuccess: () => { toast.success('Deleted'); onClose(); },
            onError: (e) => toast.error('Could not delete', (e as Error).message),
          }),
      },
    ]);
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title={editing ? 'Edit table' : 'New table'}
      full
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
          {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[6], gap: theme.spacing[4] }}
      >
        <SheetField label="Name" value={name} onChangeText={setName} placeholder="e.g. Table 4" autoFocus={!editing} />
        <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
          <View style={{ flex: 1 }}>
            <SheetField label="Seats" value={capacity} onChangeText={setCapacity} placeholder="0" keyboardType="number-pad" />
          </View>
          <View style={{ flex: 2 }}>
            <SheetField label="Area (optional)" value={area} onChangeText={setArea} placeholder="e.g. 1st Cabin" />
          </View>
        </View>
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />
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
