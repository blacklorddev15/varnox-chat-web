import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useColors } from "@/hooks/use-colors";
import * as Auth from "@/lib/_core/auth";
import { trpc } from "@/lib/trpc";

/** Turns the deadline the server promised into something readable, or null when it is unusable. */
function readableWhen(value: unknown): string | null {
  if (!value) return null;
  const when = new Date(value as string);
  if (Number.isNaN(when.getTime())) return null;
  return when.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * What a banned or suspended account is shown, laid out like WhatsApp's own ban screen, plus the outcome
 * of asking for a review.
 *
 * Four views: the notice, the review form behind its one action, a waiting state carrying the deadline
 * the person was promised, and a restored state. The restored view appears only when the server reports
 * the review approved - nothing here restores an account on a timer, and the waiting copy says as much
 * rather than implying the account is back once the clock runs out.
 *
 * The app bar is green rather than the dark surface the rest of this app uses in its pinned dark theme,
 * because matching WhatsApp's screen is the point of this file.
 *
 * Kept from the earlier version rather than copied from WhatsApp: no invented date (the old screen
 * announced a withdrawal date that was a string literal, identical for every account), and the details
 * box starts empty instead of pre-filled with the server's error string.
 */
export default function AccountStatusScreen() {
  const router = useRouter();
  const colors = useColors();
  const params = useLocalSearchParams<{ status?: string; reason?: string; username?: string }>();
  const { status = "banned", reason = "Community safety review", username = "" } = params;

  const suspended = status === "suspended";
  const [step, setStep] = useState<"notice" | "review" | "waiting">("notice");
  const [details, setDetails] = useState("");
  const [usernameInput, setUsernameInput] = useState(String(username));

  // Whose case this is. Someone arriving from a failed sign-in has it in the URL; someone who typed it
  // on the form has it in state.
  const who = String(username || usernameInput).trim().toLowerCase();
  const identified = who.length >= 3;

  const appeal = trpc.appeals.submit.useMutation();
  const statusQuery = trpc.appeals.status.useQuery({ username: who }, { enabled: identified, refetchInterval: 30_000 });

  const state = statusQuery.data?.state ?? "none";
  const due = readableWhen(appeal.data?.reviewDueAt ?? statusQuery.data?.reviewDueAt);
  const restored = state === "approved";
  // Someone returning to this screen with a request already in flight belongs on the waiting view, not
  // back at the notice offering them a second one.
  const waiting = state === "pending" || step === "waiting";

  const signOut = async () => {
    await Auth.removeSessionToken();
    await Auth.clearUserInfo();
    router.replace("/login");
  };

  const appBar = (title: string, showBack: boolean) => (
    <View style={[styles.appBar, { backgroundColor: colors.primary }]}>
      {showBack ? (
        <Pressable onPress={() => setStep("notice")} hitSlop={10} style={styles.backButton}>
          <MaterialIcons name="arrow-back" size={22} color="#FFFFFF" />
        </Pressable>
      ) : (
        <View style={styles.mark}>
          <Text style={[styles.markText, { color: colors.primary }]}>V</Text>
        </View>
      )}
      <Text style={styles.appBarTitle}>{title}</Text>
    </View>
  );

  const supportLine = (
    <Pressable onPress={() => router.push("/chat/support")} hitSlop={6}>
      <Text style={[styles.support, { color: colors.muted }]}>
        Need help? <Text style={{ color: colors.primary }}>Contact Varnox Support</Text>
      </Text>
    </Pressable>
  );

  // ------------------------------------------------------------- restored: only after a real approval
  if (restored) {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={[styles.page, { backgroundColor: colors.background }]}>
        {appBar("Varnox Chat", false)}
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.column}>
            <View style={[styles.avatar, styles.restoredMark, { backgroundColor: colors.primary }]}>
              <MaterialIcons name="check" size={56} color="#FFFFFF" />
            </View>

            <Text style={[styles.title, { color: colors.foreground }]}>This account has been restored</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>Please log in to verify your account.</Text>

            <Pressable
              onPress={() => router.replace("/login")}
              style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}
            >
              <Text style={styles.primaryText}>Log in</Text>
            </Pressable>

            {supportLine}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ------------------------------------------------------------- waiting: the promised window
  if (waiting && step !== "review") {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={[styles.page, { backgroundColor: colors.background }]}>
        {appBar("Varnox Chat", false)}
        <ScrollView contentContainerStyle={styles.scroll}>
          <View style={styles.column}>
            <View style={styles.avatarWrap}>
              <View style={[styles.avatar, { backgroundColor: colors.border }]}>
                <MaterialIcons name="person" size={54} color={colors.muted} />
              </View>
              <View style={[styles.banBadge, { borderColor: colors.background, backgroundColor: colors.error }]}>
                <View style={styles.banSlash} />
              </View>
            </View>

            <Text style={[styles.title, { color: colors.foreground }]}>Review requested</Text>
            <Text style={[styles.subtitle, { color: colors.muted }]}>
              {due ? `Varnox Support will complete the review by ${due}.` : "Varnox Support is reviewing your account."}{" "}
              You can't use Varnox Chat until then.
            </Text>

            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <MaterialIcons name="hourglass-empty" size={26} color={colors.primary} style={styles.cardIcon} />
              <View style={styles.cardCopy}>
                <Text style={[styles.cardTitle, { color: colors.foreground }]}>What happens next?</Text>
                <Text style={[styles.cardBody, { color: colors.muted }]}>
                  If the review goes your way, the account is restored and this screen tells you to log in and verify it.
                  Nothing is restored on a timer: it happens when the review is actually decided.
                </Text>
                <Pressable onPress={() => router.push("/chat/support")} hitSlop={6}>
                  <Text style={[styles.cardLink, { color: colors.primary }]}>Learn more</Text>
                </Pressable>
              </View>
            </View>

            {supportLine}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ------------------------------------------------------------- the review form
  if (step === "review") {
    return (
      <SafeAreaView edges={["top", "left", "right"]} style={[styles.page, { backgroundColor: colors.background }]}>
        {appBar("Review", true)}
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.column}>
            <Text style={[styles.reviewLead, { color: colors.foreground }]}>
              Varnox Support will review your account and device info to check for activity that goes against our{" "}
              <Text style={{ color: colors.primary }} onPress={() => router.push("/chat/support")}>
                terms of service
              </Text>
            </Text>

            <Text style={[styles.reviewNote, { color: colors.muted }]}>
              Nothing has been deleted: your chats, your messages and your profile are all still here.
              {suspended ? " Access returns on its own when the suspension ends." : " Access may be restored after review."}
            </Text>

            {!username ? (
              <TextInput
                value={usernameInput}
                onChangeText={setUsernameInput}
                placeholder="Your username"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.foreground }]}
              />
            ) : null}

            <TextInput
              value={details}
              onChangeText={setDetails}
              placeholder="Add any details you want included in your review (optional)"
              placeholderTextColor={colors.muted}
              multiline
              style={[styles.input, styles.detailsInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.foreground }]}
            />

            <Pressable
              disabled={appeal.isPending || !identified}
              onPress={() => appeal.mutate({ username: who, reason: details.trim() }, { onSuccess: () => setStep("waiting") })}
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: colors.primary },
                pressed && styles.pressed,
                (appeal.isPending || !identified) && styles.disabled,
              ]}
            >
              <Text style={styles.primaryText}>{appeal.isPending ? "Sending…" : "Submit"}</Text>
            </Pressable>

            {appeal.error ? <Text style={[styles.error, { color: colors.error }]}>{appeal.error.message}</Text> : null}

            <View style={styles.footer}>
              <Pressable onPress={signOut} hitSlop={6}>
                <Text style={[styles.footerLink, { color: colors.primary }]}>Sign out</Text>
              </Pressable>
              <Text style={[styles.footerDot, { color: colors.muted }]}>·</Text>
              <Pressable onPress={() => router.replace("/login")} hitSlop={6}>
                <Text style={[styles.footerLink, { color: colors.primary }]}>Register a new account</Text>
              </Pressable>
            </View>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ------------------------------------------------------------- the notice
  return (
    <SafeAreaView edges={["top", "left", "right"]} style={[styles.page, { backgroundColor: colors.background }]}>
      {appBar("Varnox Chat", false)}
      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.column}>
          <View style={styles.avatarWrap}>
            <View style={[styles.avatar, { backgroundColor: colors.border }]}>
              <MaterialIcons name="person" size={54} color={colors.muted} />
            </View>
            <View style={[styles.banBadge, { borderColor: colors.background, backgroundColor: colors.error }]}>
              <View style={styles.banSlash} />
            </View>
          </View>

          <Text style={[styles.title, { color: colors.foreground }]}>
            {suspended ? "This account is temporarily suspended" : "This account is banned"}
          </Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            {suspended
              ? "Your account has been suspended from using Varnox Chat. You cannot send or receive messages while the suspension is in place."
              : "Your account has been banned from using Varnox Chat. Contact support for help."}
          </Text>

          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <MaterialIcons name="gpp-maybe" size={26} color={colors.error} style={styles.cardIcon} />
            <View style={styles.cardCopy}>
              <Text style={[styles.cardTitle, { color: colors.foreground }]}>Why is this happening?</Text>
              {/* The reason this account was actioned, straight from the server. */}
              <Text style={[styles.cardBody, { color: colors.muted }]}>{String(reason)}</Text>
              {/* The rule behind it, in the shape WhatsApp words its own screen, because a bare error
                  string explains nothing to somebody who does not already know the rules. */}
              <Text style={[styles.cardBody, styles.cardRule, { color: colors.muted }]}>
                We don't allow activity that goes against the Varnox Terms of Service or Community Guidelines. This
                includes using Varnox Chat for spam, scams, or other unauthorised activity.
              </Text>
              {state === "rejected" ? (
                <Text style={[styles.cardBody, styles.cardRule, { color: colors.error }]}>
                  Your review was considered and the account was not restored.
                </Text>
              ) : null}
              <Pressable onPress={() => router.push("/chat/support")} hitSlop={6}>
                <Text style={[styles.cardLink, { color: colors.primary }]}>Learn more</Text>
              </Pressable>
            </View>
          </View>

          <Pressable
            onPress={() => setStep("review")}
            style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}
          >
            <Text style={styles.primaryText}>Request a review</Text>
          </Pressable>

          {supportLine}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  appBar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10, minHeight: 56 },
  // Inverted against the green bar, the way WhatsApp's own mark sits on its header.
  mark: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#FFFFFF", alignItems: "center", justifyContent: "center" },
  markText: { fontSize: 21, fontWeight: "900", letterSpacing: -1, marginTop: -1 },
  appBarTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "600" },
  backButton: { marginRight: 4, padding: 2 },
  scroll: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 28, alignItems: "center" },
  column: { width: "100%", maxWidth: 430, alignItems: "stretch" },
  avatarWrap: { alignSelf: "center", marginBottom: 22 },
  avatar: { width: 104, height: 104, borderRadius: 52, alignItems: "center", justifyContent: "center" },
  restoredMark: { alignSelf: "center", marginBottom: 22 },
  banBadge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 3,
    alignItems: "center",
    justifyContent: "center",
  },
  // Drawn rather than taken from the icon font: the mark is a plain diagonal bar, and no single glyph
  // gives a white slash inside a red circle at this size.
  banSlash: { width: 17, height: 3, backgroundColor: "#FFFFFF", borderRadius: 2, transform: [{ rotate: "-45deg" }] },
  title: { fontSize: 21, fontWeight: "700", textAlign: "center", lineHeight: 28 },
  subtitle: { fontSize: 14, lineHeight: 21, textAlign: "center", marginTop: 10 },
  card: { flexDirection: "row", gap: 12, borderWidth: 1, borderRadius: 12, padding: 14, marginTop: 22 },
  cardIcon: { marginTop: 1 },
  cardCopy: { flex: 1 },
  cardTitle: { fontSize: 15, fontWeight: "700", marginBottom: 6 },
  cardBody: { fontSize: 13.5, lineHeight: 20 },
  cardRule: { marginTop: 8 },
  cardLink: { fontSize: 13.5, fontWeight: "600", marginTop: 8 },
  primaryButton: { minHeight: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", marginTop: 26 },
  primaryText: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" },
  support: { fontSize: 13, textAlign: "center", marginTop: 20 },
  reviewLead: { fontSize: 14.5, lineHeight: 22 },
  reviewNote: { fontSize: 13, lineHeight: 20, marginTop: 14 },
  input: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, marginTop: 14, minHeight: 48 },
  detailsInput: { minHeight: 140, textAlignVertical: "top" },
  error: { fontSize: 12.5, marginTop: 10, textAlign: "center" },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginTop: 22 },
  footerLink: { fontSize: 14, fontWeight: "600" },
  footerDot: { fontSize: 14 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.6 },
});
