import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";

/**
 * Moves the account to a different number.
 *
 * Confirmed in two steps on purpose: the password proves it is the account holder, and a code emailed to
 * the address on the account is bound to the number being claimed, so a code that leaks cannot be used
 * to point the account somewhere else.
 */
export default function ChangeNumberScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const [step, setStep] = useState<"number" | "code">("number");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const start = trpc.account.startNumberChange.useMutation();
  const confirm = trpc.account.confirmNumberChange.useMutation();
  const utils = trpc.useUtils();

  const request = async () => {
    setStatus(null);
    try {
      const result = await start.mutateAsync({ password, phone });
      setStep("code");
      setNotice(
        result.delivered
          ? `We sent a code to ${result.emailHint}.`
          : `Email delivery is not configured on this server, so here is the code: ${result.devCode ?? "(see server log)"}`,
      );
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not start the change");
    }
  };

  const apply = async () => {
    setStatus(null);
    try {
      const result = await confirm.mutateAsync({ code, phone });
      await utils.auth.me.invalidate();
      setNotice(`Your number is now ${result.phone}.`);
      setStep("number");
      setPassword("");
      setPhone("");
      setCode("");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not confirm that code");
    }
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Change number</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>Current number</Text>
          <Text style={[styles.hint, { color: colors.muted }]}>{user?.phone ? user.phone : "No number on this account yet"}</Text>
        </View>

        {step === "number" ? (
          <>
            <Text style={[styles.label, { color: colors.muted }]}>NEW NUMBER</Text>
            <TextInput
              value={phone}
              onChangeText={setPhone}
              placeholder="+65 9123 4567"
              placeholderTextColor={colors.muted}
              keyboardType="phone-pad"
              style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
            />
            <Text style={[styles.label, { color: colors.muted }]}>ACCOUNT PASSWORD</Text>
            <TextInput
              value={password}
              onChangeText={setPassword}
              placeholder="Your password"
              placeholderTextColor={colors.muted}
              secureTextEntry
              style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
            />
            <Pressable
              onPress={() => void request()}
              disabled={start.isPending || password.length === 0 || phone.trim().length < 7}
              style={[styles.primaryButton, { backgroundColor: colors.primary, opacity: password.length === 0 || phone.trim().length < 7 ? 0.5 : 1 }]}
            >
              <Text style={styles.primaryText}>Send code</Text>
            </Pressable>
            <Text style={[styles.hint, { color: colors.muted }]}>
              The code goes to the email address on your account. Your sign-in name does not change, so you keep signing in the same way.
            </Text>
          </>
        ) : (
          <>
            <Text style={[styles.label, { color: colors.muted }]}>CODE</Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="6 digits"
              placeholderTextColor={colors.muted}
              keyboardType="number-pad"
              maxLength={8}
              style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
            />
            <Pressable onPress={() => void apply()} disabled={confirm.isPending || code.trim().length < 4} style={[styles.primaryButton, { backgroundColor: colors.primary, opacity: code.trim().length < 4 ? 0.5 : 1 }]}>
              <Text style={styles.primaryText}>Confirm new number</Text>
            </Pressable>
            <Pressable onPress={() => { setStep("number"); setNotice(null); }} style={[styles.ghostButton, { borderColor: colors.border }]}>
              <Text style={[styles.ghostText, { color: colors.primary }]}>Use a different number</Text>
            </Pressable>
          </>
        )}

        {notice ? <Text style={[styles.hint, { color: colors.muted }]}>{notice}</Text> : null}
        {status ? <Text style={[styles.hint, { color: colors.error ?? "#DC2626" }]}>{status}</Text> : null}
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", alignItems: "center", gap: 16, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  title: { flex: 1, fontSize: 20, fontWeight: "800" },
  body: { padding: 16, gap: 6, paddingBottom: 40 },
  card: { borderWidth: 1, borderRadius: 14, padding: 14, marginBottom: 10 },
  cardTitle: { fontSize: 14.5, fontWeight: "700" },
  hint: { fontSize: 12.5, lineHeight: 18, marginTop: 6 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginTop: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, marginTop: 6 },
  primaryButton: { borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 18 },
  primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  ghostButton: { borderWidth: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 10 },
  ghostText: { fontSize: 13.5, fontWeight: "700" },
});
