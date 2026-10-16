/**
 * Branch / workspace switcher (multi-branch, 0088). A compact chip showing
 * where you are — "● Thamel" or "All branches" — that opens a sheet to move
 * between branches of the business, look at all of them on the dashboard, or
 * hop to an unrelated workspace. Before this, the only way to change workspace
 * on the phone was to sign out.
 *
 * Invisible until needed: one membership → renders nothing.
 */
import { useState } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { Check, ChevronsUpDown, Layers } from 'lucide-react-native';
import { AppSheet } from '@/components/ui/AppSheet';
import { ListRow } from '@/components/ui/ListRow';
import { PressableScale } from '@/components/ui/PressableScale';
import { AppText, MonoText } from '@/components/ui/Text';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { useOverview } from '@/api/business';
import { activeMemberships } from '@/auth/permissions';
import { branchColor, branchLabel, hasBranches } from '@/lib/branches';
import { useBranchScope } from '@/stores/branchScope';
import { useTenantStore } from '@/stores/tenant';

function Dot({ color }: { color: string }) {
  return <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />;
}

/**
 * `lens="dashboard"` (default) shows "All branches" when that view is on.
 * `lens="work"` always names the branch you're working in — on the More tab,
 * where Menu, Shift and the rest act on exactly one branch.
 */
export function BranchSwitcher({ lens = 'dashboard' }: { lens?: 'dashboard' | 'work' }) {
  const theme = useTheme();
  const router = useRouter();
  const me = useMe();
  const active = useTenantStore((s) => s.active);
  const setActive = useTenantStore((s) => s.setActive);
  const setAll = useBranchScope((s) => s.setAll);
  const overview = useOverview();
  const [open, setOpen] = useState(false);

  const multi = hasBranches(me.data);
  const memberships = activeMemberships(me.data);
  if (!multi && memberships.length <= 1) return null;

  const branches = multi ? overview.branches : [];
  const inBusiness = new Set(branches.map((b) => b.slug));
  const others = memberships.filter((m) => !inBusiness.has(m.tenant_slug));
  const current = branches.find((b) => b.slug === active?.slug);
  const label = (n: string) => branchLabel(n, overview.business?.name);

  const showAll = overview.active && lens === 'dashboard';
  const triggerLabel = showAll ? 'All branches' : current ? label(current.name) : (active?.name ?? 'Workspace');

  function goTo(slug: string, id: string, name: string) {
    setOpen(false);
    setAll(false);
    if (slug === active?.slug) return;
    setActive({ slug, id, name });
    // Via the index route: /me is keyed by slug, so the new branch's
    // permissions load there before it picks a landing tab (as the picker does).
    router.replace('/');
  }

  function goToAll() {
    setOpen(false);
    setAll(true);
    router.navigate('/dashboard');
  }

  return (
    <>
      <PressableScale
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`${multi ? 'Branch' : 'Workspace'}: ${triggerLabel}. Switch`}
        testID="branch-switcher"
        hitSlop={6}
        style={{
          alignSelf: 'flex-start',
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing[2],
          paddingHorizontal: theme.spacing[3],
          paddingVertical: theme.spacing[1] + 2,
          borderRadius: theme.radii.pill,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface,
          maxWidth: '100%',
        }}
      >
        {showAll ? (
          <Layers size={14} color={theme.colors.stamp.brand.fg} strokeWidth={1.8} />
        ) : current ? (
          <Dot color={branchColor(branches, current.slug)} />
        ) : null}
        <AppText numberOfLines={1} style={{ flexShrink: 1, fontFamily: theme.fonts.bodyMedium }}>
          {triggerLabel}
        </AppText>
        <ChevronsUpDown size={14} color={theme.colors.textFaint} />
      </PressableScale>

      <AppSheet open={open} onClose={() => setOpen(false)} title={overview.business?.name ?? 'Workspaces'} size="medium">
        <AppSheet.ScrollView
          contentContainerStyle={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[8], gap: theme.spacing[1] }}
        >
          {multi && overview.available ? (
            <ListRow
              title="All branches"
              subtitle="See the whole business on the dashboard"
              left={<Layers size={18} color={theme.colors.stamp.brand.fg} strokeWidth={1.8} />}
              right={overview.active ? <Check size={18} color={theme.colors.stamp.brand.fg} /> : undefined}
              onPress={goToAll}
              testID="branch-all"
            />
          ) : null}
          {branches.map((b) => {
            const isCurrent = !overview.active && b.slug === active?.slug;
            return (
              <ListRow
                key={b.slug}
                title={label(b.name)}
                subtitle={b.roles.join(' + ')}
                left={<Dot color={branchColor(branches, b.slug)} />}
                right={isCurrent ? <Check size={18} color={theme.colors.stamp.brand.fg} /> : undefined}
                onPress={() => goTo(b.slug, b.tenant_id, b.name)}
                testID={`branch-${b.slug}`}
              />
            );
          })}
          {others.length > 0 ? (
            <View style={{ marginTop: theme.spacing[4], gap: theme.spacing[1] }}>
              <MonoText size="2xs" muted>
                {multi ? 'OTHER WORKSPACES' : 'WORKSPACES'}
              </MonoText>
              {others.map((m) => (
                <ListRow
                  key={m.tenant_slug}
                  title={m.tenant_name}
                  subtitle={m.roles.join(' + ')}
                  right={!overview.active && m.tenant_slug === active?.slug ? <Check size={18} color={theme.colors.stamp.brand.fg} /> : undefined}
                  onPress={() => goTo(m.tenant_slug, m.tenant_id, m.tenant_name)}
                  testID={`workspace-${m.tenant_slug}`}
                />
              ))}
            </View>
          ) : null}
        </AppSheet.ScrollView>
      </AppSheet>
    </>
  );
}

// Kept for existing importers; the hook lives in api/business.
export { useOverview };
