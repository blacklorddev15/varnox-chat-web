import { useEffect, useState } from "react";
import { useRouter } from "expo-router";
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useAuth } from "@/hooks/use-auth";
import { useColors } from "@/hooks/use-colors";
import { getApiBaseUrl } from "@/constants/oauth";
import { trpc } from "@/lib/trpc";

/**
 * Adding a second device, either end of it.
 *
 * One screen for both sides because they are one flow seen from two devices: an already signed-in
 * device shows a code, and a new device spends it. Which half is shown is decided by whether there
 * is a session, not by a route parameter, so opening this on a fresh device does the right thing.
 */
export default function LinkDeviceScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user, isAuthenticated, refresh } = useAuth();

  const createCode = trpc.deviceLink.create.useMutation();

  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [entered, setEntered] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /** The link the QR encodes. Opening it on the other device lands on this same screen. */
  const link = code ? `${getApiBaseUrl?.() ?? ""}/security/link-device?code=${code}` : null;

  /**
   * Draws the code as a QR.
   *
   * `qrcode` is already a dependency of this project, so nothing new is installed. It is imported
   * lazily and any failure is swallowed: the code and the link below are the actual mechanism, and
   * the QR is only a convenience for moving them to another device. A rendering problem must not
   * take the feature with it.
   */
  useEffect(() => {
    let cancelled = false;
    if (!link) {
      setQrDataUrl(null);
      return;
    }
    void (async () => {
      try {
        const module = await import("qrcode");
        const dataUrl = await module.default.toDataURL(link, { width: 320, margin: 1 });
        if (!cancelled) setQrDataUrl(dataUrl);
      } catch {
        if (!cancelled) setQrDataUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [link]);

  const issue = async () => {
    setError(null);
    try {
      const result = await createCode.mutateAsync();
      setCode(result.code);
      setExpiresAt(new Date(result.expiresAt));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create a code");
    }
  };

  const claim = async () => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/auth/device-link/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ code: entered.trim() }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "That code was not accepted");
      // The cookie is set by the response; refreshing picks up the new session.
      await refresh?.();
      setDone(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not link this device");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
        </Pressable>
        <Text style={[styles.title, { color: colors.foreground }]}>Link a device</Text>
      </View>

      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {isAuthenticated ? (
            <>
              <Text style={[styles.copy, { color: colors.muted }]}>
                Show this code on the device that is already signed in as{" "}
                <Text style={{ color: colors.foreground }}>{(user as { username?: string } | null)?.username ?? "you"}</Text>, then
                enter it on the new one. It works once and expires in five minutes.
              </Text>

              <Pressable onPress={() => void issue()} style={[styles.primary, { backgroundColor: colors.primary }]}>
                <Text style={styles.primaryText}>{code ? "Get a new code" : "Create a linking code"}</Text>
              </Pressable>

              {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

              {code ? (
                <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  {qrDataUrl ? <Image source={{ uri: qrDataUrl }} style={styles.qr} resizeMode="contain" /> : null}
                  {/* The code is the mechanism and the QR is only a way to move it, so it is shown
                      at full size whether or not a QR could be drawn. */}
                  <Text style={[styles.code, { color: colors.foreground }]} selectable>
                    {code}
                  </Text>
                  {link ? (
                    <Text style={[styles.link, { color: colors.muted }]} selectable numberOfLines={2}>
                      {link}
                    </Text>
                  ) : null}
                  {expiresAt ? (
                    <Text style={[styles.hint, { color: colors.muted }]}>
                      Expires at {expiresAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                    </Text>
                  ) : null}
                </View>
              ) : null}

              <Text style={[styles.note, { color: colors.muted }]}>
                Anyone holding this code can add a device to your account, so do not show it to somebody you do not trust.
                You can end any device from Linked devices.
              </Text>
            </>
          ) : done ? (
            <View style={styles.centered}>
              <MaterialIcons name="check-circle" size={40} color={colors.success} />
              <Text style={[styles.title, { color: colors.foreground, textAlign: "center", marginTop: 10 }]}>This device is linked</Text>
              <Text style={[styles.copy, { color: colors.muted, textAlign: "center" }]}>You are signed in. Continue to your chats.</Text>
              <Pressable onPress={() => router.replace("/")} style={[styles.primary, { backgroundColor: colors.primary, marginTop: 12 }]}>
                <Text style={styles.primaryText}>Go to chats</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <Text style={[styles.copy, { color: colors.muted }]}>
                Enter the code shown on a device that is already signed in.
              </Text>
              <TextInput
                value={entered}
                onChangeText={(value) => setEntered(value.toUpperCase())}
                placeholder="ABCD2345"
                placeholderTextColor={colors.muted}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={16}
                style={[styles.codeInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]}
              />
              {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
              <Pressable
                disabled={!entered.trim() || busy}
                onPress={() => void claim()}
                style={[styles.primary, { backgroundColor: colors.primary, opacity: !entered.trim() || busy ? 0.5 : 1 }]}
              >
                {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryText}>Link this device</Text>}
              </Pressable>
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 },
  title: { flex: 1, fontSize: 21, fontWeight: "800" },
  content: { paddingHorizontal: 20, paddingBottom: 40, gap: 12 },
  copy: { fontSize: 13.5, lineHeight: 20 },
  primary: { borderRadius: 13, paddingVertical: 14, alignItems: "center" },
  primaryText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  card: { borderWidth: 1, borderRadius: 18, padding: 18, alignItems: "center", gap: 10 },
  qr: { width: 220, height: 220 },
  code: { fontSize: 30, fontWeight: "800", letterSpacing: 6 },
  link: { fontSize: 11.5, textAlign: "center" },
  hint: { fontSize: 11.5 },
  note: { fontSize: 11.5, lineHeight: 17 },
  error: { fontSize: 12.5, fontWeight: "700" },
  centered: { alignItems: "center", paddingTop: 40 },
  codeInput: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, fontSize: 22, letterSpacing: 5, textAlign: "center" },
});
