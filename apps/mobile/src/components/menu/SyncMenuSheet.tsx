/**
 * Sync this branch's menu to other branches (multi-branch) — the phone version
 * of web's SyncMenuModal. Pick branches and what goes with the menu, preview
 * exactly what changes in each (the server does the real writes and rolls them
 * back), then sync. Matched by name; nothing is ever deleted; each branch keeps
 * its own prices unless "Also push prices" is on.
 */
import { useMemo, useState } from 'react';
import { View, Pressable } from 'react-native';
import { Check, AlertTriangle } from 'lucide-react-native';
import type { MenuSyncResponse, MenuSyncTarget } from '@cafe-mgmt/api-types';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { ToggleRow } from '@/components/ui/Field';
import { useTheme } from '@/theme';
import { toast } from '@/lib/toast';
import { formatNPR } from '@/lib/format';
import { branchColor, branchLabel } from '@/lib/branches';
import { useOverview, useSyncMenuToBranches } from '@/api/business';

const STATUS_COPY: Record<MenuSyncTarget['status'], string> = {
  ok: '',
  forbidden: "You can't edit this branch's menu.",
  write_locked: 'This branch is read-only until its plan is sorted out.',
  not_found: 'Not a branch you can reach.',
  error: 'Something went wrong here — nothing was changed.',
};

export function extrasChanges(t: MenuSyncTarget): number {
  const x = t.extras;
  if (!x) return 0;
  return x.photos + x.stations + x.add_on_groups_new + x.add_on_groups_updated + x.add_on_options_new + x.add_on_options_updated + x.add_on_links;
}

export function syncChanges(res: MenuSyncResponse | null): number {
  return (res?.targets ?? [])
    .filter((t) => t.status === 'ok')
    .reduce((n, t) => n + t.result.items.created + t.result.items.updated + t.result.categories.created + extrasChanges(t), 0);
}

