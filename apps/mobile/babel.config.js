module.exports = function (api) {
  api.cache(true);
  return {
    // babel-preset-expo (SDK 54+) auto-configures the react-native-worklets
    // plugin required by react-native-reanimated 4, and the React Compiler when
    // `experiments.reactCompiler` is enabled in app.json. No manual plugin list
    // needed unless we add a Babel plugin of our own.
    presets: ['babel-preset-expo'],
  };
};
