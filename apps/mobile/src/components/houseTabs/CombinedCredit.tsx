/**
 * Credit across branches (multi-branch). The same customer's accounts at
 * different branches are linked by phone; each part shows what that branch is
 * owed. A payment is still taken at the branch that's owed, so tapping a part
 * opens that account — switching branch first when it's another one.
 */
import { View, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { AppText, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useTheme } from '@/theme';
import { formatNPR } from '@/lib/format';
import { errorText } from '@/lib/errorText';
import { branchColor, branchLabel } from '@/lib/branches';
import { useBusinessCredit, useOverview } from '@/api/business';
import { useTenantStore } from '@/stores/tenant';

function Dot({ color }: { color: string }) {
  return <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />;
}

/** Opens an account, switching to its branch first when it isn't this one. */
export function useOpenCreditAccount(onOpenHere: (id: string) => void) {
  const router = useRouter();
  const active = useTenantStore((s) => s.active);
  const setActive = useTenantStore((s) => s.setActive);
  return (a: { tenant_id: string; branch_slug: string; branch_name: string; house_tab_id: string }) => {
    if (a.branch_slug === active?.slug) {
      onOpenHere(a.house_tab_id);
      return;
    }
    setActive({ slug: a.branch_slug, id: a.tenant_id, name: a.branch_name });
    router.replace({ pathname: '/more/house-tabs', params: { open: a.house_tab_id } });
  };
}

export function CombinedCredit({ onOpenHere }: { onOpenHere: (id: string) => void }) {
  const theme = useTheme();
  const q = useBusinessCredit();
  const { business, branches } = useOverview();
  const open = useOpenCreditAccount(onOpenHere);
  const label = (n: string) => branchLabel(n, business?.name);

  if (q.isPending) {
    return (
      <View style={{ gap: theme.spacing[3] }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={88} radius={theme.radii.lg} />
        ))}
      </View>
    );
  }
  if (q.isError || !q.data) return <ErrorState detail={errorText(q.error)} onRetry={() => void q.refetch()} />;

  const customers = q.data.customers.filter((c) => c.balance_cents !== 0);
  const missing = q.data.branches.filter((b) => b.status !== 'ok');
  return (
    <View style={{ gap: theme.spacing[3] }}>
      <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
        <Stat label="Owed · all" value={formatNPR(q.data.total_owed_cents)} style={{ flex: 1 }} />
        <Stat label="Customers" value={String(customers.length)} style={{ flex: 1 }} />
      </View>
      {missing.length > 0 ? (
        <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
          Not included: {missing.map((m) => m.name || m.slug).join(', ')} (no access).
        </AppText>
      ) : null}
      {customers.length === 0 ? (
        <AppText variant="muted">Nobody owes anything right now.</AppText>
      ) : (
        customers.map((c) => (
          <Card key={c.key} style={{ gap: theme.spacing[2] }} testID={`credit-customer-${c.key}`}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: theme.spacing[2] }}>
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText style={{ fontFamily: theme.fonts.bodyMedium }} numberOfLines={1}>
                  {c.name}
                </AppText>
                {c.phone ? (
                  <MonoText size="2xs" muted numberOfLines={1}>
                    {c.phone}
                  </MonoText>
                ) : null}
              </View>
              <MonoText weight="bold" style={{ color: theme.colors.stamp.brand.fg, flexShrink: 0 }}>
                {formatNPR(c.balance_cents)}
              </MonoText>
            </View>
            {c.accounts
              .filter((a) => a.balance_cents !== 0)
              .map((a) => (
                <Pressable
                  key={a.house_tab_id}
                  onPress={() => open(a)}
                  accessibilityRole="button"
                  accessibilityLabel={`Open ${c.name} at ${label(a.branch_name)}`}
                  testID={`credit-account-${a.house_tab_id}`}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: theme.spacing[2],
                    minHeight: 40,
                    paddingVertical: theme.spacing[1],
                    borderTopWidth: 1,
                    borderTopColor: theme.colors.border,
                  }}
                >
                  <Dot color={branchColor(branches, a.branch_slug)} />
                  <AppText style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>
                    {label(a.branch_name)}
                  </AppText>
                  <MonoText style={{ flexShrink: 0 }}>{formatNPR(a.balance_cents)}</MonoText>
                  <ChevronRight size={16} color={theme.colors.textFaint} />
                </Pressable>
              ))}
          </Card>
        ))
      )}
      <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
        Accounts are linked across branches by phone; one without a phone stays on its own. Take a payment at the branch
        that&apos;s owed — tap that part to open it there.
      </AppText>
    </View>
  );
}

/** Inside one branch's account: what the same customer owes elsewhere. */
export function OwedElsewhere({ phone, onOpenHere }: { phone: string; onOpenHere: (id: string) => void }) {
  const theme = useTheme();
  const { business, branches } = useOverview();
  const active = useTenantStore((s) => s.active);
  const multi = branches.length > 1;
  const q = useBusinessCredit(phone, multi && !!phone.trim());
  const open = useOpenCreditAccount(onOpenHere);
  const elsewhere = (q.data?.customers ?? [])
    .flatMap((c) => c.accounts)
    .filter((a) => a.branch_slug !== active?.slug && a.balance_cents > 0);
  if (!multi || elsewhere.length === 0) return null;
  return (
    <View
      style={{
        gap: theme.spacing[1],
        padding: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.stamp.brand.border,
        backgroundColor: theme.colors.primaryTint,
      }}
      testID="owed-elsewhere"
    >
      {elsewhere.map((a) => (
        <Pressable key={a.house_tab_id} onPress={() => open(a)} accessibilityRole="button">
          <AppText style={{ fontSize: theme.text.sm }}>
            Also owes{' '}
            <AppText style={{ fontSize: theme.text.sm, color: theme.colors.stamp.brand.fg, textDecorationLine: 'underline' }}>
              {formatNPR(a.balance_cents)} at {branchLabel(a.branch_name, business?.name)}
            </AppText>
            {' '}— settle it there.
          </AppText>
        </Pressable>
      ))}
    </View>
  );
}