export function SyncMenuSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const { business, branches } = useOverview();
  const sync = useSyncMenuToBranches();
  const others = branches.filter((b) => !b.is_active);
  // null = "every branch I can edit" — derived, so it's right even when the
  // per-branch abilities land after the sheet mounts.
  const [chosen, setChosen] = useState<string[] | null>(null);
  const picked = chosen ?? others.filter((b) => b.can?.menu_update).map((b) => b.slug);
  const setPicked = (f: (p: string[]) => string[]) => setChosen(f(picked));
  const [photos, setPhotos] = useState(true);
  const [addOns, setAddOns] = useState(true);
  const [stations, setStations] = useState(false);
  const [prices, setPrices] = useState(false);
  const [preview, setPreview] = useState<MenuSyncResponse | null>(null);
  const label = (n: string) => branchLabel(n, business?.name);
  const changes = useMemo(() => syncChanges(preview), [preview]);

  const run = (dryRun: boolean) =>
    sync.mutate(
      { targets: picked, include_prices: prices, dry_run: dryRun, photos, add_ons: addOns, stations },
      {
        onSuccess: (res) => {
          if (dryRun) {
            setPreview(res);
            return;
          }
          const ok = res.targets.filter((t) => t.status === 'ok').length;
          toast.success(`Menu synced to ${ok} ${ok === 1 ? 'branch' : 'branches'}`);
          onClose();
        },
        onError: (e) => toast.error('Could not sync the menu', (e as Error).message),
      },
    );

  const footer = (
    <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
      {preview ? (
        <>
          <Button
            title={changes === 0 ? 'Already in sync' : `Sync ${changes} ${changes === 1 ? 'change' : 'changes'}`}
            onPress={() => run(false)}
            loading={sync.isPending}
            disabled={changes === 0}
          />
          <Button title="Back" variant="ghost" onPress={() => setPreview(null)} />
        </>
      ) : (
        <Button title="Preview changes" onPress={() => run(true)} loading={sync.isPending} disabled={picked.length === 0} />
      )}
    </View>
  );

  return (
    <AppSheet open onClose={onClose} title="Sync menu to branches" full footer={footer}>
      <AppSheet.ScrollView
        contentContainerStyle={{ paddingHorizontal: theme.spacing[5], paddingBottom: theme.spacing[6], gap: theme.spacing[4] }}
      >
        {!preview ? (
          <>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Matched by name. New items are added, existing ones get this branch&apos;s description and kitchen setting.
              Nothing is ever deleted.
            </AppText>
            <View style={{ gap: theme.spacing[2] }}>
              <AppText variant="label">To</AppText>
              {others.map((b) => {
                const allowed = !!b.can?.menu_update;
                const on = picked.includes(b.slug);
                return (
                  <Pressable
                    key={b.slug}
                    disabled={!allowed}
                    onPress={() => setPicked((p) => (on ? p.filter((s) => s !== b.slug) : [...p, b.slug]))}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on, disabled: !allowed }}
                    testID={`sync-to-${b.slug}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: theme.spacing[3],
                      minHeight: 48,
                      paddingHorizontal: theme.spacing[4],
                      borderRadius: theme.radii.md,
                      borderWidth: 1,
                      borderColor: on ? theme.colors.primary : theme.colors.border,
                      backgroundColor: on ? theme.colors.primaryTint : theme.colors.surface,
                      opacity: allowed ? 1 : 0.5,
                    }}
                  >
                    <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: branchColor(branches, b.slug) }} />
                    <AppText style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>
                      {label(b.name)}
                    </AppText>
                    {!allowed ? (
                      <MonoText size="2xs" muted>
                        NO MENU ACCESS
                      </MonoText>
                    ) : on ? (
                      <Check size={18} color={theme.colors.primary} />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            <ToggleRow label="Photos" hint="Items and categories get this branch's photo." value={photos} onValueChange={setPhotos} />
            <ToggleRow
              label="Add-ons"
              hint="Add-on groups and options, attached to the same items."
              value={addOns}
              onValueChange={setAddOns}
            />
            <ToggleRow
              label="Stations"
              hint="Route items to the station with the same name there. Stations aren't created."
              value={stations}
              onValueChange={setStations}
            />
            <ToggleRow
              label="Also push prices"
              hint="Off: each branch keeps its own prices; new items arrive at this branch's price."
              value={prices}
              onValueChange={setPrices}
            />
          </>
        ) : (
          preview.targets.map((t) => {
            const rows = (t.result.rows ?? []).filter((r) => r.action === 'new' || r.action === 'update');
            const x = t.extras;
            return (
              <View key={t.slug} style={{ gap: theme.spacing[2] }} testID={`sync-preview-${t.slug}`}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[2] }}>
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: branchColor(branches, t.slug) }} />
                  <AppText style={{ flex: 1, fontFamily: theme.fonts.bodySemi }} numberOfLines={1}>
                    {label(t.name || t.slug)}
                  </AppText>
                </View>
                {t.status !== 'ok' ? (
                  <View style={{ flexDirection: 'row', gap: theme.spacing[2], alignItems: 'center' }}>
                    <AlertTriangle size={14} color={theme.colors.stamp.brand.fg} />
                    <AppText style={{ fontSize: theme.text.sm, flex: 1 }}>{STATUS_COPY[t.status]}</AppText>
                  </View>
                ) : (
                  <>
                    <AppText variant="muted" style={{ fontSize: theme.text.sm }}>
                      {t.result.items.created} new · {t.result.items.updated} updated
                      {x
                        ? ` · ${x.photos} photos · ${x.add_on_groups_new + x.add_on_groups_updated} add-on groups · ${x.add_on_links} add-on links`
                        : ''}
                      {x && x.stations ? ` · ${x.stations} station changes` : ''}
                    </AppText>
                    {x?.missing_stations?.length ? (
                      <AppText style={{ fontSize: theme.text.sm, color: theme.colors.stamp.brand.fg }}>
                        No {x.missing_stations.join(', ')} station there — those items keep their current station.
                      </AppText>
                    ) : null}
                    {rows.slice(0, 20).map((r) => (
                      <View key={`${r.category}\u0000${r.item}`} style={{ flexDirection: 'row', gap: theme.spacing[2], alignItems: 'baseline' }}>
                        <MonoText size="2xs" style={{ color: r.action === 'new' ? theme.colors.successFg : theme.colors.stamp.brand.fg }}>
                          {r.action.toUpperCase()}
                        </MonoText>
                        <AppText style={{ flex: 1, minWidth: 0 }} numberOfLines={1}>
                          {r.item}
                        </AppText>
                        <MonoText size="sm" style={{ flexShrink: 0 }}>
                          {formatNPR(r.new_price_cents)}
                        </MonoText>
                      </View>
                    ))}
                    {rows.length > 20 ? (
                      <AppText variant="faint" style={{ fontSize: theme.text.xs }}>
                        and {rows.length - 20} more
                      </AppText>
                    ) : null}
                    {rows.length === 0 && extrasChanges(t) === 0 ? (
                      <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                        Already matches — nothing to change.
                      </AppText>
                    ) : null}
                  </>
                )}
              </View>
            );
          })
        )}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}
