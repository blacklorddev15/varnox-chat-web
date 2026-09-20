import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { currentWebPushState, disableWebPush, enableWebPush, type WebPushState } from "@/lib/web-push";

/**
 * "Notifications on this device" - the switch that a person actually turns on.
 *
 * Separate from the three category toggles above it, because it answers a different question. Those
 * say *what* to be told about; this says whether this particular browser can be reached at all, and
 * it is the thing that asks the browser for permission.
 *
 * Enabling is the only moment permission is requested. A notification prompt on first launch is the
 * fastest way to get one permanently refused, so nothing here runs until the switch is touched.
 */
export function WebPushRow({ colors }: { colors: ReturnType<typeof useColors> }) {
  const keyQuery = trpc.push.webKey.useQuery();
  const statusQuery = trpc.push.webStatus.useQuery();
  const register = trpc.push.registerWeb.useMutation();
  const unregister = trpc.push.unregisterWeb.useMutation();

  const [state, setState] = useState<WebPushState>("off");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  // Read from the browser rather than from the server, because those can disagree: the browser holds
  // the subscription and is the thing that actually decides whether a notification can be shown.
  useEffect(() => {
    void currentWebPushState().then(setState);
  }, []);

  const on = state === "on";
  const unsupported = state === "unsupported";
  const denied = state === "denied";

  const toggle = async (next: boolean) => {
    setNote(null);
    setBusy(true);
    try {
      if (next) {
        const publicKey = keyQuery.data?.key;
        if (!publicKey) {
          setNote("This server has no notification key configured, so notifications cannot be turned on yet.");
          return;
        }
        const result = await enableWebPush(publicKey);
        if (!result.ok) {
          setNote(result.reason);
          // The browser's own state is authoritative after a refusal, so re-read rather than assume.
          setState(await currentWebPushState());
          return;
        }
        // The browser is subscribed at this point; the server needs telling, or it will never send.
        // If that call fails the browser is subscribed to nothing, so it is undone rather than left
        // in a state that looks enabled on this screen and delivers nothing.
        try {
          await register.mutateAsync(result.subscription);
        } catch (error) {
          await disableWebPush();
          setState("off");
          throw error;
        }
        setState("on");
        void statusQuery.refetch();
        setNote("This device will now be notified even when Varnox is closed.");
      } else {
        const endpoint = await disableWebPush();
        // Told to the server so the row does not linger and get sent to for ever.
        if (endpoint) await unregister.mutateAsync({ endpoint }).catch(() => undefined);
        setState("off");
        void statusQuery.refetch();
        setNote("Notifications are off on this device.");
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const subtitle = unsupported
    ? "Not available here. In the Android app, notifications are controlled by Android itself."
    : denied
      ? "Blocked in your browser settings for this site. Allow notifications there, then try again."
      : on
        ? "On for this device. You will be told about new messages even when Varnox is closed."
        : "Turn on to be told about new messages even when Varnox is closed.";

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.row}>
        <View style={styles.iconWrap}>
          <MaterialIcons name={on ? "notifications-active" : "notifications-off"} size={20} color={on ? colors.primary : colors.muted} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.title, { color: colors.foreground }]}>Notifications on this device</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>{subtitle}</Text>
          {note ? <Text style={[styles.note, { color: on ? colors.success : colors.muted }]}>{note}</Text> : null}
        </View>
        {busy ? (
          <ActivityIndicator color={colors.primary} />
        ) : (
          <Switch
            value={on}
            disabled={unsupported || denied}
            onValueChange={(next) => void toggle(next)}
            trackColor={{ false: colors.border, true: "#A7E8CD" }}
            thumbColor={on ? colors.success : "#fff"}
          />
        )}
      </View>
      {denied ? (
        <Pressable onPress={() => void toggle(true)} style={styles.retry}>
          <Text style={[styles.retryText, { color: colors.primary }]}>Try again</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 14 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  iconWrap: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0, 168, 132, 0.14)" },
  copy: { flex: 1 },
  title: { fontSize: 14.5, fontWeight: "800" },
  subtitle: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  note: { fontSize: 11.5, lineHeight: 16, marginTop: 5, fontWeight: "700" },
  retry: { marginTop: 8, alignSelf: "flex-start" },
  retryText: { fontSize: 12.5, fontWeight: "700" },
});
