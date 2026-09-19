import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { useCall } from "@/lib/call-context";

/**
 * Target of a shared call link: /call/<room>. It mints a token for the signed-in user and hands
 * the room to the call overlay, then returns to the app so the call is not tied to this screen.
 */
export default function JoinCallScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ room?: string }>();
  const room = String(params.room ?? "");
  const { joinLink } = useCall();
  const join = trpc.calls.joinLink.useMutation();
  const [status, setStatus] = useState("Joining the call…");
  const [failed, setFailed] = useState(false);
  const attempted = useRef(false);

  const joinMutation = join.mutateAsync;
  const joinContext = joinLink;

  useEffect(() => {
    if (attempted.current || !room) return;
    attempted.current = true;
    void (async () => {
      try {
        const joined = await joinMutation({ room });
        await joinContext({ room: joined.room, token: joined.token, url: joined.url, peerName: "Call link", kind: joined.kind });
        router.replace("/(tabs)");
      } catch (error) {
        setFailed(true);
        setStatus(error instanceof Error ? error.message : "Could not join that call.");
      }
    })();
  }, [room, joinMutation, joinContext, router]);

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.wrap}>
        <View style={[styles.icon, { backgroundColor: failed ? "rgba(239,68,68,0.14)" : "rgba(16,185,129,0.14)" }]}>
          <MaterialIcons name={failed ? "link-off" : "call"} size={30} color={failed ? colors.error : colors.success} />
        </View>
        <Text style={[styles.title, { color: colors.foreground }]}>{failed ? "Could not join" : "Joining call"}</Text>
        <Text style={[styles.status, { color: colors.muted }]}>{status}</Text>
        {!failed ? <ActivityIndicator color={colors.primary} style={styles.spinner} /> : null}
        <Pressable onPress={() => router.replace("/(tabs)")} style={({ pressed }) => [styles.button, { borderColor: colors.border }, pressed && styles.pressed]}>
          <Text style={[styles.buttonText, { color: colors.foreground }]}>{failed ? "Back to the app" : "Cancel"}</Text>
        </Pressable>
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 28 },
  icon: { width: 72, height: 72, borderRadius: 36, alignItems: "center", justifyContent: "center" },
  title: { fontSize: 19, fontWeight: "800", marginTop: 16 },
  status: { fontSize: 13, lineHeight: 19, marginTop: 8, textAlign: "center" },
  spinner: { marginTop: 18 },
  button: { marginTop: 24, borderWidth: 1, borderRadius: 14, paddingHorizontal: 20, paddingVertical: 12 },
  buttonText: { fontSize: 13, fontWeight: "800" },
  pressed: { opacity: 0.7 },
});
