import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * Redeems a group invite link and drops the person into their chats.
 *
 * The redeem fires exactly once per mount. That guard is not cosmetic: on a single-use link a second
 * attempt after the first succeeded would spend the only remaining use on somebody who is already a
 * member.
 */
export default function JoinGroupScreen() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const code = typeof params.code === "string" ? params.code : "";
  const utils = trpc.useUtils();
  const redeem = trpc.conversations.redeemInvite.useMutation();
  const attempted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [joined, setJoined] = useState(false);

  useEffect(() => {
    if (attempted.current || !code) return;
    attempted.current = true;
    redeem
      .mutateAsync({ code })
      .then(() => {
        setJoined(true);
        void utils.conversations.list.invalidate();
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error && failure.message ? failure.message : "That invite link did not work");
      });
    // Deliberately keyed on the code only: re-running when the mutation object changes would
    // re-redeem the link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const needsSignIn = Boolean(error && /login|unauthor|sign in/i.test(error));

  return (
    <ScreenContainer>
      <View style={styles.body}>
        <View style={[styles.iconWrap, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <MaterialIcons name={joined ? "check" : error ? "link-off" : "group-add"} size={30} color={joined ? colors.primary : error ? colors.error ?? "#DC2626" : colors.primary} />
        </View>

        {!code ? <Text style={[styles.title, { color: colors.foreground }]}>That invite link is incomplete</Text> : null}

        {code && !joined && !error ? (
          <>
            <Text style={[styles.title, { color: colors.foreground }]}>Joining the group…</Text>
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          </>
        ) : null}

        {joined ? (
          <>
            <Text style={[styles.title, { color: colors.foreground }]}>You joined the group</Text>
            <Text style={[styles.copy, { color: colors.muted }]}>It is in your chat list, and its history is available from now on.</Text>
          </>
        ) : null}

        {error ? (
          <>
            <Text style={[styles.title, { color: colors.foreground }]}>This link could not be used</Text>
            <Text style={[styles.copy, { color: colors.muted }]}>{error}</Text>
          </>
        ) : null}

        {error || joined ? (
          <Pressable
            onPress={() => router.replace(needsSignIn ? "/login" : "/(tabs)")}
            style={[styles.button, { backgroundColor: colors.primary }]}
          >
            <Text style={styles.buttonText}>{needsSignIn ? "Sign in first" : "Open chats"}</Text>
          </Pressable>
        ) : null}
      </View>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 10 },
  iconWrap: { width: 66, height: 66, borderRadius: 33, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 6 },
  title: { fontSize: 17, fontWeight: "800", textAlign: "center" },
  copy: { fontSize: 13.5, textAlign: "center", lineHeight: 19 },
  spinner: { marginTop: 6 },
  button: { borderRadius: 12, paddingHorizontal: 22, paddingVertical: 12, marginTop: 10 },
  buttonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
});
