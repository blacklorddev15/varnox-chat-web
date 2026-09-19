import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";

type Call = { id: string; name: string; initials: string; color: string; direction: "incoming" | "outgoing"; kind: "video" | "audio"; time: string; missed?: boolean };
const calls: Call[] = [
  { id: "maya", name: "Maya Chen", initials: "MC", color: "#F59E0B", direction: "outgoing", kind: "video", time: "Today, 9:48 AM" },
  { id: "noah", name: "Noah Williams", initials: "NW", color: "#10B981", direction: "incoming", kind: "audio", time: "Yesterday, 6:24 PM", missed: true },
  { id: "priya", name: "Priya Shah", initials: "PS", color: "#EC4899", direction: "incoming", kind: "video", time: "Yesterday, 2:02 PM" },
  { id: "luca", name: "Luca Moretti", initials: "LM", color: "#0EA5E9", direction: "outgoing", kind: "audio", time: "Monday, 11:16 AM" },
];

export default function CallsScreen() {
  const colors = useColors();
  const [toast, setToast] = useState<string | null>(null);
  const notify = (message: string) => { setToast(message); setTimeout(() => setToast(null), 2200); };

  return (
    <ScreenContainer className="bg-background" edges={["top", "left", "right"]}>
      <StatusBar style="dark" />
      <View style={styles.header}><View><Text style={[styles.eyebrow, { color: colors.primary }]}>KEEP IN TOUCH</Text><Text style={[styles.heading, { color: colors.foreground }]}>Calls</Text></View><Pressable onPress={() => notify("New call link created")} style={({ pressed }) => [styles.newCallButton, { backgroundColor: colors.primary }, pressed && styles.pressed]}><MaterialIcons name="add-link" size={18} color="#FFFFFF"/><Text style={styles.newCallText}>Create link</Text></Pressable></View>
      <View style={[styles.callCard, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.callCardIcon, { backgroundColor: "rgba(16,185,129,0.14)" }]}><MaterialIcons name="link" size={23} color={colors.success}/></View><View style={styles.callCardCopy}><Text style={[styles.callCardTitle, { color: colors.foreground }]}>Share a call link</Text><Text style={[styles.callCardSubtitle, { color: colors.muted }]}>Anyone can join with a link</Text></View><MaterialIcons name="chevron-right" size={22} color={colors.muted}/></View>
      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent</Text>
      <FlatList data={calls} keyExtractor={(item) => item.id} showsVerticalScrollIndicator={false} contentContainerStyle={styles.list} renderItem={({ item }) => <Pressable onPress={() => notify(`${item.kind === "video" ? "Video" : "Audio"} calling ${item.name}`)} style={({ pressed }) => [styles.callRow, pressed && styles.pressed]}><View style={[styles.avatar, { backgroundColor: item.color }]}><Text style={styles.avatarText}>{item.initials}</Text></View><View style={[styles.callCopy, { borderBottomColor: colors.border }]}><Text style={[styles.callName, { color: item.missed ? colors.error : colors.foreground }]}>{item.name}</Text><View style={styles.callMeta}><MaterialIcons name={item.direction === "incoming" ? "call-received" : "call-made"} size={15} color={item.missed ? colors.error : colors.success}/><Text style={[styles.callTime, { color: colors.muted }]}>{item.time}</Text></View></View><MaterialIcons name={item.kind === "video" ? "videocam" : "call"} size={22} color={colors.primary}/></Pressable>} />
      {toast ? <View style={[styles.toast, { backgroundColor: colors.foreground }]}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 20 },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, marginBottom: 5 },
  heading: { fontSize: 32, lineHeight: 38, fontWeight: "800", letterSpacing: -1 },
  newCallButton: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 17, paddingHorizontal: 12, paddingVertical: 9, marginBottom: 3 },
  newCallText: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  pressed: { opacity: 0.6 },
  callCard: { flexDirection: "row", alignItems: "center", marginHorizontal: 20, padding: 14, borderRadius: 18, borderWidth: 1 },
  callCardIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  callCardCopy: { flex: 1, marginLeft: 12 },
  callCardTitle: { fontSize: 14, fontWeight: "800" },
  callCardSubtitle: { fontSize: 12, marginTop: 4 },
  sectionTitle: { fontSize: 18, fontWeight: "800", marginHorizontal: 20, marginTop: 29, marginBottom: 10 },
  list: { paddingBottom: 34 },
  callRow: { flexDirection: "row", alignItems: "center", minHeight: 78, paddingLeft: 20, paddingRight: 20 },
  avatar: { width: 50, height: 50, borderRadius: 25, alignItems: "center", justifyContent: "center", marginRight: 13 },
  avatarText: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  callCopy: { flex: 1, paddingVertical: 13, borderBottomWidth: StyleSheet.hairlineWidth },
  callName: { fontSize: 15, fontWeight: "750" as any },
  callMeta: { flexDirection: "row", alignItems: "center", gap: 5, marginTop: 5 },
  callTime: { fontSize: 12 },
  toast: { position: "absolute", bottom: 24, left: 24, right: 24, paddingVertical: 13, borderRadius: 14, alignItems: "center" },
  toastText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
});
