import { useEffect, useState } from "react";
import { AppState, Platform } from "react-native";

/**
 * True while the app is actually in front of the user.
 *
 * Refresh timers used to run at a fixed rate forever, including while the tab was hidden or the
 * phone was in a pocket. On a metered connection that is the difference between a chat app and a
 * battery complaint, so everything that refreshes on a timer is gated on this.
 */
export function useAppVisible(): boolean {
  const read = () =>
    Platform.OS === "web"
      ? typeof document === "undefined" || document.visibilityState !== "hidden"
      : AppState.currentState === "active";

  const [visible, setVisible] = useState(read);

  useEffect(() => {
    if (Platform.OS === "web") {
      if (typeof document === "undefined") return;
      const onChange = () => setVisible(read());
      document.addEventListener("visibilitychange", onChange);
      return () => document.removeEventListener("visibilitychange", onChange);
    }
    const subscription = AppState.addEventListener("change", () => setVisible(read()));
    return () => subscription.remove();
  }, []);

  return visible;
}
