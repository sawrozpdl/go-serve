/**
 * Platform super-admin console (M10). A read view for platform admins: the
 * tenant roster with a health summary, and a per-tenant detail sheet. Billing /
 * plan / write-lock actions stay on the richer web console.
 */
import { useState } from 'react';
import { View, Pressable, ScrollView, RefreshControl } from 'react-native';
import { Redirect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { AdminTenant } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { Sheet } from '@/components/ui/Sheet';
import { StackHeader } from '@/components/ui/StackHeader';
import { useTheme, hexToRgba } from '@/theme';
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
        {data ? (
          <View style={{ flexDirection: 'row', gap: theme.spacing[3] }}>
            <Summary label="Tenants" value={String(data.summary.total)} />
            <Summary label="Active" value={String(data.summary.active)} />
            <Summary label="Past due" value={String(data.summary.past_due)} tone={data.summary.past_due > 0 ? theme.colors.dangerFg : undefined} />
          </View>
        ) : null}

        {tenants.isLoading ? (
          <AppText variant="faint">Loading…</AppText>
        ) : (
          (data?.tenants ?? []).map((t) => (
            <Pressable
              key={t.tenant_id}
              onPress={() => setDetail(t)}
              style={{ backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4], gap: 4 }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                <AppText style={{ fontFamily: theme.fonts.bodyMedium, flex: 1 }}>{t.name}</AppText>
                <StatePill label={t.billing_state || t.status} />
              </View>
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                {t.plan_name} · {t.active_members} member{t.active_members === 1 ? '' : 's'}
                {t.owner_email ? ` · ${t.owner_email}` : ''}
              </AppText>
            </Pressable>
          ))
        )}
      </ScrollView>

      {detail ? <TenantDetail tenant={detail} onClose={() => setDetail(null)} /> : null}
    </View>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const theme = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4], gap: 2 }}>
      <AppText variant="faint" style={{ fontSize: theme.text.xs }}>{label}</AppText>
      <AppText style={{ fontFamily: theme.fonts.bodyBold, fontSize: 22, color: tone ?? theme.colors.text }}>{value}</AppText>
    </View>
  );
}

function StatePill({ label }: { label: string }) {
  const theme = useTheme();
  const tone =
    /(active|paid)/i.test(label) ? theme.colors.successFg :
    /(trial)/i.test(label) ? theme.colors.infoFg :
    /(due|lock|suspend)/i.test(label) ? theme.colors.dangerFg :
    theme.colors.textFaint;
  return (
    <View style={{ paddingHorizontal: theme.spacing[2], paddingVertical: 2, borderRadius: theme.radii.pill, backgroundColor: hexToRgba(tone, 0.16) }}>
      <AppText style={{ color: tone, fontSize: theme.text.xs, textTransform: 'capitalize' }}>{label.replace(/_/g, ' ')}</AppText>
    </View>
  );
}

function DetailRow({ k, v }: { k: string; v: string }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: theme.spacing[1] }}>
      <AppText variant="muted">{k}</AppText>
      <AppText style={{ fontFamily: theme.fonts.bodyMedium, flexShrink: 1, textAlign: 'right' }}>{v}</AppText>
    </View>
  );
}

function TenantDetail({ tenant, onClose }: { tenant: AdminTenant; onClose: () => void }) {
  const theme = useTheme();
  const detail = useSuperTenant(tenant.tenant_id);
  const d = detail.data ?? tenant;
  const Row = DetailRow;
  return (
    <Sheet open onClose={onClose} title={tenant.name}>
      <View style={{ paddingHorizontal: theme.spacing[5], gap: theme.spacing[1], paddingBottom: theme.spacing[3] }}>
        <Row k="Slug" v={d.slug} />
        <Row k="Plan" v={d.plan_name} />
        <Row k="Billing" v={(d.billing_state || d.status).replace(/_/g, ' ')} />
        <Row k="Members" v={`${d.active_members}${d.member_limit ? ` / ${d.member_limit}` : ''}`} />
        {d.trial_ends_at ? <Row k="Trial ends" v={new Date(d.trial_ends_at).toLocaleDateString()} /> : null}
        {d.paid_through_at ? <Row k="Paid through" v={new Date(d.paid_through_at).toLocaleDateString()} /> : null}
        {d.owner_email ? <Row k="Owner" v={d.owner_email} /> : null}
        {d.last_activity ? <Row k="Last activity" v={new Date(d.last_activity).toLocaleDateString()} /> : null}
        <AppText variant="faint" style={{ fontSize: theme.text.sm, marginTop: theme.spacing[3] }}>
          Plan changes, billing, and write-lock live on the web console.
        </AppText>
      </View>
    </Sheet>
  );
}
