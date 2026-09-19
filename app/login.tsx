import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import * as Api from "@/lib/_core/api";
import * as Auth from "@/lib/_core/auth";
import { trpc } from "@/lib/trpc";

type AuthMode = "password" | "phone";
type PasswordMode = "login" | "register";

export default function LoginScreen() {
  const colors = useColors(); const router = useRouter(); const { previewStatus } = useLocalSearchParams<{ previewStatus?: string }>();
  const [authMode, setAuthMode] = useState<AuthMode>("password"); const [passwordMode, setPasswordMode] = useState<PasswordMode>("login");
  const [username, setUsername] = useState(""); const [password, setPassword] = useState(""); const [confirmPassword, setConfirmPassword] = useState(""); const [accountEmail, setAccountEmail] = useState("");
  const [fullName, setFullName] = useState(""); const [accountPhone, setAccountPhone] = useState(""); const [signupCode, setSignupCode] = useState("");
  const [awaitingCode, setAwaitingCode] = useState(false); const [awaitingPhone, setAwaitingPhone] = useState(false);
  const updateProfileMutation = trpc.profile.update.useMutation();
  // Welcome landing stage first, auth form behind it. Both new and returning users land here.
  const [stage, setStage] = useState<"welcome" | "form">("welcome");
  // Keeps the ring from crowding short screens: it scales with the viewport, never past 246.
  const { width: windowWidth } = useWindowDimensions();
  const doodleSize = Math.max(150, Math.min(246, Math.round(windowWidth * 0.62)));
  const [pendingAuth, setPendingAuth] = useState<{ sessionToken: string; user: Auth.User } | null>(null);
  const [phone, setPhone] = useState(""); const [email, setEmail] = useState(""); const [code, setCode] = useState(""); const [requestId, setRequestId] = useState<string | null>(null); const [phoneMasked, setPhoneMasked] = useState(""); const [emailMasked, setEmailMasked] = useState(""); const [devCode, setDevCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [cooldown, setCooldown] = useState(0); const [error, setError] = useState<string | null>(null);
  const displayedError = error ?? (previewStatus === "banned" ? "This Varnox account is banned: Community safety review." : previewStatus === "suspended" ? "This Varnox account is suspended until 10/01/2026, 12:00 PM: Temporary safety hold." : null); const moderationError = Boolean(displayedError && /(banned|suspended)/i.test(displayedError));

  useEffect(() => { if (cooldown <= 0) return; const timer = setInterval(() => setCooldown((value) => Math.max(0, value - 1)), 1000); return () => clearInterval(timer); }, [cooldown]);

  const finishLogin = async (result: { sessionToken: string; user: Auth.User }) => { await Auth.setSessionToken(result.sessionToken); await Auth.setUserInfo({ ...result.user, lastSignedIn: new Date(result.user.lastSignedIn) }); router.replace("/(tabs)"); };
  const handleAuthError = (cause: unknown, attemptedUsername?: string) => { const message = cause instanceof Error ? cause.message : "Could not complete authentication."; if (/(banned|suspended)/i.test(message)) { router.replace({ pathname: "/account-status", params: { status: /banned/i.test(message) ? "banned" : "suspended", reason: message, username: attemptedUsername ?? "" } }); return; } setError(message); };
  const submitPassword = async () => {
    setError(null); const cleanUsername = username.trim().toLowerCase();
    if (!/^[a-zA-Z0-9_]{3,32}$/.test(cleanUsername)) { setError("Username must be 3–32 characters using letters, numbers, or underscores."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    if (passwordMode === "register" && password !== confirmPassword) { setError("Passwords do not match."); return; }
    if (passwordMode === "register" && !/^\S+@\S+\.\S+$/.test(accountEmail.trim())) { setError("Enter your email address so we can send your verification code."); return; }
    try { setBusy(true);
      if (passwordMode === "register") {
        const result = await Api.registerWithPassword(cleanUsername, password, { email: accountEmail.trim() });
        // Sign-up asks for the emailed code before entering the hub.
        if (result.verificationSent || result.devCode) { setPendingAuth({ sessionToken: result.sessionToken, user: result.user }); setDevCode(result.devCode ?? null); setAwaitingCode(true); return; }
        await finishLogin(result); return;
      }
      const result = await Api.loginWithPassword(cleanUsername, password);
      await finishLogin(result);
    } catch (cause) { handleAuthError(cause, cleanUsername); } finally { setBusy(false); }
  };
  const completeVerification = async () => {
    setError(null);
    if (!/^\d{4,8}$/.test(signupCode.trim())) { setError("Enter the code we emailed you."); return; }
    try { setBusy(true); await Api.completeEmailVerification(signupCode.trim()); setAwaitingCode(false); setAwaitingPhone(true); } catch (cause) { setError(cause instanceof Error ? cause.message : "That code was not accepted."); } finally { setBusy(false); }
  };
  // Step 6 of sign-up: the number comes after the code is confirmed, then the hub.
  const savePhoneAndEnter = async () => {
    setError(null);
    const cleaned = accountPhone.replace(/[^\d+]/g, "");
    if (!/^\+?\d{7,15}$/.test(cleaned)) { setError("Enter a valid phone number, for example +254712345678"); return; }
    try { setBusy(true); await updateProfileMutation.mutateAsync({ phone: cleaned }); if (pendingAuth) await finishLogin(pendingAuth); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save your number."); } finally { setBusy(false); }
  };
  const sendCode = async () => { setError(null); if (phone.replace(/\D/g, "").length < 8) { setError("Enter your phone number with country code, for example +1 555 123 4567."); return; } if (!/^\S+@\S+\.\S+$/.test(email.trim())) { setError("Enter a valid email address."); return; } try { setBusy(true); const result = await Api.startPhoneVerification(phone, email); setRequestId(result.requestId); setPhoneMasked(result.phoneMasked); setEmailMasked(result.emailMasked); setDevCode(result.devCode ?? null); setCooldown(30); } catch (cause) { handleAuthError(cause); } finally { setBusy(false); } };
  const verifyCode = async () => { if (!requestId) return; setError(null); if (code.trim().length < 4) { setError("Enter the code sent to your email."); return; } try { setBusy(true); await finishLogin(await Api.checkPhoneVerification(phone, email, requestId, code)); } catch (cause) { handleAuthError(cause); } finally { setBusy(false); } };
  const resetPhone = () => { setRequestId(null); setCode(""); setDevCode(null); setError(null); };

  const welcome = (<View style={styles.welcome}><View style={styles.brandRowCentered}><Text style={[styles.brandName, { color: colors.foreground }]}>VARNOX</Text><View style={[styles.brandTag, { borderColor: colors.primary }]}><Text style={[styles.brandTagText, { color: colors.primary }]}>APP</Text></View></View><View style={styles.doodleWrap}><DoodleCircle colors={colors} size={doodleSize} /></View><Text style={[styles.welcomeLegal, { color: colors.muted }]}>Read our <Text style={{ color: colors.primary }}>Privacy Policy</Text>. Tap “VARNOX APP” to accept the <Text style={{ color: colors.primary }}>Terms of Service</Text>.</Text><PrimaryButton label="Get started" onPress={() => { setError(null); setStage("form"); }} busy={false} colors={colors} /><Text style={[styles.welcomeFooter, { color: colors.muted }]}>License</Text></View>);

  const authForm = (<View style={styles.content}><Pressable onPress={() => { setStage("welcome"); setError(null); }} hitSlop={12} style={styles.backRow}><MaterialIcons name="arrow-back" size={22} color={colors.foreground} /><Text style={[styles.backText, { color: colors.foreground }]}>Back</Text></Pressable><View style={styles.brandRow}><Text style={[styles.brandName, { color: colors.foreground }]}>VARNOX</Text><View style={[styles.brandTag, { borderColor: colors.primary }]}><Text style={[styles.brandTagText, { color: colors.primary }]}>APP</Text></View></View><Text style={[styles.title, { color: colors.foreground }]}>Your conversations, private and close.</Text><Text style={[styles.subtitle, { color: colors.muted }]}>Create an account or sign in to continue.</Text>
    <View style={[styles.modeSwitch, { backgroundColor: colors.surface, borderColor: colors.border }]}><Pressable onPress={() => { setAuthMode("password"); setPasswordMode("login"); setError(null); }} style={[styles.modeButton, authMode === "password" && passwordMode === "login" && { backgroundColor: colors.primary }]}><Text style={[styles.modeText, { color: authMode === "password" && passwordMode === "login" ? "#fff" : colors.muted }]}>Log in</Text></Pressable><Pressable onPress={() => { setAuthMode("password"); setPasswordMode("register"); setError(null); }} style={[styles.modeButton, authMode === "password" && passwordMode === "register" && { backgroundColor: colors.primary }]}><Text style={[styles.modeText, { color: authMode === "password" && passwordMode === "register" ? "#fff" : colors.muted }]}>Register</Text></Pressable></View>
    {authMode === "password" ? <View style={styles.form}><Text style={[styles.label, { color: colors.foreground }]}>Username</Text><TextInput value={username} onChangeText={setUsername} placeholder="" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /><Text style={[styles.label, styles.fieldGap, { color: colors.foreground }]}>Password</Text><TextInput value={password} onChangeText={setPassword} placeholder="At least 8 characters" placeholderTextColor={colors.muted} secureTextEntry style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} />{passwordMode === "register" ? <><Text style={[styles.label, styles.fieldGap, { color: colors.foreground }]}>Confirm password</Text><TextInput value={confirmPassword} onChangeText={setConfirmPassword} placeholder="Repeat your password" placeholderTextColor={colors.muted} secureTextEntry style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /><Text style={[styles.label, styles.fieldGap, { color: colors.foreground }]}>{passwordMode === "register" ? "Email" : "Email (optional)"}</Text><TextInput value={accountEmail} onChangeText={setAccountEmail} placeholder="you@example.com" placeholderTextColor={colors.muted} keyboardType="email-address" autoCapitalize="none" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /></> : null}<PrimaryButton label={passwordMode === "register" ? "Get started with VARNOX" : "Log in to VARNOX"} onPress={submitPassword} busy={busy} colors={colors} />{passwordMode === "login" ? <Pressable onPress={() => router.push("/password-reset")} style={styles.secondaryButton}><Text style={[styles.secondaryText, { color: colors.primary }]}>Forgot password?</Text></Pressable> : null}{awaitingCode ? <><Text style={[styles.label, styles.fieldGap, { color: colors.foreground }]}>Enter the code we emailed to {accountEmail.trim()}</Text>{devCode ? <Text style={[styles.label, { color: colors.primary }]}>Email delivery failed, use this code: {devCode}</Text> : null}<TextInput value={signupCode} onChangeText={setSignupCode} placeholder="6-digit code" placeholderTextColor={colors.muted} keyboardType="number-pad" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /><Pressable onPress={completeVerification} style={styles.primaryButton}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Get Started</Text>}</Pressable></> : null}{awaitingPhone ? <><Text style={[styles.label, styles.fieldGap, { color: colors.foreground }]}>Verified. Add your phone number to finish</Text><TextInput value={accountPhone} onChangeText={setAccountPhone} placeholder="+254712345678" placeholderTextColor={colors.muted} keyboardType="phone-pad" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /><Pressable onPress={savePhoneAndEnter} style={styles.primaryButton}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Continue</Text>}</Pressable></> : null}<Pressable onPress={() => { setAuthMode("phone"); setError(null); }} style={styles.secondaryButton}><Text style={[styles.secondaryText, { color: colors.muted }]}>Sign in with a phone & email code</Text></Pressable></View> : !requestId ? <View style={styles.form}><Text style={[styles.label, { color: colors.foreground }]}>Phone number</Text><TextInput value={phone} onChangeText={setPhone} placeholder="+1 555 123 4567" placeholderTextColor={colors.muted} keyboardType="phone-pad" autoComplete="tel" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /><Text style={[styles.label, styles.fieldGap, { color: colors.foreground }]}>Email address</Text><TextInput value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor={colors.muted} keyboardType="email-address" autoCapitalize="none" autoComplete="email" style={[styles.input, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /><Text style={[styles.helper, { color: colors.muted }]}>Your email receives the one-time code. Your phone identifies your account.</Text><PrimaryButton label="Send email code" onPress={sendCode} busy={busy} colors={colors} /><Pressable onPress={() => { setAuthMode("password"); setError(null); }} style={styles.secondaryButton}><Text style={[styles.secondaryText, { color: colors.muted }]}>Use username & password instead</Text></Pressable></View> : <View style={styles.form}><Text style={[styles.label, { color: colors.foreground }]}>Enter your code</Text><Text style={[styles.helper, { color: colors.muted }]}>We sent a 6-digit code to {emailMasked} for {phoneMasked}.</Text>{devCode ? <Text style={[styles.devCode, { color: colors.primary }]}>Preview code: {devCode}</Text> : null}<TextInput value={code} onChangeText={setCode} placeholder="000000" placeholderTextColor={colors.muted} keyboardType="number-pad" autoComplete="one-time-code" maxLength={10} style={[styles.input, styles.codeInput, { color: colors.foreground, borderColor: colors.border, backgroundColor: colors.surface }]} /><PrimaryButton label="Verify and continue" onPress={verifyCode} busy={busy} colors={colors} /><Pressable disabled={cooldown > 0 || busy} onPress={sendCode} style={styles.secondaryButton}><Text style={[styles.secondaryText, { color: cooldown > 0 ? colors.muted : colors.primary }]}>{cooldown > 0 ? `Resend code in ${cooldown}s` : "Resend code"}</Text></Pressable><Pressable onPress={resetPhone} style={styles.secondaryButton}><Text style={[styles.secondaryText, { color: colors.muted }]}>Use different details</Text></Pressable></View>}
    {moderationError ? <View style={[styles.statusCard, { backgroundColor: colors.surface, borderColor: colors.error }]}><View style={[styles.statusIcon, { backgroundColor: colors.error }]}><MaterialIcons name="gavel" size={20} color="#fff" /></View><View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: colors.foreground }]}>{/banned/i.test(displayedError ?? "") ? "Account banned" : "Account suspended"}</Text><Text style={[styles.statusBody, { color: colors.muted }]}>{displayedError}</Text><Text style={[styles.statusHelp, { color: colors.primary }]}>If you think this is a mistake, contact Varnox Support.</Text></View></View> : displayedError ? <Text style={[styles.error, { color: colors.error }]}>{displayedError}</Text> : null}<Text style={[styles.legal, { color: colors.muted }]}>By continuing, you agree to use Varnox responsibly.</Text></View>);

  return <ScreenContainer edges={["top", "bottom", "left", "right"]} containerClassName="bg-background"><KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>{stage === "welcome" ? welcome : authForm}</KeyboardAvoidingView></ScreenContainer>;
}

