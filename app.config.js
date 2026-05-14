// Dynamic Expo config. Wraps the static `app.json` and folds in env-driven
// values at build time. Using the function form (vs `module.exports = config`)
// is what `expo-doctor` checks for to confirm the dynamic config "uses"
// the static one.

module.exports = ({ config }) => {
  const isPreview = process.env.APP_VARIANT === "preview";

  return {
    ...config,
    name: isPreview ? `${config.name} (Preview)` : config.name,
    icon: isPreview ? "./assets/icon.preview.png" : config.icon,
    android: {
      ...config.android,
      package: isPreview
        ? `${config.android.package}.preview`
        : config.android.package,
      adaptiveIcon: {
        ...config.android.adaptiveIcon,
        foregroundImage: isPreview
          ? "./assets/adaptive-icon.preview.png"
          : config.android.adaptiveIcon.foregroundImage,
        backgroundColor: isPreview
          ? "#f97316"
          : config.android.adaptiveIcon.backgroundColor,
      },
    },
    extra: {
      ...(config.extra ?? {}),
      useTestAds: process.env.EXPO_PUBLIC_USE_TEST_ADS === "true",
      isPreview,
    },
  };
};
