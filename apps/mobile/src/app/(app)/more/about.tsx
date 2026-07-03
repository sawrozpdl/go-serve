/**
 * More → About. App version + EAS Update status: manual check/download/
 * restart flow. Update checks are unavailable in dev (__DEV__) — expo-updates
 * throws ERR_UPDATES_DISABLED outside of production builds.
 */
import { useState } from 'react';
import { View, ScrollView, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import type { StampTone } from '@cafe-mgmt/design-tokens';
import { AppText } from '@/components/ui/Text';
import { StackHeader } from '@/components/ui/StackHeader';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { ListRow } from '@/components/ui/ListRow';
import { Stamp } from '@/components/ui/Stamp';
import { useTheme } from '@/theme';
import { toast } from '@/lib/toast';

type Status = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'downloaded' | 'error';

const STATUS_LABEL: Record<Status, string> = {
  idle: 'Not checked yet',
  checking: 'Checking…',
  upToDate: 'Up to date',
  available: 'Update available',
  downloading: 'Downloading…',
  downloaded: 'Ready to restart',
  error: 'Check failed',
};

const STATUS_TONE: Record<Status, StampTone> = {
  idle: 'neutral',
  checking: 'neutral',
  upToDate: 'success',
  available: 'info',
  downloading: 'info',
  downloaded: 'warn',
  error: 'danger',
};

export default function About() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<Status>('idle');

  async function check() {
    setStatus('checking');
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable) {
        setStatus('available');
        toast.info('Update available', 'Tap Download to install it.');
      } else {
        setStatus('upToDate');
        toast.success("You're up to date");
      }
    } catch (e) {
      setStatus('error');
      toast.error('Check failed', (e as Error).message);
    }
  }

  async function download() {
    setStatus('downloading');
    try {
      const result = await Updates.fetchUpdateAsync();
      if (result.isNew) {
        setStatus('downloaded');
        toast.success('Update downloaded', 'Restart to apply it.');
      } else {
        setStatus('upToDate');
      }
    } catch (e) {
      setStatus('available');
      toast.error('Download failed', (e as Error).message);
    }
  }

  function confirmRestart() {
    Alert.alert(
      'Restart to apply update?',
      'The app will reload. Any unsaved screen state will be lost.',
      [
        { text: 'Not now', style: 'cancel' },
        { text: 'Restart', style: 'destructive', onPress: () => void Updates.reloadAsync() },
      ],
    );
  }

  const updateId = Updates.updateId;
  const buttonProps = (() => {
    switch (status) {
      case 'checking':
        return { title: 'Checking…', variant: 'secondary' as const, loading: true, onPress: check };
      case 'available':
        return { title: 'Download update', variant: 'primary' as const, onPress: download };
      case 'downloading':
        return { title: 'Downloading…', variant: 'primary' as const, loading: true, onPress: download };
      case 'downloaded':
        return { title: 'Restart to apply', variant: 'danger' as const, onPress: confirmRestart };
      default:
        return { title: 'Check for updates', variant: 'secondary' as const, onPress: check };
    }
  })();

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="About" />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingTop: theme.spacing[4],
          paddingBottom: insets.bottom + theme.spacing[8],
          gap: theme.spacing[6],
        }}
      >
        <Section title="Version">
          <Card style={{ gap: theme.spacing[1] }}>
            <ListRow title="App version" value={Constants.expoConfig?.version ?? '—'} />
            <ListRow title="Running" value={Updates.isEmbeddedLaunch ? 'Bundled build' : 'OTA update'} />
            <ListRow title="Channel" value={Updates.channel ?? '—'} />
            <ListRow title="Runtime version" value={Updates.runtimeVersion ?? '—'} />
            {!Updates.isEmbeddedLaunch && updateId ? (
              <ListRow title="Update ID" value={updateId.slice(0, 8)} />
            ) : null}
          </Card>
        </Section>

        <Section title="Updates">
          <Card style={{ gap: theme.spacing[3] }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <AppText>Status</AppText>
              <Stamp label={STATUS_LABEL[status]} tone={STATUS_TONE[status]} />
            </View>
            {__DEV__ ? (
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                Update checks are only available in production builds.
              </AppText>
            ) : (
              <Button {...buttonProps} />
            )}
          </Card>
        </Section>
      </ScrollView>
    </View>
  );
}