function PrimaryButton({ label, onPress, busy, colors }: { label: string; onPress: () => void; busy: boolean; colors: ReturnType<typeof useColors> }) { return <Pressable disabled={busy} onPress={onPress} style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed, busy && styles.disabled]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>{label}</Text>}</Pressable>; }

const styles = StyleSheet.create({ flex: { flex: 1 }, content: { flex: 1, paddingHorizontal: 24, paddingTop: 34 }, logo: { width: 62, height: 62, borderRadius: 20, alignItems: "center", justifyContent: "center", marginBottom: 20 }, brandRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 20 }, brandName: { fontSize: 34, fontWeight: "800", letterSpacing: 2.5 }, brandTag: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 7, paddingVertical: 3 }, brandTagText: { fontSize: 11, fontWeight: "800", letterSpacing: 1 }, kicker: { fontSize: 12, fontWeight: "800", letterSpacing: 1.6, marginBottom: 10 }, title: { fontSize: 32, lineHeight: 38, fontWeight: "800", maxWidth: 340 }, subtitle: { fontSize: 16, lineHeight: 23, marginTop: 10, maxWidth: 340 }, modeSwitch: { flexDirection: "row", padding: 4, borderRadius: 16, borderWidth: 1, marginTop: 22 }, modeButton: { flex: 1, minHeight: 38, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 }, modeText: { fontSize: 14, fontWeight: "800", textAlign: "center" }, form: { marginTop: 22 }, label: { fontSize: 14, fontWeight: "700", marginBottom: 9 }, fieldGap: { marginTop: 15 }, input: { height: 52, borderWidth: 1, borderRadius: 15, paddingHorizontal: 15, fontSize: 16 }, codeInput: { letterSpacing: 7, fontWeight: "700", textAlign: "center", marginTop: 18 }, helper: { fontSize: 13, lineHeight: 18, marginTop: 9 }, devCode: { fontSize: 14, fontWeight: "800", marginTop: 12 }, primaryButton: { height: 53, borderRadius: 16, alignItems: "center", justifyContent: "center", marginTop: 20 }, primaryText: { color: "#fff", fontSize: 16, fontWeight: "800" }, secondaryButton: { alignItems: "center", paddingVertical: 10 }, secondaryText: { fontSize: 14, fontWeight: "700" }, error: { fontSize: 13, lineHeight: 18, marginTop: 17 }, statusCard: { flexDirection: "row", gap: 12, borderWidth: 1, borderRadius: 16, padding: 14, marginTop: 18 }, statusIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" }, statusCopy: { flex: 1 }, statusTitle: { fontSize: 15, fontWeight: "800" }, statusBody: { fontSize: 12, lineHeight: 17, marginTop: 4 }, statusHelp: { fontSize: 12, lineHeight: 17, fontWeight: "700", marginTop: 6 }, legal: { fontSize: 12, lineHeight: 17, marginTop: "auto", paddingBottom: 20, textAlign: "center" }, pressed: { transform: [{ scale: 0.98 }], opacity: 0.92 }, welcome: { flex: 1, paddingHorizontal: 24, paddingTop: 30, paddingBottom: 24 }, brandRowCentered: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 6 }, doodleWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 16 }, welcomeLegal: { fontSize: 13, lineHeight: 19, textAlign: "center", marginBottom: 18 }, welcomeFooter: { fontSize: 12, fontWeight: "800", letterSpacing: 2.2, textAlign: "center", marginTop: 22 }, backRow: { flexDirection: "row", alignItems: "center", gap: 6, marginBottom: 12 }, backText: { fontSize: 14, fontWeight: "700" }, disabled: { opacity: 0.65 } });

