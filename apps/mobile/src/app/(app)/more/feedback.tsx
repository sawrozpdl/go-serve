/**
 * In-app feedback (M9). Anyone can submit a bug / idea / question and track
 * their own submissions. Screenshot attachment is a tracked follow-up.
 */
import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BugKind } from '@cafe-mgmt/api-types';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { useTheme, hexToRgba } from '@/theme';
import { useMyBugReports, useSubmitFeedback } from '@/api/feedback';
import { toast } from '@/lib/toast';

const KINDS: { value: BugKind; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'question', label: 'Question' },
  { value: 'other', label: 'Other' },
];

const STATUS_TONE: Record<string, 'successFg' | 'warnFgTile' | 'textFaint'> = {
  resolved: 'successFg',
  in_progress: 'warnFgTile',
  open: 'warnFgTile',
};

export default function Feedback() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const mine = useMyBugReports();
  const submit = useSubmitFeedback();

  const [kind, setKind] = useState<BugKind>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const send = () => {
    if (!description.trim()) return toast.error('Add a description');
    submit.mutate(
      { kind, title: title.trim() || undefined, description: description.trim() },
      {
        onSuccess: () => {
          toast.success('Thanks — sent!');
          setTitle('');
          setDescription('');
        },
        onError: (e) => toast.error('Could not send', (e as Error).message),
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Feedback" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[5],
        }}
      >
        <View style={{ gap: theme.spacing[4] }}>
          <SegmentedField label="Type" value={kind} options={KINDS} onChange={setKind} />
          <TextField label="Title (optional)" value={title} onChangeText={setTitle} placeholder="Short summary" />
          <TextField label="What happened?" value={description} onChangeText={setDescription} placeholder="Describe the bug or idea…" multiline />
          <Button title="Send feedback" onPress={send} loading={submit.isPending} />
        </View>

        {(mine.data ?? []).length > 0 ? (
          <View style={{ gap: theme.spacing[3] }}>
            <AppText variant="label">Your reports</AppText>
            {(mine.data ?? []).map((r) => {
              const tone = theme.colors[STATUS_TONE[r.status] ?? 'textFaint'];
              return (
                <View key={r.id} style={{ backgroundColor: theme.colors.card, borderRadius: theme.radii.md, borderWidth: 1, borderColor: theme.colors.border, padding: theme.spacing[4], gap: 4 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <AppText style={{ fontFamily: theme.fonts.bodyMedium, flex: 1 }} numberOfLines={1}>
                      {r.title || r.description}
                    </AppText>
                    <View style={{ paddingHorizontal: theme.spacing[2], paddingVertical: 2, borderRadius: theme.radii.pill, backgroundColor: hexToRgba(tone, 0.16) }}>
                      <AppText style={{ color: tone, fontSize: theme.text.xs, textTransform: 'capitalize' }}>{r.status.replace('_', ' ')}</AppText>
                    </View>
                  </View>
                  <AppText variant="faint" style={{ fontSize: theme.text.sm, textTransform: 'capitalize' }}>
                    {r.kind} · {new Date(r.created_at).toLocaleDateString()}
                  </AppText>
                </View>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
