/**
 * Tables manager — service-table CRUD (name, seats, area, icon, sort) and the
 * live status. Drives the Floor grid.
 *
 * Status is editable here on purpose. The Floor tab can only sweep a `dirty`
 * table back to free; a table stuck on `reserved` — held for a booking that
 * never arrived — had no way back from a phone at all, and an operator with
 * no laptop simply lost the table for the evening.
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
import { Grid } from '@/components/ui/Grid';
import { Stamp } from '@/components/ui/Stamp';
import { SegmentedField } from '@/components/ui/Field';
import { ListRow } from '@/components/ui/ListRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppIcon } from '@/components/ui/Icon';
import { StackHeader } from '@/components/ui/StackHeader';
import { IconPickerField } from '@/components/ui/IconPickerField';
import { useLayout } from '@/lib/layout';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useServiceTables, useCreateServiceTable, useUpdateServiceTable, useDeleteServiceTable } from '@/api/tables';
import {
  TABLE_STATUSES,
  tableStatusLabel,
  tableStatusTone,
  tableStatusEffect,
  type TableStatus,
} from '@/catalog/tableStatus';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';

export default function TablesManager() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const me = useMe();
  const tables = useServiceTables();

  const [form, setForm] = useState<ServiceTable | 'new' | null>(null);

  const canCreate = can(me.data, 'table:create');
  const canUpdate = can(me.data, 'table:update');
  const canDelete = can(me.data, 'table:delete');
  const canManage = canCreate || canUpdate;
  if (me.data && !canManage) return <Redirect href="/more" />;

  const rows = [...(tables.data ?? [])].sort((a, b) => a.sort - b.sort);

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Tables"
        right={
          canCreate ? (
            <Pressable onPress={() => setForm('new')} hitSlop={10} accessibilityLabel="add-table">
              <Plus size={24} color={theme.colors.primary} />
            </Pressable>
          ) : undefined
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
          <ErrorState detail={errorText(tables.error)} onRetry={() => void tables.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Armchair size={28} color={theme.colors.textMuted} />}
            title="No tables yet"
            hint="Tap + to add one."
          />
        ) : (
          // A floor plan is a grid, not a column: on a tablet the tiles fit
          // several across, and a table you are looking for is found by
          // position on the floor rather than by reading down a list.
          <Grid columns={layout.columns(280, 1, 3)}>
            {rows.map((t) => (
              <Card key={t.id} padded={false}>
              <ListRow
                key={t.id}
                title={t.name}
                subtitle={t.area || undefined}
                left={<AppIcon name={t.icon || 'Armchair'} size={20} color={theme.colors.primary} />}
                onPress={canUpdate ? () => setForm(t) : undefined}
                right={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
                    {/* `free` is deliberately not stamped: four loud pills is
                        the same as none, and only the other three ask anyone
                        to do something. */}
                    {t.status !== 'free' ? (
                      <Stamp tone={tableStatusTone(t.status)} label={tableStatusLabel(t.status)} size="sm" />
                    ) : null}
                    {t.capacity ? (
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                        <Users size={13} color={theme.colors.textFaint} />
                        <MonoText size="sm" muted>
                          {t.capacity}
                        </MonoText>
                      </View>
                    ) : null}
                  </View>
                }
              />
              </Card>
            ))}
          </Grid>
        )}
      </ScrollView>

      {form ? <TableForm entity={form} canDelete={canDelete} onClose={() => setForm(null)} /> : null}
    </View>
  );
}

function TableForm({
  entity,
  canDelete,
  onClose,
}: {
  entity: ServiceTable | 'new';
  canDelete: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const editing = entity !== 'new';
  const create = useCreateServiceTable();
  const update = useUpdateServiceTable();
  const del = useDeleteServiceTable();

  const [name, setName] = useState(editing ? entity.name : '');
  const [capacity, setCapacity] = useState(editing ? String(entity.capacity || '') : '2');
  const [area, setArea] = useState(editing ? entity.area : '');
  const [icon, setIcon] = useState(editing ? entity.icon : '');
  const [sort, setSort] = useState(editing ? String(entity.sort) : '0');
  const [status, setStatus] = useState<TableStatus>(editing ? entity.status : 'free');

  const statusChanged = editing && status !== entity.status;
  const effect = editing ? tableStatusEffect(entity.status, status) : null;

  const save = () => {
    if (!name.trim()) return toast.error('Name is required');
    const patch: Partial<ServiceTable> = {
      name: name.trim(),
      // A zero-seat table can never be seated, which makes it invisible to
      // every capacity check on the floor. One is the smallest real table.
      capacity: Math.max(1, parseInt(capacity, 10) || 1),
      area: area.trim(),
      icon,
      sort: parseInt(sort, 10) || 0,
      // Only on edit: a new table is always free, and sending a status would
      // let someone create a table that is already dirty.
      ...(editing ? { status } : {}),
    };
    const done = { onSuccess: () => { toast.success('Saved'); onClose(); }, onError: (e: Error) => toast.error('Could not save', e.message) };
    if (editing) update.mutate({ id: entity.id, patch }, done);
    else create.mutate(patch, done);
  };

  const confirmDelete = () => {
    if (!editing) return;
    Alert.alert(
      'Delete table?',
      entity.status === 'occupied'
        ? `"${entity.name}" has an open tab right now. Deleting the table does not settle it — the tab becomes a walk-in.`
        : `"${entity.name}" will be removed from the floor.`,
      [
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
      ],
    );
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
          {editing && canDelete ? <Button title="Delete" variant="ghost" onPress={confirmDelete} /> : null}
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
        <SheetField
          label="Sort order"
          value={sort}
          onChangeText={setSort}
          placeholder="0"
          keyboardType="number-pad"
        />
        <IconPickerField label="Icon" value={icon} onChange={setIcon} />

        {editing ? (
          <View style={{ gap: theme.spacing[2] }}>
            <SegmentedField
              label="Status"
              value={status}
              options={TABLE_STATUSES.map((v) => ({ value: v, label: tableStatusLabel(v) }))}
              onChange={setStatus}
            />
            {statusChanged && effect ? (
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                {effect}
              </AppText>
            ) : null}
          </View>
        ) : null}
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
      {/* The label names the field for a screen reader; without it every
          input in the sheet is an anonymous text box. */}
      <AppSheet.TextInput
        accessibilityLabel={label}
        placeholderTextColor={theme.colors.textFaint}
        style={fieldStyle(theme)}
        {...props}
      />
    </View>
  );
}
