/**
 * Platform super-admin console (M10). A read view for platform admins: the
 * tenant roster with a health summary, and a per-tenant detail sheet. Billing /
 * plan / write-lock actions stay on the richer web console.
 */
import { useState } from 'react';
import { View, ScrollView, RefreshControl } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Building2 } from 'lucide-react-native';
import type { StampTone } from '@cafe-mgmt/design-tokens';
import type { AdminTenant } from '@cafe-mgmt/api-types';
import { AppText, MonoText } from '@/components/ui/Text';
import { Card } from '@/components/ui/Card';
import { Stat } from '@/components/ui/Stat';
import { Stamp } from '@/components/ui/Stamp';
import { EmptyState } from '@/components/ui/EmptyState';
import { ErrorState } from '@/components/ui/ErrorState';
import { Skeleton } from '@/components/ui/Skeleton';
import { AppSheet } from '@/components/ui/AppSheet';
import { StackHeader } from '@/components/ui/StackHeader';
import { useTheme } from '@/theme';
import { useMe } from '@/api/auth';
import { useSuperTenants, useSuperTenant } from '@/api/super';

export default function SuperConsole() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const tenants = useSuperTenants();
  const [detail, setDetail] = useState<AdminTenant | null>(null);

  if (me.data && !me.data.is_platform_admin) return <Redirect href="/more" />;

  const data = tenants.data;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Platform" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[4],
        }}
        refreshControl={<RefreshControl refreshing={tenants.isRefetching} onRefresh={() => void tenants.refetch()} tintColor={theme.colors.primary} />}
      >
        {tenants.isError && !data ? (
          <ErrorState detail={String(tenants.error)} onRetry={() => void tenants.refetch()} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
              <Stat label="Tenants" value={data ? String(data.summary.total) : ''} loading={tenants.isLoading} style={{ flex: 1 }} />
              <Stat label="Active" value={data ? String(data.summary.active) : ''} loading={tenants.isLoading} style={{ flex: 1 }} />
              <Stat
                label="Past due"
                value={data ? String(data.summary.past_due) : ''}
                tone={data && data.summary.past_due > 0 ? 'danger' : 'default'}
                loading={tenants.isLoading}
                style={{ flex: 1 }}
              />
            </View>

            {tenants.isLoading ? (
              <View style={{ gap: theme.spacing[3] }}>
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} height={64} radius={theme.radii.lg} />
                ))}
              </View>
            ) : (data?.tenants ?? []).length === 0 ? (
              <EmptyState icon={<Building2 size={28} color={theme.colors.textMuted} />} title="No tenants yet" hint="Workspaces appear here as they onboard." />
            ) : (
              <View style={{ gap: theme.spacing[3] }}>
                {(data?.tenants ?? []).map((t) => (
                  <Card key={t.tenant_id} onPress={() => setDetail(t)} style={{ gap: theme.spacing[1] }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[2] }}>
                      <AppText style={{ fontFamily: theme.fonts.bodyMedium, flex: 1 }} numberOfLines={1}>
                        {t.name}
                      </AppText>
                      <StatePill label={t.billing_state || t.status} />
                    </View>
                    <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                      {t.plan_name} ·{' '}
                      <MonoText size="sm" muted>
                        {t.active_members}
                      </MonoText>{' '}
                      member{t.active_members === 1 ? '' : 's'}
                      {t.owner_email ? ` · ${t.owner_email}` : ''}
                    </AppText>
                  </Card>
                ))}
              </View>
            )}
          </>
        )}
      </ScrollView>

      {detail ? <TenantDetail tenant={detail} onClose={() => setDetail(null)} /> : null}
    </View>
  );
}

function toneFor(label: string): StampTone {
  if (/(active|paid)/i.test(label)) return 'success';
  if (/(trial)/i.test(label)) return 'info';
  if (/(due|lock|suspend)/i.test(label)) return 'danger';
  return 'neutral';
}

function StatePill({ label }: { label: string }) {
  return <Stamp label={label.replace(/_/g, ' ')} tone={toneFor(label)} size="sm" />;
}

function DetailRow({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.spacing[3], paddingVertical: theme.spacing[1] }}>
      <AppText variant="muted">{k}</AppText>
      {mono ? (
        <MonoText size="sm" style={{ flexShrink: 1, textAlign: 'right' }}>
          {v}
        </MonoText>
      ) : (
        <AppText style={{ fontFamily: theme.fonts.bodyMedium, flexShrink: 1, textAlign: 'right' }}>{v}</AppText>
      )}
    </View>
  );
}

function TenantDetail({ tenant, onClose }: { tenant: AdminTenant; onClose: () => void }) {
  const theme = useTheme();
  const detail = useSuperTenant(tenant.tenant_id);
  const d = detail.data ?? tenant;
  const Row = DetailRow;
  return (
    <AppSheet open onClose={onClose} title={tenant.name}>
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[3], paddingBottom: theme.spacing[3] }}>
        <Card level={2} padded style={{ gap: theme.spacing[1] }}>
          <Row k="Slug" v={d.slug} />
          <Row k="Plan" v={d.plan_name} />
          <Row k="Billing" v={(d.billing_state || d.status).replace(/_/g, ' ')} />
          <Row k="Members" v={`${d.active_members}${d.member_limit ? ` / ${d.member_limit}` : ''}`} mono />
          {d.trial_ends_at ? <Row k="Trial ends" v={new Date(d.trial_ends_at).toLocaleDateString()} mono /> : null}
          {d.paid_through_at ? <Row k="Paid through" v={new Date(d.paid_through_at).toLocaleDateString()} mono /> : null}
          {d.owner_email ? <Row k="Owner" v={d.owner_email} /> : null}
          {d.last_activity ? <Row k="Last activity" v={new Date(d.last_activity).toLocaleDateString()} mono /> : null}
        </Card>
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          Plan changes, billing, and write-lock live on the web console.
        </AppText>
      </View>
    </AppSheet>
  );
}
