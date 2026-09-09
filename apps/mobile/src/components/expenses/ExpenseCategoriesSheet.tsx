/**
 * Manage expense categories from inside the Expenses screen — the same place
 * web keeps them, so this is depth on a surface mobile already ships rather
 * than a new one. Mobile could read categories before but never create, rename
 * or delete one, which meant a cafe that started on a phone had no buckets at
 * all until someone opened the dashboard.
 *
 * A row taps into an inline editor rather than a nested sheet: renaming is a
 * two-field job and a second sheet layer for it would be heavier than the task.
 */
import { useState } from 'react';
import { View, Alert } from 'react-native';
import { Pencil, Trash2, Plus } from 'lucide-react-native';
import type { ExpenseCategory } from '@cafe-mgmt/api-types';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { AppIcon } from '@/components/ui/Icon';
import { IconPickerField } from '@/components/ui/IconPickerField';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTheme, type Theme } from '@/theme';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';
import {
  useExpenseCategories,
  useCreateExpenseCategory,
  useUpdateExpenseCategory,
  useDeleteExpenseCategory,
} from '@/api/expenses';

export function ExpenseCategoriesSheet({
  open,
  onClose,
  canEdit,
  canDelete,
}: {
  open: boolean;
  onClose: () => void;
  canEdit: boolean;
  canDelete: boolean;
}) {
  const theme = useTheme();
  const list = useExpenseCategories();
  const create = useCreateExpenseCategory();
  const update = useUpdateExpenseCategory();
  const remove = useDeleteExpenseCategory();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editIcon, setEditIcon] = useState('');
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('');

  const cats = list.data ?? [];

  /** Names are unique per tenant, case-insensitively, in the DB. Catching it
   *  here makes a duplicate a hint instead of a failed request. */
  const nameTaken = (name: string, exceptId?: string) =>
    cats.some((c) => c.id !== exceptId && c.name.trim().toLowerCase() === name.trim().toLowerCase());

  const startEdit = (c: ExpenseCategory) => {
    setEditingId(c.id);
    setEditName(c.name);
    setEditIcon(c.icon || '');
  };

  const saveEdit = () => {
    if (!editingId || !editName.trim()) return;
    if (nameTaken(editName, editingId)) {
      toast.error('That name is taken', `Another category is already called "${editName.trim()}".`);
      return;
    }
    update.mutate(
      { id: editingId, patch: { name: editName.trim(), icon: editIcon } },
      {
        onSuccess: () => setEditingId(null),
        onError: (e) => toast.error('Could not rename', errorText(e)),
      },
    );
  };

  const addCategory = () => {
    if (!newName.trim()) return;
    if (nameTaken(newName)) {
      toast.error('That name is taken', `"${newName.trim()}" already exists.`);
      return;
    }
    create.mutate(
      { name: newName.trim(), icon: newIcon || undefined },
      {
        onSuccess: () => {
          setNewName('');
          setNewIcon('');
          toast.success('Category added');
        },
        onError: (e) => toast.error('Could not add', errorText(e)),
      },
    );
  };

  const confirmDelete = (c: ExpenseCategory) => {
    Alert.alert(
      `Delete ${c.name}?`,
      'Expenses already tagged with it stay, but become uncategorised.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            remove.mutate(c.id, { onError: (e) => toast.error('Could not delete', errorText(e)) }),
        },
      ],
    );
  };

  return (
    <AppSheet
      open={open}
      onClose={onClose}
      title="Expense categories"
      size="full"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button title="Done" variant="secondary" onPress={onClose} />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[6],
          gap: theme.spacing[4],
        }}
      >
        {cats.length === 0 && !list.isLoading ? (
          <EmptyState title="No categories yet." hint="Add Rent, Utilities, Salaries, Supplies…" />
        ) : null}

        {cats.map((c) =>
          editingId === c.id ? (
            <View key={c.id} style={{ gap: theme.spacing[3] }}>
              <View style={{ gap: theme.spacing[2] }}>
                <AppText variant="label">Name</AppText>
                <AppSheet.TextInput
                  value={editName}
                  onChangeText={setEditName}
                  accessibilityLabel="category-name"
                  placeholderTextColor={theme.colors.textFaint}
                  style={fieldStyle(theme)}
                />
              </View>
              <IconPickerField label="Icon" value={editIcon} onChange={setEditIcon} />
              <View style={{ flexDirection: 'row', gap: theme.spacing[2] }}>
                <View style={{ flex: 1 }}>
                  <Button title="Cancel" variant="ghost" onPress={() => setEditingId(null)} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button
                    title="Save"
                    onPress={saveEdit}
                    loading={update.isPending}
                    disabled={!editName.trim()}
                  />
                </View>
              </View>
            </View>
          ) : (
            <View
              key={c.id}
              style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}
            >
              <AppIcon name={c.icon} size={18} color={theme.colors.textMuted} />
              <AppText style={{ flex: 1 }} numberOfLines={1}>
                {c.name}
              </AppText>
              {canEdit ? (
                <Button
                  title=""
                  variant="ghost"
                  accessibilityLabel={`edit-category-${c.name}`}
                  icon={<Pencil size={16} color={theme.colors.textMuted} />}
                  onPress={() => startEdit(c)}
                />
              ) : null}
              {canDelete ? (
                <Button
                  title=""
                  variant="ghost"
                  accessibilityLabel={`delete-category-${c.name}`}
                  icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
                  onPress={() => confirmDelete(c)}
                />
              ) : null}
            </View>
          ),
        )}

        {canEdit ? (
          <View
            style={{
              gap: theme.spacing[3],
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              paddingTop: theme.spacing[4],
            }}
          >
            <View style={{ gap: theme.spacing[2] }}>
              <AppText variant="label">New category</AppText>
              <AppSheet.TextInput
                value={newName}
                onChangeText={setNewName}
                placeholder="Rent, Utilities, Supplies…"
                placeholderTextColor={theme.colors.textFaint}
                accessibilityLabel="new-category-name"
                style={fieldStyle(theme)}
              />
            </View>
            <IconPickerField label="Icon" value={newIcon} onChange={setNewIcon} />
            <Button
              title="Add category"
              variant="secondary"
              icon={<Plus size={16} color={theme.colors.primary} />}
              onPress={addCategory}
              loading={create.isPending}
              disabled={!newName.trim()}
            />
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
