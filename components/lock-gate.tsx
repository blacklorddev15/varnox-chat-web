import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";

/** How long the app can be left before it asks for the PIN again. */
const RELOCK_AFTER_MS = 60_000;

/**
 * The two-step PIN gate.
 *
 * Sits above every screen, so the chats behind it are not merely covered by a dialog that a navigation
 * could dismiss. It asks again after the app has been in the background for a minute: a lock that only
 * appears on a cold start is not much of a lock on a phone that is never switched off.
 *
 * The PIN guards this device's view of the app. It is not a second authentication factor for the session,
 * and the screen that sets it says so.
 */
export function LockGate() {
  const colors = useColors();
  const [unlocked, setUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const hiddenAt = useRef<number | null>(null);

  const status = trpc.security.status.useQuery();
  const verify = trpc.security.verifyPin.useMutation();

  const pinSet = Boolean(status.data?.pinSet);

  // Re-lock when the app comes back after a while. Web and the Android WebView both report visibility,
  // so this works in the installed app as well as in a browser tab.
  useEffect(() => {
    if (!pinSet) return;
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      // Only an unlock that already happened is undone; a first visit is handled by the query below.
      if (hiddenAt.current && Date.now() - hiddenAt.current > RELOCK_AFTER_MS) {
        setUnlocked(false);
        setPin("");
        setMessage(null);
      }
      hiddenAt.current = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [pinSet]);

  const submit = async () => {
    if (pin.trim().length === 0) return;
    try {
      const result = await verify.mutateAsync({ pin: pin.trim() });
      if (result.ok) {
        setUnlocked(true);
        setPin("");
        setMessage(null);
        return;
      }
      setPin("");
      if (result.lockedForMs && result.lockedForMs > 0) {
        setMessage(`Too many attempts. Try again in ${Math.ceil(result.lockedForMs / 60000)} minute(s).`);
      } else {
        setMessage(`${result.attemptsLeft ?? 0} attempt(s) left before a pause.`);
      }
    } catch (error) {
      setPin("");
      setMessage(error instanceof Error && error.message ? error.message : "Could not check that PIN");
    }
  };

  if (status.isLoading || !pinSet || unlocked) return null;

  return (
    <View style={[styles.overlay, { backgroundColor: colors.background }]}>
      <View style={[styles.iconWrap, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <MaterialIcons name="lock" size={28} color={colors.primary} />
      </View>
      <Text style={[styles.title, { color: colors.foreground }]}>Varnox is locked</Text>
      <Text style={[styles.copy, { color: colors.muted }]}>Enter your two-step PIN to continue.</Text>
      <TextInput
        value={pin}
        onChangeText={setPin}
        placeholder="PIN"
        placeholderTextColor={colors.muted}
        keyboardType="number-pad"
        secureTextEntry
        autoFocus
        maxLength={8}
        onSubmitEditing={() => void submit()}
        style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]}
      />
      <Pressable onPress={() => void submit()} disabled={verify.isPending || pin.length === 0} style={[styles.button, { backgroundColor: colors.primary, opacity: pin.length === 0 ? 0.5 : 1 }]}>
        {verify.isPending ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.buttonText}>Unlock</Text>}
      </Pressable>
      {message ? <Text style={[styles.copy, { color: colors.muted }]}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center", paddingHorizontal: 32, gap: 8 },
  iconWrap: { width: 64, height: 64, borderRadius: 32, borderWidth: 1, alignItems: "center", justifyContent: "center", marginBottom: 8 },
  title: { fontSize: 18, fontWeight: "800" },
  copy: { fontSize: 13, textAlign: "center", lineHeight: 19 },
  input: { width: "100%", maxWidth: 260, borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 18, textAlign: "center", letterSpacing: 6, marginTop: 12 },
  button: { width: "100%", maxWidth: 260, borderRadius: 12, paddingVertical: 13, alignItems: "center", marginTop: 4 },
  buttonText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
});
