/**
 * Pick, preview and clear one image.
 *
 * Four callers earn a shared primitive: menu item, menu category, workspace
 * logo and receipt image. Each stores a URL on a different record, so this
 * owns the picking and the upload and hands back the URL — it never saves.
 *
 * Clearing sends `""` rather than null: that is the sentinel every one of
 * these endpoints reads as "remove it", where an omitted key means "leave it
 * alone". Getting that backwards silently keeps an image the operator just
 * deleted.
 */
import { useState } from 'react';
import { View, Image, Pressable } from 'react-native';
import { ImagePlus, Trash2 } from 'lucide-react-native';
import { AppText } from './Text';
import { Button } from './Button';
import { useTheme } from '../../theme';
import { pickImage } from '../../lib/pickImage';
import type { PickedImage } from '../../api/uploads';
import { toast } from '../../lib/toast';
import { errorText } from '../../lib/errorText';

export function ImageField({
  label,
  hint,
  value,
  onChange,
  upload,
  disabled,
}: {
  label: string;
  hint?: string;
  /** Current URL, or '' / undefined for none. */
  value: string | null | undefined;
  /** Called with the new URL, or '' to clear. */
  onChange: (url: string) => void;
  /** Uploads the picked file and resolves to its hosted URL. */
  upload: (image: PickedImage) => Promise<{ url: string }>;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const has = !!value;

  const choose = async () => {
    setBusy(true);
    try {
      const picked = await pickImage();
      // Cancelled, or the permission was declined. Both are ordinary
      // decisions, not failures — saying "upload failed" to someone who just
      // tapped Cancel is a lie.
      if (!picked) return;
      const { url } = await upload(picked);
      onChange(url);
      toast.success(`${label} updated`);
    } catch (e) {
      toast.error(`Could not upload the ${label.toLowerCase()}`, errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ gap: theme.spacing[2] }}>
      <AppText variant="label">{label}</AppText>
      {hint ? (
        <AppText variant="faint" style={{ fontSize: theme.text.sm }}>
          {hint}
        </AppText>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[3] }}>
        <Pressable
          onPress={disabled || busy ? undefined : choose}
          accessibilityRole="button"
          accessibilityLabel={has ? `change-${label}` : `add-${label}`}
          accessibilityState={{ disabled: !!disabled || busy }}
          style={{
            width: 72,
            height: 72,
            borderRadius: theme.radii.md,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surfaces[2],
            alignItems: 'center',
            justifyContent: 'center',
            overflow: 'hidden',
            opacity: disabled ? 0.5 : 1,
          }}
        >
          {has ? (
            <Image source={{ uri: value as string }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
          ) : (
            <ImagePlus size={22} color={theme.colors.textFaint} />
          )}
        </Pressable>

        <View style={{ flex: 1, gap: theme.spacing[2] }}>
          <Button
            title={has ? 'Change' : 'Choose an image'}
            variant="secondary"
            onPress={choose}
            loading={busy}
            disabled={disabled}
          />
          {has ? (
            <Button
              title="Remove"
              variant="ghost"
              icon={<Trash2 size={16} color={theme.colors.dangerFg} />}
              // '' is the sentinel these endpoints read as "clear"; omitting
              // the key means "leave as-is", which would keep the image.
              onPress={() => onChange('')}
              disabled={disabled || busy}
            />
          ) : null}
        </View>
      </View>
    </View>
  );
}
