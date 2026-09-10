/**
 * Pack rules — how stock is BOUGHT versus how it is SOLD.
 *
 * A carton of 200 bottles is one purchase and two hundred sales, and without
 * the rule an operator receiving stock has to do that multiplication in their
 * head every time. The phone could never see or set these; the dashboard has
 * had them since M7.
 */
import { useState } from 'react';
import { View, Alert } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import type { InventoryItem } from '@cafe-mgmt/api-types';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { useTheme, type Theme } from '@/theme';
import { usePackRules, useCreatePackRule, useDeletePackRule } from '@/api/inventory';
import { packRuleLabel } from '@/inventory/stock';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';

export function PackRulesSheet({
  item,
  canEdit,
  canDelete,
  onClose,
}: {
  item: InventoryItem;
  canEdit: boolean;
  canDelete: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const rules = usePackRules(item.id);
  const create = useCreatePackRule(item.id);
  const remove = useDeletePackRule(item.id);

  const [containerUnit, setContainerUnit] = useState('');
  const [containerQty, setContainerQty] = useState('1');
  const [perContainer, setPerContainer] = useState('');

  const rows = rules.data ?? [];

  const add = () => {
    const qty = Number(containerQty);
    const per = Number(perContainer);
    if (!containerUnit.trim()) return toast.error('Name the container', 'e.g. carton, crate, sack');
    if (!Number.isFinite(qty) || qty <= 0) return toast.error('Container quantity must be at least 1');
    if (!Number.isFinite(per) || per <= 0) {
      return toast.error(`How many ${item.sale_unit} in one?`, 'This is the number that does the conversion.');
    }
    create.mutate(
      {
        container_unit: containerUnit.trim(),
        container_qty: qty,
        sale_unit: item.sale_unit,
        sale_qty_per_container: per,
      },
      {
        onSuccess: () => {
          setContainerUnit('');
          setContainerQty('1');
          setPerContainer('');
          toast.success('Pack rule added');
        },
        onError: (e) => toast.error('Could not add', errorText(e)),
      },
    );
  };

  const confirmDelete = (id: string, label: string) =>
    Alert.alert('Remove this pack rule?', label, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          remove.mutate(id, { onError: (e) => toast.error('Could not remove', errorText(e)) }),
      },
    ]);

  return (
    <AppSheet
      open
      onClose={onClose}
      title={`Pack rules · ${item.name}`}
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
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          Sold by the {item.sale_unit}. A pack rule says what one purchase container holds, so
          receiving stock is one number instead of a multiplication.
        </AppText>

        {rows.length === 0 && !rules.isLoading ? (
          <EmptyState title="No pack rules." hint={`Add one if you buy ${item.name} by the carton.`} />
        ) : null}

        {rows.map((p) => (
          <View
            key={p.id}
            style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}
          >
            <AppText style={{ flex: 1 }} numberOfLines={1}>
              {packRuleLabel(p)}
            </AppText>
            {canDelete ? (
              <Button
                title=""
                variant="ghost"
                accessibilityLabel={`remove-pack-rule-${p.id}`}
                icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
                onPress={() => confirmDelete(p.id, packRuleLabel(p))}
                loading={remove.isPending}
              />
            ) : null}
          </View>
        ))}

        {canEdit ? (
          <View
            style={{
              gap: theme.spacing[3],
              borderTopWidth: 1,
              borderTopColor: theme.colors.border,
              paddingTop: theme.spacing[4],
            }}
          >
            <AppText variant="label">Add a rule</AppText>
            <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
              <View style={{ flex: 1, gap: theme.spacing[2] }}>
                <AppText variant="label">Container</AppText>
                <AppSheet.TextInput
                  value={containerUnit}
                  onChangeText={setContainerUnit}
                  placeholder="carton"
                  autoCapitalize="none"
                  placeholderTextColor={theme.colors.textFaint}
                  accessibilityLabel="container-unit"
                  style={fieldStyle(theme)}
                />
              </View>
              <View style={{ width: 96, gap: theme.spacing[2] }}>
                <AppText variant="label">How many</AppText>
                <AppSheet.TextInput
                  value={containerQty}
                  onChangeText={setContainerQty}
                  keyboardType="number-pad"
                  placeholderTextColor={theme.colors.textFaint}
                  accessibilityLabel="container-qty"
                  style={fieldStyle(theme)}
                />
              </View>
            </View>
            <View style={{ gap: theme.spacing[2] }}>
              <AppText variant="label">{item.sale_unit} per container</AppText>
              <AppSheet.TextInput
                value={perContainer}
                onChangeText={setPerContainer}
                keyboardType="number-pad"
                placeholder="200"
                placeholderTextColor={theme.colors.textFaint}
                accessibilityLabel="sale-per-container"
                style={fieldStyle(theme)}
              />
            </View>
            <Button title="Add rule" variant="secondary" onPress={add} loading={create.isPending} />
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
