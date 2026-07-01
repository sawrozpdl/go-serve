// Flat ESLint config (ESLint 9), mirroring the web app's setup but using the
// Expo-maintained flat preset which bundles the RN/React/import rules.
const expoConfig = require('eslint-config-expo/flat');

module.exports = [
  ...expoConfig,
  {
    ignores: ['dist/*', '.expo/*', 'coverage/*', 'android/*', 'ios/*'],
  },
];
