import { useRouter } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";

// No star backend exists yet, so this list is intentionally empty rather than demo rows.
const saved: { chat: string; text: string; time: string }[] = [];

export default function StarredScreen() {
  const colors = useColors(); const router = useRouter();
  return <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}><View style={styles.header}><Pressable onPress={() => router.back()}><MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground}/></Pressable><Text style={[styles.title, { color: colors.foreground }]}>Starred messages</Text><MaterialIcons name="star" size={23} color={colors.primary}/></View><ScrollView contentContainerStyle={styles.content}>{saved.map((item) => <Pressable key={item.text} onPress={() => router.back()} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.cardTop}><Text style={[styles.chat, { color: colors.primary }]}>{item.chat}</Text><Text style={[styles.time, { color: colors.muted }]}>{item.time}</Text></View><Text style={[styles.message, { color: colors.foreground }]}>{item.text}</Text><MaterialIcons name="star" size={18} color={colors.primary} style={styles.star}/></Pressable>)}<Text style={[styles.note, { color: colors.muted }]}>Starred messages stay easy to find across your conversations.</Text>{saved.length === 0 ? <Text style={[styles.note, { color: colors.muted }]}>No starred messages yet.</Text> : null}</ScrollView></ScreenContainer>;
}
const styles = StyleSheet.create({ header: { flexDirection: "row", alignItems: "center", gap: 16, padding: 20 }, title: { flex: 1, fontSize: 21, fontWeight: "800" }, content: { padding: 20, gap: 12 }, card: { borderRadius: 18, borderWidth: 1, padding: 16 }, cardTop: { flexDirection: "row", justifyContent: "space-between" }, chat: { fontSize: 13, fontWeight: "800" }, time: { fontSize: 11 }, message: { fontSize: 15, lineHeight: 21, marginTop: 10, paddingRight: 22 }, star: { position: "absolute", right: 15, bottom: 15 }, note: { textAlign: "center", fontSize: 12, marginTop: 12 } });
