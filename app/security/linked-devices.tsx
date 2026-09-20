import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/** Turns a stored user agent into something a person can recognise as their own device. */
function deviceName(userAgent: string | null | undefined, platform: string | null | undefined) {
  const base = platform ?? "Unknown device";
  const ua = (userAgent ?? "").toLowerCase();
  const browser = ua.includes("edg/") ? "Edge" : ua.includes("chrome") ? "Chrome" : ua.includes("safari") ? "Safari" : ua.includes("firefox") ? "Firefox" : null;
  return browser ? `${base} · ${browser}` : base;
}

function whenLabel(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value;
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 2) return "active now";
  if (minutes < 60) return `${minutes} minutes ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} hours ago`;
  return date.toLocaleDateString();
}

/**
 * Where this account is signed in.
 *
 * Sessions are tokens, so the list is not decorative: revoking one stops that token working on its very
 * next request. The device asking is marked and cannot be ended from here, because signing yourself out
 * to tidy a list is its own kind of surprise.
 */
export default function LinkedDevicesScreen() {
  const colors = useColors();
  const router = useRouter();
  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const devices = trpc.security.devices.useQuery();
  const revoke = trpc.security.revokeDevice.useMutation();
  const revokeOthers = trpc.security.revokeOtherDevices.useMutation();

  const rows = devices.data ?? [];
  const others = rows.filter((row) => !row.current).length;

  const end = async (id: string) => {
    setWorking(true);
    try {
      await revoke.mutateAsync({ sessionId: id });
      await devices.refetch();
      setStatus("That device has been signed out");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not sign that device out");
    }
    setWorking(false);
  };

  const endOthers = async () => {
    setWorking(true);
    try {
      const result = await revokeOthers.mutateAsync();
      await devices.refetch();
      setStatus(result.count === 0 ? "No other devices were signed in" : `Signed out ${result.count} other ${result.count === 1 ? "device" : "devices"}`);
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not sign the other devices out");
    }
    setWorking(false);
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Linked devices</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        <Text style={[styles.intro, { color: colors.muted }]}>
          These are the devices signed in to your account. Signing one out takes effect immediately — that device has to sign in again.
        </Text>

        {devices.isLoading ? <ActivityIndicator color={colors.primary} /> : null}

        {rows.map((row) => (
          <View key={row.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <MaterialIcons name={row.platform === "Android" ? "phone-android" : row.platform === "iOS" ? "phone-iphone" : "laptop"} size={22} color={colors.primary} />
            <View style={styles.copy}>
              <Text style={[styles.device, { color: colors.foreground }]}>
                {deviceName(row.userAgent, row.platform)}
                {row.current ? " · this device" : ""}
              </Text>
              <Text style={[styles.meta, { color: colors.muted }]}>
                Signed in {new Date(row.createdAt).toLocaleDateString()} · {whenLabel(row.lastSeenAt)}
              </Text>
            </View>
            {row.current ? (
              <MaterialIcons name="check-circle" size={20} color={colors.success} />
            ) : (
              <Pressable onPress={() => void end(row.id)} disabled={working} style={[styles.smallButton, { borderColor: colors.border }]}>
                <Text style={[styles.smallButtonText, { color: colors.error ?? "#DC2626" }]}>Sign out</Text>
              </Pressable>
            )}
          </View>
        ))}

        {rows.length === 0 && !devices.isLoading ? (
          <Text style={[styles.meta, { color: colors.muted }]}>No devices are listed yet. Signing in again will list this one.</Text>
        ) : null}

        {others > 0 ? (
          <Pressable onPress={() => void endOthers()} disabled={working} style={[styles.dangerButton, { borderColor: colors.border }]}>
            <MaterialIcons name="logout" size={18} color={colors.error ?? "#DC2626"} />
            <Text style={[styles.dangerText, { color: colors.error ?? "#DC2626" }]}>Sign out all other devices</Text>
          </Pressable>
        ) : null}

        {status ? <Text style={[styles.meta, { color: colors.muted }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  body: { padding: 16, gap: 10, paddingBottom: 40 },
  intro: { fontSize: 12.5, lineHeight: 18 },
  card: { flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderRadius: 14, padding: 14 },
  copy: { flex: 1 },
  device: { fontSize: 14, fontWeight: "700" },
  meta: { fontSize: 12, lineHeight: 17, marginTop: 3 },
  smallButton: { borderWidth: 1, borderRadius: 9, paddingHorizontal: 12, paddingVertical: 7 },
  smallButtonText: { fontSize: 12.5, fontWeight: "700" },
  dangerButton: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderRadius: 12, paddingVertical: 12, marginTop: 6 },
  dangerText: { fontSize: 13.5, fontWeight: "700" },
});
