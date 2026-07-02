import type { ExpoConfig } from 'expo/config';
import type { ConfigPlugin } from 'expo/config-plugins';
import { withGradleProperties } from 'expo/config-plugins';

import { version } from './package.json';

// Release builds run KSP (expo-updates annotation processing) and Android
// Lint in the same Gradle daemon; the default Metaspace (512m) OOMs on a
// local machine. Appending overrides the auto-generated gradle.properties
// entries, since Java properties files take the last duplicate key.
const withLargerGradleHeap: ConfigPlugin = (config) =>
  withGradleProperties(config, (config) => {
    config.modResults.push(
      { type: 'property', key: 'org.gradle.jvmargs', value: '-Xmx4096m -XX:MaxMetaspaceSize=1024m' },
      { type: 'property', key: 'kotlin.daemon.jvm.options', value: '-Xmx2048m -XX:MaxMetaspaceSize=1024m' },
    );
    return config;
  });

// Reversed iOS OAuth client ID, e.g. com.googleusercontent.apps.123-abc.
// Only needed for iOS Google Sign-In; Android matches by package + SHA-1.
const iosUrlScheme = process.env.EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME;

const googleSignIn: string | [string, Record<string, unknown>] = iosUrlScheme
  ? ['@react-native-google-signin/google-signin', { iosUrlScheme }]
  : '@react-native-google-signin/google-signin';

const config: ExpoConfig = {
  name: 'Go Serve',
  slug: 'go-serve',
  version,
  orientation: 'default',
  icon: './assets/images/icon.png',
  scheme: 'goserve',
  userInterfaceStyle: 'automatic',
  ios: {
    // Uses the top-level `icon` (branded steaming-cup on carbon). The old
    // ./assets/expo.icon was the unbranded Expo Icon Composer template.
    supportsTablet: true,
    bundleIdentifier: 'com.goserve.app',
  },
  android: {
    package: 'com.goserve.app',
    adaptiveIcon: {
      backgroundColor: '#0f0e0b',
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
        backgroundColor: '#0f0e0b',
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
    // ExpoConfig's plugins type only declares string/tuple entries even
    // though the runtime config loader accepts plugin functions directly.
    withLargerGradleHeap as unknown as string,
  ],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  owner: 'sawrozpdl',
  extra: {
    eas: {
      projectId: '74236927-4519-454f-90aa-9103033df0f4',
    },
  },
  updates: {
    url: 'https://u.expo.dev/74236927-4519-454f-90aa-9103033df0f4',
  },
  runtimeVersion: {
    policy: 'appVersion',
  },
};

export default config;
