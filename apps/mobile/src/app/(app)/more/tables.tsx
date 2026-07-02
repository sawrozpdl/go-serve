/**
 * Tables manager (M7) — service-table CRUD (name, seats, area, icon). Drives the
 * Floor grid. Live floor status (occupied/dirty) is left to the Floor tab.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Users } from 'lucide-react-native';
import type { ServiceTable } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Sheet } from '@/components/ui/Sheet';
import { AppIcon } from '@/components/ui/Icon';
import { StackHeader } from '@/components/ui/StackHeader';
import { IconPickerField } from '@/components/ui/IconPickerField';
import { useTheme } from '@/theme';
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
          <AppText variant="faint">Loading…</AppText>
        ) : rows.length === 0 ? (
          <AppText variant="muted">No tables yet. Tap + to add one.</AppText>
        ) : (
          rows.map((t) => (
            <Pressable
              key={t.id}
              onPress={() => setForm(t)}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing[3],
                backgroundColor: theme.colors.card,
                borderRadius: theme.radii.md,
                borderWidth: 1,
                borderColor: theme.colors.border,
                paddingVertical: theme.spacing[3],
                paddingHorizontal: theme.spacing[4],
              }}
            >
              <AppIcon name={t.icon || 'Armchair'} size={20} color={theme.colors.primary} />
              <View style={{ flex: 1 }}>
                <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{t.name}</AppText>
                {t.area ? (
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                    {t.area}
                  </AppText>
                ) : null}
              </View>
              {t.capacity ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Users size={13} color={theme.colors.textFaint} />
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                    {t.capacity}
                  </AppText>
                </View>
              ) : null}
            </Pressable>
          ))
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
    <Sheet open onClose={onClose} title={editing ? 'Edit table' : 'New table'}>
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <TextField label="Name" value={name} onChangeText={setName} placeholder="e.g. Table 4" autoFocus={!editing} />
        <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
          <View style={{ flex: 1 }}>
            <TextField label="Seats" value={capacity} onChangeText={setCapacity} placeholder="0" keyboardType="number-pad" />
          </View>
          <View style={{ flex: 2 }}>
            <TextField label="Area (optional)" value={area} onChangeText={setArea} placeholder="e.g. 1st Cabin" />
          </View>
        </View>
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />
        <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
        {editing ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
      </View>
    </Sheet>
  );
}
