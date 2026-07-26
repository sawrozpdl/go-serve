/**
 * Platform-correct elevation.
 *
 * `theme.elevation.*` carries the DESIGN intent (an iOS-style shadow triple
 * plus an Android elevation step). Applying that triple verbatim on Android is
 * a performance trap: React Native's new architecture implements
 * `shadowRadius`/`shadowOpacity` there with a `BlurMaskFilter`, which cannot be
 * hardware-accelerated. Every view carrying one becomes a software-blurred
 * offscreen layer that the MAIN thread has to rasterise while it records the
 * display list.
 *
 * Measured on a Pixel-class device (release build, 1080x2400): a More-menu
 * screen rendering nine shadowed cards spent 2.19s inside a single
 * `Record View#draw()`, versus 0.11s for a screen with the same node count and
 * one shadowed card. That is ~240ms of main-thread work per shadowed row.
 *
 * `elevation` alone is drawn by the RenderThread from the view's outline, so it
 * stays cheap and still reads as a lifted surface. Keep the full triple on iOS,
 * where it is the native (and cheap) path.
 */
import { Platform } from 'react-native';
import type { ViewStyle } from 'react-native';
import type { ShadowStyle } from './buildTheme';

/**
 * Turn a design shadow token into a style safe to put on any number of views.
 * On Android this is the hardware elevation step only.
 */
export function shadow(token: ShadowStyle): ViewStyle {
  return Platform.OS === 'android' ? { elevation: token.elevation } : token;
}
