/**
 * Privacy & data — export what the platform holds about you, and delete your
 * account.
 *
 * Deletion is not a nicety: Apple 5.1.1(v) and Google Play both REQUIRE an app
 * that lets people create an account to let them delete it from inside the
 * app. Go Serve shipped without one on mobile, which is a store rejection
 * waiting to happen as much as it is something people are owed.
 *
 * The server refuses (409 `sole_owner`) when the user is the last owner of a
 * workspace, because deleting them would leave a cafe nobody can administer.
 * That refusal is NAMED here — which workspaces, and what to do — rather than
 * shown as a bare error, since "transfer ownership first" is only actionable
 * if you know where.
 */
import { useState } from 'react';
import { View, Alert, Share } from 'react-native';
import { Download, Trash2 } from 'lucide-react-native';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Section } from '@/components/ui/Section';
import { useTheme } from '@/theme';
import { useExportMyData, useDeleteMyAccount } from '@/api/account';
import { useAuthStore } from '@/stores/auth';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';

/** Past this the share sheet is the wrong tool — Android silently truncates a
 *  very long EXTRA_TEXT, which would hand someone a half export and no hint. */
const SHARE_LIMIT_CHARS = 200_000;

export function PrivacySection() {
  const theme = useTheme();
  const exportData = useExportMyData();
  const deleteAccount = useDeleteMyAccount();
  const signOut = useAuthStore((s) => s.signOut);
  const [blockedBy, setBlockedBy] = useState<string[] | null>(null);

  const runExport = async () => {
    try {
      const data = await exportData.mutateAsync();
      const json = JSON.stringify(data, null, 2);
      if (json.length > SHARE_LIMIT_CHARS) {
        toast.error(
          'Your export is too large to share from here',
          'Download it from the dashboard instead — the share sheet would cut it short.',
        );
        return;
      }
      await Share.share({ message: json });
    } catch (e) {
      toast.error('Could not export', errorText(e));
    }
  };

  const runDelete = () => {
    deleteAccount.mutate(undefined, {
      onSuccess: async () => {
        toast.success('Account deleted');
        await signOut();
      },
      onError: (e) => {
        const err = e as { code?: string; workspaces?: string[] };
        if (err.code === 'sole_owner') {
          // Naming them is the whole point: "transfer ownership first" is only
          // actionable if you know which cafe.
          setBlockedBy(err.workspaces ?? []);
          return;
        }
        toast.error('Could not delete the account', errorText(e));
      },
    });
  };

  const confirmDelete = () => {
    setBlockedBy(null);
    Alert.alert(
      'Delete your account?',
      'This removes you from every workspace and anonymises your record. It cannot be undone. ' +
        'Orders, payments and shifts you recorded stay with the cafe — they are its books, not yours.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete my account', style: 'destructive', onPress: runDelete },
      ],
    );
  };

  return (
    <Section title="Privacy & data">
      <Card>
        <View style={{ gap: theme.spacing[4] }}>
          <View style={{ gap: theme.spacing[2] }}>
            <Button
              title="Export my data"
              variant="secondary"
              icon={<Download size={16} color={theme.colors.primary} />}
              onPress={runExport}
              loading={exportData.isPending}
            />
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Everything the platform holds about you, as one JSON file, shared wherever you like.
            </AppText>
          </View>

          <View style={{ gap: theme.spacing[2] }}>
            <Button
              title="Delete my account"
              variant="ghost"
              icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
              onPress={confirmDelete}
              loading={deleteAccount.isPending}
            />
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Removes you from every workspace and anonymises your record. The cafe keeps its own
              books.
            </AppText>

            {blockedBy ? (
              <View
                style={{
                  gap: theme.spacing[1],
                  padding: theme.spacing[3],
                  borderRadius: theme.radii.md,
                  borderWidth: 1,
                  borderColor: theme.colors.dangerFg,
                }}
              >
                <AppText style={{ color: theme.colors.dangerFg, fontFamily: theme.fonts.bodySemi }}>
                  You are the only owner of{' '}
                  {blockedBy.length === 1 ? blockedBy[0] : `${blockedBy.length} workspaces`}.
                </AppText>
                {blockedBy.length > 1 ? (
                  <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                    {blockedBy.join(', ')}
                  </AppText>
                ) : null}
                <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                  Make someone else an owner there, or delete the workspace, and then come back.
                  Leaving a cafe with no owner would lock everyone out of it.
                </AppText>
              </View>
            ) : null}
          </View>
        </View>
      </Card>
    </Section>
  );
}
