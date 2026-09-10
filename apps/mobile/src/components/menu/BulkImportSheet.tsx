/**
 * Bulk menu import — paste the JSON a vision LLM read off a photo of the
 * paper menu, review it, import it.
 *
 * This is the onboarding accelerator: typing sixty items by hand on a phone is
 * why a cafe never finishes setting up. Copy the prompt, hand it to any
 * assistant with a photo, paste the answer back.
 *
 * The flow is paste → DRY RUN → import, and the dry run is not politeness.
 * The endpoint validates up front because a 4xx still commits the transaction
 * it was in, so a payload that fails halfway would leave the menu partly
 * imported. Previewing first turns that hazard into a number.
 */
import { useState } from 'react';
import { View, Share } from 'react-native';
import { ClipboardCopy } from 'lucide-react-native';
import { buildImportPrompt, parseImportJson, type ImportCategoryDraft } from '@cafe-mgmt/menu-import';
import type { BulkImportResult } from '@cafe-mgmt/api-types';
import { AppSheet } from '@/components/ui/AppSheet';
import { AppText, MonoText } from '@/components/ui/Text';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { ToggleRow } from '@/components/ui/Field';
import { ICON_REGISTRY } from '@/components/ui/Icon';
import { useTheme, type Theme } from '@/theme';
import { useBulkImportMenu } from '@/api/menuAdmin';
import { draftProblems, draftItemCount, toImportPayload } from '@/catalog/importDraft';
import { toast } from '@/lib/toast';
import { errorText } from '@/lib/errorText';

/** Mobile's own registry — a name web knows and this app doesn't must drop
 *  here rather than arrive as a broken glyph. */
const ICON_NAMES = Object.keys(ICON_REGISTRY);

