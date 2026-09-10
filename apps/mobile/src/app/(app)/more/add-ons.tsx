/**
 * Add-ons manager.
 *
 * Add-ons are their own catalog, never menu items: reusable GROUPS of choices
 * ("Milk", "Extras") attached to menu items and/or categories. Mobile has been
 * able to CONSUME them at the POS since migration 0062 and never able to
 * manage them, so a cafe that wanted "extra shot" offered on its drinks had to
 * find a laptop to say so once.
 *
 * Two rules the form encodes rather than discovers:
 *
 *  - `min_select >= 1` makes the group REQUIRED. The POS refuses to add a line
 *    without a choice and the API rejects it, so this is a real behaviour
 *    switch, not a label — hence a toggle with the consequence spelled out.
 *  - Attachments COMPOSE. A group on the category and a group on the item are
 *    both offered (`resolveModifierGroups`), unlike kitchen routing where the
 *    item wins. The screen says so, because "why is this still showing?" has
 *    no answer if you assume override.
 *
 * A group's price is FOLDED into the line's unit price at the POS (0062), so
 * the money here is per-choice, not a surcharge shown separately on the bill.
 */
import { useState } from 'react';
import { View, Pressable, Alert } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScrollView } from 'react-native-gesture-handler';
import { Plus, Trash2, Layers } from 'lucide-react-native';
import type { MenuModifier, ModifierGroup } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { Chip } from '@/components/ui/Chip';
import { AppSheet } from '@/components/ui/AppSheet';
import { AmountInput } from '@/components/ui/AmountInput';
import { ToggleRow } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useLayout, readableContent } from '@/lib/layout';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useModifierGroups } from '@/api/menu';
import {
  useCreateModifierGroup,
  useUpdateModifierGroup,
  useDeleteModifierGroup,
  useCreateModifier,
  useUpdateModifier,
  useDeleteModifier,
} from '@/api/menuAdmin';
import { groupRule, groupReuse } from '@/catalog/addOns';
import { formatNPR } from '@/lib/format';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';

export default function AddOnsManager() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const me = useMe();
  const groups = useModifierGroups();

  const [form, setForm] = useState<ModifierGroup | 'new' | null>(null);

  const canCreate = can(me.data, 'menu:create');
  const canUpdate = can(me.data, 'menu:update');
  const canDelete = can(me.data, 'menu:delete');
  if (me.data && !canCreate && !canUpdate) return <Redirect href="/more" />;

  const rows = [...(groups.data ?? [])].sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader
        title="Add-ons"
        right={
          canCreate ? (
            <Pressable onPress={() => setForm('new')} hitSlop={10} accessibilityLabel="add-group">
              <Plus size={24} color={theme.colors.primary} />
            </Pressable>
          ) : undefined
        }
      />
      <ScrollView
        contentContainerStyle={{
          ...readableContent(layout),
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[3],
        }}
      >
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          A group is a set of choices you attach to items or whole categories — one group can
          serve the whole menu. Attach them from the item or category form.
        </AppText>

        {groups.isLoading ? (
          Array.from({ length: 3 }, (_, i) => <Skeleton.Card key={i} lines={2} />)
        ) : groups.isError && !groups.data ? (
          <ErrorState detail={errorText(groups.error)} onRetry={() => void groups.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<Layers size={28} color={theme.colors.textMuted} />}
            title="No add-on groups yet."
            hint="Milk choices, extra shots, spice level — anything a customer picks alongside the dish."
            action={canCreate ? { label: 'New group', onPress: () => setForm('new') } : undefined}
          />
        ) : (
          rows.map((g) => (
            <GroupCard key={g.id} group={g} onEdit={canUpdate ? () => setForm(g) : undefined} />
          ))
        )}
      </ScrollView>

      {form ? (
        <GroupForm entity={form} canDelete={canDelete} onClose={() => setForm(null)} />
      ) : null}
    </View>
  );
}

