import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * Deletes the account.
 *
 * The confirmation is a typed word plus the account password, and the screen spells out what survives:
 * groups carry on under somebody else, and messages already delivered stay in other people's chats under
 * a name that no longer resolves. Saying that here is the difference between a deletion and a surprise.
 */
export default function DeleteAccountScreen() {
  const colors = useColors();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const remove = trpc.account.deleteAccount.useMutation();

  const ready = confirm.trim() === "DELETE" && password.length > 0;

  const submit = async () => {
    setStatus(null);
    try {
      await remove.mutateAsync({ password, confirm });
      // The cookie is cleared server-side; sending the browser to the login screen finishes the job.
      if (typeof window !== "undefined") window.location.href = "/login";
      else router.replace("/login");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not delete the account");
    }
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Delete account</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={[styles.warning, { backgroundColor: colors.surface, borderColor: colors.error ?? "#DC2626" }]}>
          <MaterialIcons name="warning-amber" size={20} color={colors.error ?? "#DC2626"} />
          <Text style={[styles.warningText, { color: colors.foreground }]}>
            This cannot be undone. Your account, profile photo, stickers, broadcast lists and every device you are signed in on are erased.
          </Text>
        </View>

        <Text style={[styles.hint, { color: colors.muted }]}>
          Groups you own pass to another admin, so the people in them are not left with a group nobody can run. Messages you already sent
          stay in other people&apos;s chats, but your name and photo go with the account.
        </Text>

        <Text style={[styles.label, { color: colors.muted }]}>ACCOUNT PASSWORD</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          placeholderTextColor={colors.muted}
          secureTextEntry
          style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
        />

        <Text style={[styles.label, { color: colors.muted }]}>TYPE DELETE TO CONFIRM</Text>
        <TextInput
          value={confirm}
          onChangeText={setConfirm}
          placeholder="DELETE"
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
          style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
        />

        <Pressable
          onPress={() => void submit()}
          disabled={!ready || remove.isPending}
          style={[styles.dangerButton, { backgroundColor: ready ? colors.error ?? "#DC2626" : colors.border }]}
        >
          <Text style={styles.dangerText}>{remove.isPending ? "Deleting…" : "Delete my account"}</Text>
        </Pressable>

        {status ? <Text style={[styles.hint, { color: colors.error ?? "#DC2626" }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  body: { padding: 16, gap: 6, paddingBottom: 40 },
  warning: { flexDirection: "row", gap: 10, borderWidth: 1, borderRadius: 14, padding: 14 },
  warningText: { flex: 1, fontSize: 13, lineHeight: 19, fontWeight: "600" },
  hint: { fontSize: 12.5, lineHeight: 18, marginTop: 8 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginTop: 12 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, marginTop: 6 },
  dangerButton: { borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 20 },
  dangerText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
});
