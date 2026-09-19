/**
 * Single source of truth for the Android build offered on the website.
 *
 * The APK lives at public/VARNOX.apk, which Expo CLI copies into dist/ during the
 * static export, so it is served from this same origin at /VARNOX.apk. Bump the
 * version label here whenever a new APK is dropped into public/.
 */
import { Linking, Platform } from "react-native";

export const APK_PATH = "/VARNOX.apk";
export const APK_VERSION = "1.4";
export const APK_SIZE_LABEL = "255 KB";
export const APK_FILENAME = `VARNOX-${APK_VERSION}.apk`;

/** Triggers the download without navigating the SPA away from the current screen. */
export function downloadAndroidApp(): void {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const link = document.createElement("a");
    link.href = APK_PATH;
    link.download = APK_FILENAME;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    return;
  }
  void Linking.openURL(APK_PATH);
}
