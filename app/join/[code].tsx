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
  // "Joined" and "asked to join" are different outcomes, and must not be reported as each other.
  const [outcome, setOutcome] = useState<"joined" | "pending" | null>(null);

  useEffect(() => {
    if (attempted.current || !code) return;
    attempted.current = true;
    redeem
      .mutateAsync({ code })
      .then((result) => {
        setOutcome(result.pending ? "pending" : "joined");
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
          <MaterialIcons name={outcome ? (outcome === "joined" ? "check" : "hourglass-empty") : error ? "link-off" : "group-add"} size={30} color={error ? colors.error ?? "#DC2626" : colors.primary} />
        </View>

        {!code ? <Text style={[styles.title, { color: colors.foreground }]}>That invite link is incomplete</Text> : null}

        {code && !outcome && !error ? (
          <>
            <Text style={[styles.title, { color: colors.foreground }]}>Joining the group…</Text>
            <ActivityIndicator color={colors.primary} style={styles.spinner} />
          </>
        ) : null}

        {outcome === "joined" ? (
          <>
            <Text style={[styles.title, { color: colors.foreground }]}>You joined the group</Text>
            <Text style={[styles.copy, { color: colors.muted }]}>It is in your chat list, and its history is available from now on.</Text>
          </>
        ) : null}

        {outcome === "pending" ? (
          <>
            <Text style={[styles.title, { color: colors.foreground }]}>Your request was sent</Text>
            <Text style={[styles.copy, { color: colors.muted }]}>This group reviews new members, so an admin has to approve you before you can read or post in it.</Text>
          </>
        ) : null}

        {error ? (
          <>
            <Text style={[styles.title, { color: colors.foreground }]}>This link could not be used</Text>
            <Text style={[styles.copy, { color: colors.muted }]}>
              {needsSignIn ? "Sign in and this invite will be waiting for you." : error}
            </Text>
          </>
        ) : null}

        {error || outcome ? (
          <Pressable
            onPress={() => router.replace(needsSignIn ? (`/login?next=${encodeURIComponent(`/join/${code}`)}` as never) : "/(tabs)")}
            style={[styles.button, { backgroundColor: colors.primary }]}
          >
            <Text style={styles.buttonText}>{needsSignIn ? "Sign in to join" : "Open chats"}</Text>
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
