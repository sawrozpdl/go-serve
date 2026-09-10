/**
 * Pick one image from the library, in the shape an upload needs.
 *
 * Returns `null` when the person cancels or declines the permission — both are
 * ordinary outcomes, not errors, and a caller that treats a cancel as a
 * failure shows an error toast for a decision the user just made deliberately.
 *
 * Deliberately library-only. A camera picker would add a CAMERA permission to
 * the manifest, and an unused permission is exactly what drew Play Store
 * scrutiny when `expo-audio` was in the build.
 */
import * as ImagePicker from 'expo-image-picker';
import type { PickedImage } from '@/api/uploads';

/** Turn a picker asset into a multipart part, filling in what it omits. */
export function toPickedImage(asset: {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
}): PickedImage {
  const type = asset.mimeType || 'image/jpeg';
  // Some Android providers hand back no filename at all; the server needs one
  // to infer the extension, so derive it from the mime type.
  const name = asset.fileName || `upload.${type.split('/')[1] || 'jpg'}`;
  return { uri: asset.uri, name, type };
}

export async function pickImage(): Promise<PickedImage | null> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted) return null;

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsEditing: true,
    // Menu art is shown at a few hundred points; a 12MP original is a slow
    // upload on cafe wifi for no visible gain.
    quality: 0.7,
  });
  if (result.canceled || !result.assets?.length) return null;
  return toPickedImage(result.assets[0]);
}
