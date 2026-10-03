// Dynamic Expo config. Wraps the static `app.json` and folds in env-driven
// values at build time. Using the function form (vs `module.exports = config`)
// is what `expo-doctor` checks for to confirm the dynamic config "uses"
// the static one.

module.exports = ({ config }) => {
  // Preview = the internal test build (own icon/name/package, test tools such as
  // "expire the trial" — see src/lib/buildFlags.ts). It must never be true in a
  // store build, so an EAS "production" profile build refuses it even when
  // APP_VARIANT=preview leaks in from the shell. Xcode Cloud (iOS store builds)
  // never sets APP_VARIANT.
  const isPreview =
    process.env.APP_VARIANT === "preview" && process.env.EAS_BUILD_PROFILE !== "production";

  // A store build without its RevenueCat key can never sell the unlock, so
  // every user is locked out the day their trial ends — and the paywall only
  // says "not available", which reads like a store hiccup, not a broken build.
  // Refuse the build instead. Every Android store build passes through here
  // (builder-expo and `eas build` both set EAS_BUILD_PROFILE); the iOS store
  // build (Xcode Cloud) gets its key from ci_scripts/ci_post_clone.sh.
  if (process.env.EAS_BUILD_PROFILE === "production") {
    const platform = process.env.EAS_BUILD_PLATFORM;
    const required = {
      android: ["EXPO_PUBLIC_RC_ANDROID_KEY"],
      ios: ["EXPO_PUBLIC_RC_IOS_KEY"],
    }[platform] ?? ["EXPO_PUBLIC_RC_ANDROID_KEY", "EXPO_PUBLIC_RC_IOS_KEY"];
    const missing = required.filter((k) => !process.env[k]);
    if (missing.length) {
      throw new Error(
        `production build without ${missing.join(", ")}: the one-time unlock could not be bought. ` +
          `Set it in the eas.json "production" profile env.`,
      );
    }
  }

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
      isPreview,
      // RevenueCat PUBLIC SDK keys (appl_… / goog_…) — safe to embed. Set per
      // build via EXPO_PUBLIC_RC_* env (eas.json / .env.local). The one-time
      // purchase unlocks the app after the 5-day trial. Undefined → the
      // Purchases SDK stays disabled, the unlock can never be bought or
      // restored, and every user is stuck at the paywall once the trial ends.
      revenueCatIosKey: process.env.EXPO_PUBLIC_RC_IOS_KEY,
      revenueCatAndroidKey: process.env.EXPO_PUBLIC_RC_ANDROID_KEY,
    },
  };
};
