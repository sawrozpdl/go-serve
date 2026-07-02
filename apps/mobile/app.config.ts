import type { ExpoConfig } from 'expo/config';

// Reversed iOS OAuth client ID, e.g. com.googleusercontent.apps.123-abc.
// Only needed for iOS Google Sign-In; Android matches by package + SHA-1.
const iosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;

const googleSignIn: string | [string, Record<string, unknown>] = iosUrlScheme
  ? ['@react-native-google-signin/google-signin', { iosUrlScheme }]
  : '@react-native-google-signin/google-signin';

const config: ExpoConfig = {
  name: 'Go Serve',
  slug: 'go-serve',
  version: '1.0.0',
  orientation: 'default',
  icon: './assets/images/icon.png',
  scheme: 'goserve',
  userInterfaceStyle: 'automatic',
  ios: {
    icon: './assets/expo.icon',
    supportsTablet: true,
    bundleIdentifier: 'com.goserve.app',
  },
  android: {
    package: 'com.goserve.app',
    adaptiveIcon: {
      backgroundColor: '#08070a',
      foregroundImage: './assets/images/android-icon-foreground.png',
      backgroundImage: './assets/images/android-icon-background.png',
      monochromeImage: './assets/images/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    'expo-sqlite',
    'expo-web-browser',
    'expo-audio',
    [
      'expo-splash-screen',
      {
        backgroundColor: '#08070a',
        image: './assets/images/splash-icon.png',
        imageWidth: 76,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission:
          'Go Serve needs photo access to attach menu, staff, and receipt images.',
      },
    ],
    googleSignIn,
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
};

export default config;