function GroupCard({ group: g, onEdit }: { group: ModifierGroup; onEdit?: () => void }) {
  const theme = useTheme();
  const reuse = groupReuse(g);
  return (
    <Card onPress={onEdit} accessibilityLabel={g.name} style={{ gap: theme.spacing[2] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
        <AppText style={{ flex: 1, fontFamily: theme.fonts.bodyMedium }} numberOfLines={1}>
          {g.name}
        </AppText>
        {g.min_select > 0 ? <Stamp tone="warn" label="Required" size="sm" /> : null}
        {!g.is_active ? <Stamp tone="neutral" label="Off" size="sm" /> : null}
      </View>
      <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
        {groupRule(g)}
      </AppText>
      {g.modifiers.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
          {g.modifiers.map((m) => (
            <Chip
              key={m.id}
              label={m.price_cents > 0 ? `${m.name} +${formatNPR(m.price_cents)}` : m.name}
            />
          ))}
        </View>
      ) : (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          No choices yet — this group offers nothing until you add some.
        </AppText>
      )}
      <MonoText size="2xs" muted>
        {reuse}
      </MonoText>
    </Card>
  );
}

function GroupForm({
  entity,
  canDelete,
  onClose,
}: {
  entity: ModifierGroup | 'new';
  canDelete: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const editing = entity !== 'new';
  const create = useCreateModifierGroup();
  const update = useUpdateModifierGroup();
  const remove = useDeleteModifierGroup();

  const [name, setName] = useState(editing ? entity.name : '');
  const [required, setRequired] = useState(editing ? entity.min_select > 0 : false);
  const [multi, setMulti] = useState(editing ? entity.max_select == null || entity.max_select > 1 : false);
  const [active, setActive] = useState(editing ? entity.is_active : true);

  const save = () => {
    if (!name.trim()) return toast.error('Name the group', 'e.g. Milk, Extras, Spice level');
    const body = {
      name: name.trim(),
      // min_select >= 1 is what makes the POS refuse a line without a choice.
      min_select: required ? 1 : 0,
      // null = unlimited. One is the meaningful alternative — "pick exactly
      // one" versus "pick as many as you like"; a cap of 3 is a rule nobody
      // in a cafe has ever asked for.
      max_select: multi ? null : 1,
      is_active: active,
    };
    const done = {
      onSuccess: () => {
        toast.success('Saved');
        onClose();
      },
      onError: (e: unknown) => toast.error('Could not save', errorText(e)),
    };
    if (editing) update.mutate({ id: entity.id, patch: body }, done);
    else create.mutate(body, done);
  };

  const confirmDelete = () => {
    if (!editing) return;
    const attached = entity.item_count + entity.category_count;
    Alert.alert(
      'Delete this group?',
      attached > 0
        ? `${entity.name} is attached in ${attached} place${attached === 1 ? '' : 's'}. Deleting it stops those items offering these choices. Bills already taken keep what was chosen.`
        : `${entity.name} and its choices.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            remove.mutate(entity.id, {
              onSuccess: () => {
                toast.success('Deleted');
                onClose();
              },
              onError: (e) => toast.error('Could not delete', errorText(e)),
            }),
        },
      ],
    );
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title={editing ? 'Edit add-on group' : 'New add-on group'}
      size="full"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          <Button title="Save" onPress={save} loading={create.isPending || update.isPending} />
          {editing && canDelete ? (
            <Button
              title="Delete group"
              variant="ghost"
              icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
              onPress={confirmDelete}
              loading={remove.isPending}
            />
          ) : null}
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
        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Name</AppText>
          <AppSheet.TextInput
            value={name}
            onChangeText={setName}
            placeholder="e.g. Milk"
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="group-name"
            autoFocus={!editing}
            style={fieldStyle(theme)}
          />
        </View>

        <ToggleRow
          label="Must be chosen"
          hint={
            required
              ? 'The item cannot be added until someone picks. The server enforces this too.'
              : 'Optional — the item can be added without picking anything.'
          }
          value={required}
          onValueChange={setRequired}
        />
        <ToggleRow
          label="Allow several"
          hint={multi ? 'Any number of choices can be picked.' : 'Exactly one choice.'}
          value={multi}
          onValueChange={setMulti}
        />
        <ToggleRow
          label="Group is on"
          hint="Off hides it from the POS everywhere it is attached, without detaching it."
          value={active}
          onValueChange={setActive}
        />

        {editing ? (
          <ChoiceEditor group={entity} canDelete={canDelete} />
        ) : (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            Save the group first, then reopen it to add the choices.
          </AppText>
        )}

        {editing ? (
          <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
            {groupReuse(entity)}. Attach or detach from the item and category forms — a group on a
            category and a group on an item are BOTH offered, they do not replace each other.
          </AppText>
        ) : null}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

/** The choices inside one group. Each is a name and a price the POS folds
 *  into the line's unit price. */
function ChoiceEditor({ group, canDelete }: { group: ModifierGroup; canDelete: boolean }) {
  const theme = useTheme();
  const create = useCreateModifier(group.id);
  const update = useUpdateModifier(group.id);
  const remove = useDeleteModifier(group.id);

  const [name, setName] = useState('');
  const [priceCents, setPriceCents] = useState(0);

  const add = () => {
    if (!name.trim()) return toast.error('Name the choice', 'e.g. Oat milk');
    create.mutate(
      { name: name.trim(), price_cents: priceCents },
      {
        onSuccess: () => {
          setName('');
          setPriceCents(0);
          toast.success('Choice added');
        },
        onError: (e) => toast.error('Could not add', errorText(e)),
      },
    );
  };

  const confirmRemove = (m: MenuModifier) =>
    Alert.alert('Remove this choice?', `${m.name} will stop being offered.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          remove.mutate(m.id, { onError: (e) => toast.error('Could not remove', errorText(e)) }),
      },
    ]);

  return (
    <View
      style={{
        gap: theme.spacing[3],
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        paddingTop: theme.spacing[4],
      }}
    >
      <AppText variant="label">Choices</AppText>

      {group.modifiers.length === 0 ? (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          None yet. A group with no choices offers nothing at the POS.
        </AppText>
      ) : null}

      {group.modifiers.map((m) => (
        <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <AppText style={{ flex: 1 }} numberOfLines={1}>
            {m.name}
          </AppText>
          <MonoText size="sm" muted>
            {m.price_cents > 0 ? `+${formatNPR(m.price_cents)}` : 'Free'}
          </MonoText>
          {/* Turning a choice off keeps it on bills already taken; deleting
              it does too — the price was folded in at sale time. */}
          <Button
            title={m.is_active ? 'On' : 'Off'}
            variant="ghost"
            accessibilityLabel={`toggle-choice-${m.name}`}
            onPress={() =>
              update.mutate(
                { id: m.id, patch: { is_active: !m.is_active } },
                { onError: (e) => toast.error('Could not save', errorText(e)) },
              )
            }
          />
          {canDelete ? (
            <Button
              title=""
              variant="ghost"
              accessibilityLabel={`remove-choice-${m.name}`}
              icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
              onPress={() => confirmRemove(m)}
            />
          ) : null}
        </View>
      ))}

      <View style={{ gap: theme.spacing[2] }}>
        <AppText variant="label">Add a choice</AppText>
        <AppSheet.TextInput
          value={name}
          onChangeText={setName}
          placeholder="e.g. Oat milk"
          placeholderTextColor={theme.colors.textFaint}
          accessibilityLabel="choice-name"
          style={fieldStyle(theme)}
        />
        {/* Zero is legal and common — "No sugar" is a choice, not a charge. */}
        <AmountInput
          label="Extra charge"
          valueCents={priceCents}
          onChangeCents={setPriceCents}
          insideSheet
          testID="choice-price"
        />
        <Button title="Add choice" variant="secondary" onPress={add} loading={create.isPending} />
      </View>
    </View>
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
