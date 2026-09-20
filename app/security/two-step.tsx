import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/**
 * Sets, changes or removes the two-step PIN.
 *
 * Every change asks for the account password first, so somebody who found an unlocked phone cannot
 * quietly replace the PIN with one of their own - which would make the lock worse than useless.
 */
export default function TwoStepScreen() {
  const colors = useColors();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [working, setWorking] = useState(false);

  const state = trpc.security.status.useQuery();
  const setPinMutation = trpc.security.setPin.useMutation();
  const removePin = trpc.security.removePin.useMutation();

  const pinSet = Boolean(state.data?.pinSet);
  const valid = /^\d{4,8}$/.test(pin) && pin === confirmPin && password.length > 0;

  const save = async () => {
    if (!valid) {
      setStatus(pin !== confirmPin ? "The two PINs do not match" : "Use 4 to 8 digits, and enter your password");
      return;
    }
    setWorking(true);
    try {
      await setPinMutation.mutateAsync({ password, pin });
      await state.refetch();
      setPin("");
      setConfirmPin("");
      setPassword("");
      setStatus(pinSet ? "Your PIN has been changed" : "Two-step PIN is on");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not save the PIN");
    }
    setWorking(false);
  };

  const turnOff = async () => {
    setWorking(true);
    try {
      await removePin.mutateAsync({ password });
      await state.refetch();
      setPassword("");
      setStatus("Two-step PIN is off");
    } catch (error) {
      setStatus(error instanceof Error && error.message ? error.message : "Could not turn the PIN off");
    }
    setWorking(false);
  };

  return (
    <ScreenContainer>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Pressable onPress={() => router.back()}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Two-step PIN</Text>
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {state.isLoading ? <ActivityIndicator color={colors.primary} /> : null}

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.cardTitle, { color: colors.foreground }]}>{pinSet ? "A PIN is set" : "No PIN set"}</Text>
          <Text style={[styles.hint, { color: colors.muted }]}>
            {pinSet
              ? "Varnox asks for it before showing your chats on this device."
              : "Add a 4 to 8 digit PIN and Varnox will ask for it before showing your chats."}
          </Text>
        </View>

        <Text style={[styles.label, { color: colors.muted }]}>ACCOUNT PASSWORD</Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Your password"
          placeholderTextColor={colors.muted}
          secureTextEntry
          style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
        />

        <Text style={[styles.label, { color: colors.muted }]}>{pinSet ? "NEW PIN" : "PIN"}</Text>
        <TextInput
          value={pin}
          onChangeText={setPin}
          placeholder="4 to 8 digits"
          placeholderTextColor={colors.muted}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={8}
          style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
        />

        <Text style={[styles.label, { color: colors.muted }]}>CONFIRM PIN</Text>
        <TextInput
          value={confirmPin}
          onChangeText={setConfirmPin}
          placeholder="Same digits again"
          placeholderTextColor={colors.muted}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={8}
          style={[styles.input, { color: colors.foreground, borderColor: colors.border }]}
        />

        <Pressable onPress={() => void save()} disabled={working} style={[styles.primaryButton, { backgroundColor: colors.primary }]}>
          <Text style={styles.primaryText}>{pinSet ? "Change PIN" : "Turn on PIN"}</Text>
        </Pressable>

        {pinSet ? (
          <Pressable onPress={() => void turnOff()} disabled={working || password.length === 0} style={[styles.ghostButton, { borderColor: colors.border, opacity: password.length === 0 ? 0.5 : 1 }]}>
            <Text style={[styles.ghostText, { color: colors.error ?? "#DC2626" }]}>Turn off PIN</Text>
          </Pressable>
        ) : null}

        <Text style={[styles.hint, { color: colors.muted }]}>
          The PIN locks the app on this device. It is not a replacement for your password, and it does not sign other devices out.
        </Text>
        {status ? <Text style={[styles.hint, { color: colors.muted }]}>{status}</Text> : null}
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
  hint: { fontSize: 12.5, lineHeight: 18, marginTop: 4 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 0.6, marginTop: 10 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 11, fontSize: 14, marginTop: 6 },
  primaryButton: { borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 18 },
  primaryText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  ghostButton: { borderWidth: 1, borderRadius: 12, paddingVertical: 12, alignItems: "center", marginTop: 10 },
  ghostText: { fontSize: 13.5, fontWeight: "700" },
});
