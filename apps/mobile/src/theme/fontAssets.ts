/**
 * Font assets for `useFonts`. Isolated from `fonts.ts` (which holds only family
 * name strings) so the pure theme layer and its tests never pull in font
 * binaries. Loaded once at app boot in the root layout.
 */
import { Fraunces_700Bold, Fraunces_600SemiBold_Italic } from '@expo-google-fonts/fraunces';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';

export const fontAssets = {
  Fraunces_700Bold,
  Fraunces_600SemiBold_Italic,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
};
