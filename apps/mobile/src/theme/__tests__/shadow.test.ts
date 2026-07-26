import { Platform } from 'react-native';
import { shadow } from '../shadow';
import type { ShadowStyle } from '../buildTheme';

const TOKEN: ShadowStyle = {
  shadowColor: '#000',
  shadowOpacity: 0.3,
  shadowRadius: 12,
  shadowOffset: { width: 0, height: 6 },
  elevation: 4,
};

/** Platform.OS is a plain property under the RN jest preset. */
function withPlatform(os: 'ios' | 'android', fn: () => void) {
  const original = Platform.OS;
  (Platform as { OS: string }).OS = os;
  try {
    fn();
  } finally {
    (Platform as { OS: string }).OS = original;
  }
}

describe('shadow()', () => {
  it('on Android drops the software-blurred props and keeps hardware elevation', () => {
    withPlatform('android', () => {
      const s = shadow(TOKEN);
      expect(s).toEqual({ elevation: 4 });
      // These are what force an offscreen software layer per view.
      expect(s).not.toHaveProperty('shadowRadius');
      expect(s).not.toHaveProperty('shadowOpacity');
      expect(s).not.toHaveProperty('shadowColor');
      expect(s).not.toHaveProperty('shadowOffset');
    });
  });

  it('on iOS passes the design token through untouched', () => {
    withPlatform('ios', () => {
      expect(shadow(TOKEN)).toEqual(TOKEN);
    });
  });

  it('does not mutate the token it is given', () => {
    withPlatform('android', () => {
      shadow(TOKEN);
      expect(TOKEN.shadowRadius).toBe(12);
    });
  });
});
