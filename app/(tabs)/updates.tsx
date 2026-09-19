import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";

type Story = { id: string; name: string; initials: string; color: string; seen?: boolean };
type Channel = { id: string; name: string; description: string; initials: string; color: string; followers: string; time: string };

// Status and channels have no backend yet, so these stay empty rather than showing demo
// people and demo channels.
const stories: Story[] = [];
const channels: Channel[] = [];

function StoryAvatar({ story }: { story: Story }) {
  return <View style={[styles.storyRing, { borderColor: story.seen ? "#D7DCE2" : "#F59E0B" }]}><View style={[styles.storyAvatar, { backgroundColor: story.color }]}><Text style={styles.storyInitials}>{story.initials}</Text></View>{story.id === "you" ? <View style={styles.plusBadge}><MaterialIcons name="add" size={12} color="#FFFFFF" /></View> : null}</View>;
}

export default function UpdatesScreen() {
  const colors = useColors();
  const [toast, setToast] = useState<string | null>(null);
  const notify = (message: string) => { setToast(message); setTimeout(() => setToast(null), 2200); };

  return (
    <ScreenContainer className="bg-background" edges={["top", "left", "right"]}>
      <StatusBar style="light" />
      <View style={styles.header}><View><Text style={[styles.eyebrow, { color: colors.primary }]}>STAY IN THE LOOP</Text><Text style={[styles.heading, { color: colors.foreground }]}>Updates</Text></View><Pressable onPress={() => notify("Update options opened")} style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}><MaterialIcons name="more-horiz" size={24} color={colors.foreground}/></Pressable></View>
      <FlatList
        data={channels}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        ListHeaderComponent={<>
          <View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: colors.foreground }]}>Status</Text><Pressable onPress={() => notify("Status privacy opened")}><Text style={[styles.action, { color: colors.primary }]}>Privacy</Text></Pressable></View>
          <FlatList data={stories} keyExtractor={(item) => item.id} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.storyList} renderItem={({ item }) => <Pressable onPress={() => notify(item.id === "you" ? "Create a new status" : `Opening ${item.name}'s status`)} style={({ pressed }) => [styles.storyItem, pressed && styles.pressed]}><StoryAvatar story={item}/><Text style={[styles.storyName, { color: colors.foreground }]} numberOfLines={1}>{item.name}</Text></Pressable>} />
                     {stories.length === 0 ? <Text style={[styles.empty, { color: colors.muted }]}>No status updates yet.</Text> : null}
           <View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: colors.foreground }]}>Channels</Text><Pressable onPress={() => notify("Discovering channels")}><Text style={[styles.action, { color: colors.primary }]}>Explore</Text></Pressable></View>
        </>}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors.muted }]}>No channels yet.</Text>}
        renderItem={({ item }) => <Pressable onPress={() => notify(`Following ${item.name}`)} style={({ pressed }) => [styles.channelRow, pressed && styles.pressed]}><View style={[styles.channelAvatar, { backgroundColor: item.color }]}><Text style={styles.channelInitials}>{item.initials}</Text></View><View style={[styles.channelCopy, { borderBottomColor: colors.border }]}><View style={styles.channelTop}><Text style={[styles.channelName, { color: colors.foreground }]}>{item.name}</Text><Text style={[styles.channelTime, { color: colors.muted }]}>{item.time}</Text></View><Text style={[styles.channelDescription, { color: colors.muted }]} numberOfLines={1}>{item.description}</Text><Text style={[styles.channelFollowers, { color: colors.muted }]}>{item.followers}</Text></View><MaterialIcons name="chevron-right" size={21} color={colors.muted}/></Pressable>}
      />
      {toast ? <View style={[styles.toast, { backgroundColor: colors.foreground }]}><Text style={styles.toastText}>{toast}</Text></View> : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18 },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, marginBottom: 5 },
  heading: { fontSize: 32, lineHeight: 38, fontWeight: "800", letterSpacing: -1 },
  headerIcon: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center", marginBottom: 3 },
  pressed: { opacity: 0.55 },
  content: { paddingBottom: 34 },
  empty: { textAlign: "center", fontSize: 13, marginTop: 4, marginBottom: 18, paddingHorizontal: 20 },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 20, marginTop: 9, marginBottom: 14 },
  sectionTitle: { fontSize: 18, fontWeight: "800" },
  action: { fontSize: 13, fontWeight: "700" },
  storyList: { paddingHorizontal: 20, gap: 18, paddingBottom: 26 },
  storyItem: { width: 62, alignItems: "center" },
  storyRing: { width: 60, height: 60, borderRadius: 30, borderWidth: 2, alignItems: "center", justifyContent: "center", marginBottom: 7 },
  storyAvatar: { width: 51, height: 51, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  storyInitials: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  storyName: { fontSize: 11, fontWeight: "600" },
  plusBadge: { position: "absolute", right: -1, bottom: 3, width: 19, height: 19, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: "#10B981", borderWidth: 2, borderColor: "#FFFFFF" },
  channelRow: { flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 15, minHeight: 88 },
  channelAvatar: { width: 50, height: 50, borderRadius: 15, alignItems: "center", justifyContent: "center", marginRight: 13 },
  channelInitials: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  channelCopy: { flex: 1, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  channelTop: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  channelName: { flex: 1, fontSize: 15, fontWeight: "750" as any },
  channelTime: { fontSize: 11 },
  channelDescription: { fontSize: 13, marginTop: 4 },
  channelFollowers: { fontSize: 11, marginTop: 6 },
  toast: { position: "absolute", bottom: 24, left: 24, right: 24, paddingVertical: 13, borderRadius: 14, alignItems: "center" },
  toastText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
});
