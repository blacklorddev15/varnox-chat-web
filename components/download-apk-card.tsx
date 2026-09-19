import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useColors } from "@/hooks/use-colors";
import { APK_SIZE_LABEL, APK_VERSION, downloadAndroidApp } from "@/lib/apk";

/** Offers the Android build on the web app. The file is served from /VARNOX.apk. */
export function DownloadApkCard() {
  const colors = useColors();
  return (
    <Pressable
      onPress={downloadAndroidApp}
      accessibilityRole="link"
      accessibilityLabel="Download the VARNOX Android app"
      style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}
    >
      <View style={[styles.icon, { backgroundColor: colors.primary }]}>
        <MaterialIcons name="android" size={20} color="#fff" />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.foreground }]}>Get the VARNOX Android app</Text>
        <Text style={[styles.hint, { color: colors.muted }]}>APK · v{APK_VERSION} · {APK_SIZE_LABEL} · message alerts</Text>
      </View>
      <MaterialIcons name="download" size={20} color={colors.primary} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", borderWidth: 1, borderRadius: 16, padding: 14, marginTop: 18, gap: 12 },
  icon: { width: 38, height: 38, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1 },
  title: { fontSize: 14, fontWeight: "800" },
  hint: { fontSize: 11, marginTop: 4 },
  pressed: { opacity: 0.58 },
});
