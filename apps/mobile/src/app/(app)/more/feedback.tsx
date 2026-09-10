/**
 * In-app feedback. Anyone can submit a bug / idea / question, attach
 * screenshots, and track their own submissions.
 *
 * The mood is one tap and optional. It is not analytics decoration: triage
 * reads a five-star "idea" and an angry "bug" completely differently, and the
 * description alone rarely carries tone — people are polite in writing about
 * things that have ruined their morning.
 */
import { useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform, Pressable, Image } from 'react-native';
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
import { Chip } from '@/components/ui/Chip';

import { useTheme } from '@/theme';
import { useMyBugReports, useSubmitFeedback, MAX_FEEDBACK_FILES } from '@/api/feedback';
import { MOODS } from '@/feedback/mood';
import { pickImage } from '@/lib/pickImage';
import type { PickedImage } from '@/api/uploads';
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
  const [mood, setMood] = useState<number | null>(null);
  const [files, setFiles] = useState<PickedImage[]>([]);

  const addShot = async () => {
    if (files.length >= MAX_FEEDBACK_FILES) {
      return toast.error(`${MAX_FEEDBACK_FILES} screenshots is the limit`);
    }
    const picked = await pickImage();
    // Cancelled or permission declined — both ordinary decisions.
    if (picked) setFiles((f) => [...f, picked]);
  };

  const send = () => {
    if (!description.trim()) return toast.error('Add a description');
    submit.mutate(
      {
        kind,
        title: title.trim() || undefined,
        description: description.trim(),
        mood: mood ?? undefined,
        files,
      },
      {
        onSuccess: () => {
          setMood(null);
          setFiles([]);
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
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: theme.spacing[3],
          paddingHorizontal: theme.spacing[5],
          paddingBottom: insets.bottom + theme.spacing[10],
          gap: theme.spacing[6],
        }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={{ gap: theme.spacing[4] }}>
          <SegmentedField label="Type" value={kind} options={KINDS} onChange={setKind} />
          <TextField label="Title (optional)" value={title} onChangeText={setTitle} placeholder="Short summary" />
          <TextField label="What happened?" value={description} onChangeText={setDescription} placeholder="Describe the bug or idea…" multiline />

          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">How is it going? (optional)</AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
              {MOODS.map((m) => (
                <Chip
                  key={m.value}
                  label={`${m.emoji} ${m.label}`}
                  selected={mood === m.value}
                  // Re-tapping clears it: a mood you cannot unset is a mood
                  // you were forced to give.
                  onPress={() => setMood((cur) => (cur === m.value ? null : m.value))}
                  testID={`mood-${m.value}`}
                />
              ))}
            </View>
          </View>

          <View style={{ gap: theme.spacing[2] }}>
            <AppText variant="label">Screenshots (optional)</AppText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              A picture of the screen answers more than a paragraph about it. Up to{' '}
              {MAX_FEEDBACK_FILES}.
            </AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing[2] }}>
              {files.map((f) => (
                <Pressable
                  key={f.uri}
                  onPress={() => setFiles((cur) => cur.filter((x) => x.uri !== f.uri))}
                  accessibilityRole="button"
                  accessibilityLabel={`remove-screenshot-${f.name}`}
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: theme.radii.md,
                    overflow: 'hidden',
                    borderWidth: 1,
                    borderColor: theme.colors.border,
                  }}
                >
                  <Image source={{ uri: f.uri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                </Pressable>
              ))}
            </View>
            <Button
              title={files.length > 0 ? 'Add another' : 'Attach a screenshot'}
              variant="secondary"
              onPress={addShot}
              disabled={files.length >= MAX_FEEDBACK_FILES}
            />
            {files.length > 0 ? (
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                Tap one to remove it.
              </AppText>
            ) : null}
          </View>

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
      </KeyboardAvoidingView>
    </View>
  );
}
