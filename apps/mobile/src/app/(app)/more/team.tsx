/**
 * Team (M9) — members with their roles (edit / remove) and pending invites
 * (create / revoke). The RBAC role editor itself stays on web; here you assign
 * existing roles.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert } from 'react-native';
import { useRouter, Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronLeft, Plus } from 'lucide-react-native';
import type { Member, TenantRole } from '@cafe-mgmt/api-types';
import { Heading, AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Sheet } from '@/components/ui/Sheet';
import { useTheme, hexToRgba } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useMembers, useInvites, useRoles, useUpdateMemberRoles, useRemoveMember, useCreateInvite, useRevokeInvite } from '@/api/team';
import { toast } from '@/lib/toast';

export default function Team() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const members = useMembers();
  const invites = useInvites();

  const [roleEdit, setRoleEdit] = useState<Member | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const canRead = can(me.data, 'member:read');
  const canEditRoles = can(me.data, 'member:update_role');
  const canRemove = can(me.data, 'member:delete');
  const canInvite = can(me.data, 'invite:create');
  const canSeeInvites = can(me.data, 'invite:read');
  if (me.data && !canRead) return <Redirect href="/more" />;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
          <Pressable onPress={() => router.back()} hitSlop={10} accessibilityLabel="back">
            <ChevronLeft size={26} color={theme.colors.primary} />
          </Pressable>
          <Heading style={{ fontSize: 26, flex: 1 }}>Team</Heading>
          {canInvite ? (
            <Pressable onPress={() => setInviteOpen(true)} hitSlop={10} accessibilityLabel="add-invite">
              <Plus size={24} color={theme.colors.primary} />
            </Pressable>
          ) : null}
        </View>

        <View style={{ gap: theme.spacing[3] }}>
          <AppText variant="label">Members</AppText>
          {members.isLoading ? (
            <AppText variant="faint">Loading…</AppText>
          ) : (
            (members.data ?? []).map((m) => (
              <Pressable
                key={m.user_id}
                onPress={() => canEditRoles && setRoleEdit(m)}
                style={{ backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4], gap: theme.spacing[2] }}
              >
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <AppText style={{ fontFamily: theme.fonts.bodyMedium }}>{m.name || m.email}</AppText>
                  {m.status !== 'active' ? (
                    <AppText variant="faint" style={{ fontSize: theme.text.xs, textTransform: 'capitalize' }}>{m.status}</AppText>
                  ) : null}
                </View>
                {m.name ? <AppText variant="faint" style={{ fontSize: theme.text.sm }}>{m.email}</AppText> : null}
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {m.roles.map((r) => (
                    <View key={r} style={{ paddingHorizontal: theme.spacing[2], paddingVertical: 2, borderRadius: theme.radii.pill, backgroundColor: hexToRgba(theme.colors.primary, 0.14) }}>
                      <AppText style={{ color: theme.colors.primary, fontSize: theme.text.xs }}>{r}</AppText>
                    </View>
                  ))}
                </View>
              </Pressable>
            ))
          )}
        </View>

        {canSeeInvites && (invites.data ?? []).length > 0 ? (
          <View style={{ gap: theme.spacing[3] }}>
            <AppText variant="label">Pending invites</AppText>
            {(invites.data ?? []).map((inv) => (
              <View key={inv.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4] }}>
                <View style={{ flex: 1 }}>
                  <AppText>{inv.email}</AppText>
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }}>{inv.roles.join(', ') || 'no roles'}</AppText>
                </View>
                <RevokeButton id={inv.id} />
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>

      {roleEdit ? <RoleSheet member={roleEdit} canRemove={canRemove} onClose={() => setRoleEdit(null)} /> : null}
      {inviteOpen ? <InviteSheet onClose={() => setInviteOpen(false)} /> : null}
    </View>
  );
}

function RevokeButton({ id }: { id: string }) {
  const theme = useTheme();
  const revoke = useRevokeInvite();
  return (
    <Pressable
      onPress={() => revoke.mutate(id, { onSuccess: () => toast.success('Invite revoked'), onError: (e) => toast.error('Failed', (e as Error).message) })}
      hitSlop={8}
      accessibilityLabel="revoke-invite"
    >
      <AppText style={{ color: theme.colors.dangerFg, fontSize: theme.text.sm }}>Revoke</AppText>
    </Pressable>
  );
}

function RoleChips({ selected, onToggle }: { selected: TenantRole[]; onToggle: (key: TenantRole) => void }) {
  const theme = useTheme();
  const roles = useRoles();
  return (
    <View style={{ flexDirection: 'row', gap: theme.spacing[2], flexWrap: 'wrap' }}>
      {(roles.data ?? []).map((r) => {
        const on = selected.includes(r.key);
        return (
          <Pressable
            key={r.id}
            onPress={() => onToggle(r.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={{
              paddingHorizontal: theme.spacing[3],
              paddingVertical: theme.spacing[2],
              borderRadius: theme.radii.pill,
              borderWidth: 1,
              borderColor: on ? theme.colors.primary : theme.colors.border,
              backgroundColor: on ? theme.colors.primaryTint : 'transparent',
            }}
          >
            <AppText style={{ color: on ? theme.colors.primary : theme.colors.textMuted, fontSize: theme.text.sm }}>{r.name}</AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

function RoleSheet({ member, canRemove, onClose }: { member: Member; canRemove: boolean; onClose: () => void }) {
  const theme = useTheme();
  const update = useUpdateMemberRoles();
  const remove = useRemoveMember();
  const [roles, setRoles] = useState<TenantRole[]>(member.roles);
  const toggle = (key: TenantRole) => setRoles((rs) => (rs.includes(key) ? rs.filter((r) => r !== key) : [...rs, key]));

  const save = () =>
    update.mutate(
      { userId: member.user_id, roles },
      { onSuccess: () => { toast.success('Roles updated'); onClose(); }, onError: (e) => toast.error('Failed', (e as Error).message) },
    );

  const confirmRemove = () =>
    Alert.alert('Remove member?', `${member.name || member.email} will lose access to this workspace.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => remove.mutate(member.user_id, { onSuccess: () => { toast.success('Removed'); onClose(); }, onError: (e) => toast.error('Failed', (e as Error).message) }),
      },
    ]);

  return (
    <Sheet open onClose={onClose} title={member.name || member.email}>
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <AppText variant="label">Roles</AppText>
        <RoleChips selected={roles} onToggle={toggle} />
        <Button title="Save roles" onPress={save} loading={update.isPending} />
        {canRemove ? <Button title="Remove from workspace" variant="ghost" onPress={confirmRemove} /> : null}
      </View>
    </Sheet>
  );
}

function InviteSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const create = useCreateInvite();
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<TenantRole[]>([]);
  const toggle = (key: TenantRole) => setRoles((rs) => (rs.includes(key) ? rs.filter((r) => r !== key) : [...rs, key]));

  const submit = () => {
    if (!email.trim()) return toast.error('Enter an email');
    if (roles.length === 0) return toast.error('Pick at least one role');
    create.mutate(
      { email: email.trim(), roles },
      { onSuccess: () => { toast.success('Invite sent', email.trim()); onClose(); }, onError: (e) => toast.error('Could not invite', (e as Error).message) },
    );
  };

  return (
    <Sheet open onClose={onClose} title="Invite teammate">
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <TextField label="Email" value={email} onChangeText={setEmail} placeholder="name@example.com" keyboardType="email-address" autoCapitalize="none" autoFocus />
        <AppText variant="label">Roles</AppText>
        <RoleChips selected={roles} onToggle={toggle} />
        <Button title="Send invite" onPress={submit} loading={create.isPending} />
      </View>
    </Sheet>
  );
}
