/**
 * In-app feedback (M9). Anyone can submit a bug / idea / question and track
 * their own submissions. Screenshot attachment is a tracked follow-up.
 */
import { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BugKind } from '@cafe-mgmt/api-types';
import type { StampTone } from '@cafe-mgmt/design-tokens';
import { AppText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { StackHeader } from '@/components/ui/StackHeader';
import { SegmentedField } from '@/components/ui/Field';
import { Section } from '@/components/ui/Section';
import { Card } from '@/components/ui/Card';
import { Stamp } from '@/components/ui/Stamp';
import { useTheme } from '@/theme';
import { useMyBugReports, useSubmitFeedback } from '@/api/feedback';
import { toast } from '@/lib/toast';

const KINDS: { value: BugKind; label: string }[] = [
  { value: 'bug', label: 'Bug' },
  { value: 'idea', label: 'Idea' },
  { value: 'question', label: 'Question' },
  { value: 'other', label: 'Other' },
];

const STATUS_TONE: Record<string, StampTone> = {
  resolved: 'success',
  in_progress: 'warn',
  open: 'warn',
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

  const reports = mine.data ?? [];

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <StackHeader title="Feedback" />
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[6],
        }}
      >
        <View style={{ gap: theme.spacing[4] }}>
          <SegmentedField label="Type" value={kind} options={KINDS} onChange={setKind} />
          <TextField label="Title (optional)" value={title} onChangeText={setTitle} placeholder="Short summary" />
          <TextField label="What happened?" value={description} onChangeText={setDescription} placeholder="Describe the bug or idea…" multiline />
          <Button title="Send feedback" onPress={send} loading={submit.isPending} />
        </View>

        {reports.length > 0 ? (
          <Section title="Your reports" count={reports.length}>
            {reports.map((r) => (
              <Card key={r.id} style={{ gap: theme.spacing[1] }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing[2] }}>
                  <AppText style={{ fontFamily: theme.fonts.bodyMedium, flex: 1 }} numberOfLines={1}>
                    {r.title || r.description}
                  </AppText>
                  <Stamp label={r.status.replace('_', ' ')} tone={STATUS_TONE[r.status] ?? 'neutral'} size="sm" />
                </View>
                <AppText variant="faint" style={{ fontSize: theme.text.sm, textTransform: 'capitalize' }}>
                  {r.kind} · {new Date(r.created_at).toLocaleDateString()}
                </AppText>
              </Card>
            ))}
          </Section>
        ) : null}
      </ScrollView>
    </View>
  );
}
