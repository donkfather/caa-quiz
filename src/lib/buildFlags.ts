import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Application from "expo-application";

// Which build this is, for the test-only tools (expire the trial, test
// notification). Store builds must not contain reachable test tools (Apple
// 2.3.1 "hidden features"), so the gate has two independent locks:
//
// 1. Build time — app.config.js sets extra.isPreview only for APP_VARIANT=preview
//    and never for an EAS "production" profile build, whatever else is set.
//    Xcode Cloud (iOS store builds) does not read eas.json and does not set
//    APP_VARIANT, so it is false there too; its Archive action is Release,
//    so __DEV__ is false as well.
// 2. Run time — on Android the preview build has its own application id
//    (com.bhdit.caaquiz.preview, see app.config.js), so a store build that
//    somehow got the flag still refuses. The iOS preview profile is a
//    simulator-only build (eas.json) and never reaches the App Store.

/** extra.isPreview from app.config.js. */
export const IS_PREVIEW_BUILD = Constants.expoConfig?.extra?.isPreview === true;

function previewIdentity(): boolean {
  if (Platform.OS !== "android") return true;
  try {
    return (Application.applicationId ?? "").endsWith(".preview");
  } catch {
    return false;
  }
}

/** True only in a dev client or an internal preview build. */
export const DEV_TOOLS_ENABLED: boolean = __DEV__ || (IS_PREVIEW_BUILD && previewIdentity());
