/**
 * Team (M9) — members with their roles (edit / remove) and pending invites
 * (create / revoke). The RBAC role editor itself stays on web; here you assign
 * existing roles.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, Alert } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Plus, Users } from 'lucide-react-native';
import type { Member, TenantRole } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { Stamp } from '@/components/ui/Stamp';
import { Section } from '@/components/ui/Section';
import { ListRow } from '@/components/ui/ListRow';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { AppSheet } from '@/components/ui/AppSheet';
import { StackHeader } from '@/components/ui/StackHeader';
import { useTheme, type Theme } from '@/theme';
import { useMe } from '@/api/auth';
import { can } from '@/auth/permissions';
import { useMembers, useInvites, useRoles, useUpdateMemberRoles, useRemoveMember, useCreateInvite, useRevokeInvite } from '@/api/team';
import { toast } from '@/lib/toast';

export default function Team() {
  const theme = useTheme();
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
      <StackHeader
        title="Team"
        right={
          canInvite ? (
            <Pressable onPress={() => setInviteOpen(true)} hitSlop={10} accessibilityLabel="add-invite">
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
          gap: theme.spacing[5],
        }}
      >
        <Section title="Members" count={members.data?.length}>
          {members.isLoading ? (
            <View style={{ gap: theme.spacing[3] }}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={72} radius={theme.radii.lg} />
              ))}
            </View>
          ) : members.isError ? (
            <ErrorState detail={String(members.error)} onRetry={() => void members.refetch()} />
          ) : (members.data ?? []).length === 0 ? (
            <EmptyState icon={<Users size={28} color={theme.colors.textMuted} />} title="No members yet" hint="Invite a teammate to get started." />
          ) : (
            <View style={{ gap: theme.spacing[3] }}>
              {(members.data ?? []).map((m) => (
                <Card key={m.user_id} onPress={canEditRoles ? () => setRoleEdit(m) : undefined} style={{ gap: theme.spacing[2] }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[2] }}>
                    <AppText style={{ fontFamily: theme.fonts.bodyMedium, flex: 1 }} numberOfLines={1}>
                      {m.name || m.email}
                    </AppText>
                    {m.status !== 'active' ? <Stamp label={m.status} tone="neutral" size="sm" /> : null}
                  </View>
                  {m.name ? (
                    <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                      {m.email}
                    </AppText>
                  ) : null}
                  {m.roles.length > 0 ? (
                    <View style={{ flexDirection: 'row', gap: theme.spacing[1] + 2, flexWrap: 'wrap' }}>
                      {m.roles.map((r) => (
                        <Stamp key={r} label={r} tone="brand" size="sm" />
                      ))}
                    </View>
                  ) : null}
                </Card>
              ))}
            </View>
          )}
        </Section>

        {canSeeInvites && (invites.data ?? []).length > 0 ? (
          <Section title="Pending invites" count={(invites.data ?? []).length}>
            <View style={{ gap: theme.spacing[2] }}>
              {(invites.data ?? []).map((inv) => (
                <Card key={inv.id} padded={false}>
                  <ListRow title={inv.email} subtitle={inv.roles.join(', ') || 'no roles'} right={<RevokeButton id={inv.id} />} />
                </Card>
              ))}
            </View>
          </Section>
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
      {(roles.data ?? []).map((r) => (
        <Chip key={r.id} label={r.name} selected={selected.includes(r.key)} onPress={() => onToggle(r.key)} />
      ))}
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
    <AppSheet
      open
      onClose={onClose}
      title={member.name || member.email}
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          <Button title="Save roles" onPress={save} loading={update.isPending} />
          {canRemove ? <Button title="Remove from workspace" variant="ghost" onPress={confirmRemove} /> : null}
        </View>
      }
    >
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <AppText variant="label">Roles</AppText>
        <RoleChips selected={roles} onToggle={toggle} />
      </View>
    </AppSheet>
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
    <AppSheet
      open
      onClose={onClose}
      title="Invite teammate"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2] }}>
          <Button title="Send invite" onPress={submit} loading={create.isPending} />
        </View>
      }
    >
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[4], paddingBottom: theme.spacing[2] }}>
        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Email</AppText>
          <AppSheet.TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="name@example.com"
            placeholderTextColor={theme.colors.textFaint}
            keyboardType="email-address"
            autoCapitalize="none"
            autoFocus
            style={fieldStyle(theme)}
          />
        </View>
        <AppText variant="label">Roles</AppText>
        <RoleChips selected={roles} onToggle={toggle} />
      </View>
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
    fontSize: theme.text.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    minHeight: 52,
  };
}