export function BulkImportSheet({ onClose }: { onClose: () => void }) {
  const theme = useTheme();
  const importMenu = useBulkImportMenu();

  const [text, setText] = useState('');
  const [draft, setDraft] = useState<ImportCategoryDraft[] | null>(null);
  const [preview, setPreview] = useState<BulkImportResult | null>(null);
  const [overwrite, setOverwrite] = useState(true);

  const problems = draft ? draftProblems(draft) : [];
  const willSend = draft ? draftItemCount(draft) : 0;

  const parse = () => {
    try {
      const cats = parseImportJson(text, ICON_NAMES);
      setDraft(cats);
      setPreview(null);
    } catch (e) {
      // The parser's own messages are written for this moment — "paste the
      // whole JSON object your AI assistant returned" beats "Unexpected token".
      setDraft(null);
      toast.error('Could not read that', errorText(e));
    }
  };

  const run = (dryRun: boolean) => {
    if (!draft) return;
    if (willSend === 0) {
      return toast.error('Nothing to import', 'Every row is missing a usable price.');
    }
    importMenu.mutate(toImportPayload(draft, { dryRun, overwriteExisting: overwrite }), {
      onSuccess: (result) => {
        if (dryRun) {
          setPreview(result);
          return;
        }
        toast.success(
          'Menu imported',
          `${result.items.created} added, ${result.items.updated} updated`,
        );
        onClose();
      },
      onError: (e) => toast.error(dryRun ? 'Preview failed' : 'Import failed', errorText(e)),
    });
  };

  return (
    <AppSheet
      open
      onClose={onClose}
      title="Import a menu"
      size="full"
      footer={
        <View style={{ paddingHorizontal: theme.spacing[5], paddingTop: theme.spacing[2], gap: theme.spacing[2] }}>
          {draft == null ? (
            <Button title="Read the JSON" onPress={parse} disabled={!text.trim()} />
          ) : preview == null ? (
            <Button title="Preview the import" onPress={() => run(true)} loading={importMenu.isPending} />
          ) : (
            <Button
              title={`Import ${willSend} item${willSend === 1 ? '' : 's'}`}
              onPress={() => run(false)}
              loading={importMenu.isPending}
            />
          )}
          <Button title="Cancel" variant="ghost" onPress={onClose} />
        </View>
      }
    >
      <AppSheet.ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing[5],
          paddingBottom: theme.spacing[6],
          gap: theme.spacing[4],
        }}
      >
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          Send the prompt below to any AI assistant along with a photo of your menu, then paste
          what it gives back.
        </AppText>
        <Button
          title="Share the prompt"
          variant="secondary"
          icon={<ClipboardCopy size={16} color={theme.colors.primary} />}
          onPress={() => void Share.share({ message: buildImportPrompt(ICON_NAMES) })}
        />

        <View style={{ gap: theme.spacing[2] }}>
          <AppText variant="label">Paste the JSON</AppText>
          <AppSheet.TextInput
            value={text}
            onChangeText={(t) => {
              setText(t);
              // A new paste invalidates whatever was parsed from the old one.
              setDraft(null);
              setPreview(null);
            }}
            placeholder={'{ "categories": [ … ] }'}
            placeholderTextColor={theme.colors.textFaint}
            accessibilityLabel="import-json"
            multiline
            style={fieldStyle(theme, { minHeight: 140, textAlignVertical: 'top', fontFamily: theme.fonts.mono })}
          />
        </View>

        {draft ? (
          <Card style={{ gap: theme.spacing[2] }}>
            <AppText style={{ fontFamily: theme.fonts.bodySemi }}>
              {draft.length} categor{draft.length === 1 ? 'y' : 'ies'} · {willSend} item
              {willSend === 1 ? '' : 's'}
            </AppText>
            {draft.map((c) => (
              <AppText key={c.name} variant="faint" style={{ fontSize: theme.text.sm }} numberOfLines={1}>
                {c.name} — {c.items.length} item{c.items.length === 1 ? '' : 's'}
              </AppText>
            ))}
          </Card>
        ) : null}

        {problems.length > 0 ? (
          <Card style={{ gap: theme.spacing[1], borderColor: theme.colors.stamp.warn.fg, borderWidth: 1 }}>
            {/* Named, not silently dropped: pasting forty items and getting
                thirty-eight is only acceptable if you are told which two. */}
            <AppText style={{ color: theme.colors.stamp.warn.fg, fontFamily: theme.fonts.bodySemi }}>
              {problems.length} row{problems.length === 1 ? '' : 's'} will be skipped
            </AppText>
            {problems.slice(0, 8).map((p) => (
              <AppText key={`${p.category}-${p.item}`} variant="faint" style={{ fontSize: theme.text.sm }}>
                {p.category} · {p.item} — {p.reason}
              </AppText>
            ))}
            {problems.length > 8 ? (
              <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
                …and {problems.length - 8} more.
              </AppText>
            ) : null}
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              Fix the prices in the JSON and paste again, or import the rest and add these by hand.
            </AppText>
          </Card>
        ) : null}

        {draft ? (
          <ToggleRow
            label="Update items that already exist"
            hint={
              overwrite
                ? 'A name that already exists is updated with the imported price and description.'
                : 'Existing names are left exactly as they are; only new ones are added.'
            }
            value={overwrite}
            onValueChange={(v) => {
              setOverwrite(v);
              // The preview was computed under the old flag.
              setPreview(null);
            }}
          />
        ) : null}

        {preview ? (
          <Card style={{ gap: theme.spacing[2] }}>
            <AppText style={{ fontFamily: theme.fonts.bodySemi }}>Nothing has been written yet</AppText>
            <MonoText size="sm" muted>
              Categories: {preview.categories.created} new · {preview.categories.updated} updated ·{' '}
              {preview.categories.skipped} unchanged
            </MonoText>
            <MonoText size="sm" muted>
              Items: {preview.items.created} new · {preview.items.updated} updated ·{' '}
              {preview.items.skipped} unchanged
            </MonoText>
            <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
              This was a dry run against your real menu. Import to commit it.
            </AppText>
          </Card>
        ) : null}
      </AppSheet.ScrollView>
    </AppSheet>
  );
}

function fieldStyle(theme: Theme, extra?: object) {
  return {
    color: theme.colors.text,
    backgroundColor: theme.colors.surfaces[2],
    borderRadius: theme.radii.md,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    fontFamily: theme.fonts.body,
    borderWidth: 1,
    borderColor: theme.colors.border,
    ...extra,
  };
}