/**
 * The welcome illustration: a ring of outline glyphs around a chat mark.
 *
 * Built from the icon font the app already ships rather than a raster asset, so it scales on
 * any screen and adds no download. Purely decorative - hidden from screen readers.
 */
const DOODLE_ICONS = [
  "chat-bubble-outline",
  "favorite-border",
  "star-border",
  "notifications-none",
  "photo-camera",
  "music-note",
  "cake",
  "directions-bike",
  "flight",
  "headphones",
  "wifi",
  "place",
  "local-cafe",
  "brush",
  "pets",
  "sports-esports",
  "local-pizza",
  "event",
] as const;

function DoodleCircle({ colors, size = 246 }: { colors: ReturnType<typeof useColors>; size?: number }) {
  const center = size / 2;
  const orbit = size * 0.4;
  const iconSize = Math.round(size * 0.095);
  const core = size * 0.34;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <View style={{ width: core, height: core, borderRadius: core / 2, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" }}>
        <MaterialIcons name="forum" size={core * 0.44} color={colors.muted} />
      </View>
      {DOODLE_ICONS.map((name, index) => {
        const angle = (index / DOODLE_ICONS.length) * Math.PI * 2 - Math.PI / 2;
        return (
          <MaterialIcons
            key={name}
            name={name}
            size={iconSize}
            color={colors.muted}
            style={{ position: "absolute", left: center + Math.cos(angle) * orbit - iconSize / 2, top: center + Math.sin(angle) * orbit - iconSize / 2, opacity: 0.7 }}
          />
        );
      })}
    </View>
  );
}
