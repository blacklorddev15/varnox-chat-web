import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Image, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useFocusEffect, useRouter } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { avatarUrl, resolveMediaUrl, shortTime } from "@/lib/media-url";

/** Text statuses are drawn on a coloured bubble; the key is stored with the status. */
const STORY_COLORS: Record<string, string> = {
  amber: "#F59E0B",
  violet: "#8B5CF6",
  emerald: "#10B981",
  rose: "#EC4899",
  sky: "#0EA5E9",
};

function initialsOf(name: string) {
  const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return initials || "?";
}

export default function UpdatesScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const [toast, setToast] = useState<string | null>(null);
  const [exploring, setExploring] = useState(false);
  const [query, setQuery] = useState("");

  const notify = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2200);
  };

  const feed = trpc.status.feed.useQuery();
  const channels = trpc.channels.list.useQuery();
  const search = trpc.channels.search.useQuery({ query: query.trim() }, { enabled: exploring && query.trim().length > 1 });

  // Coming back from the composer or a viewer should show the new rows immediately; a tab
  // stays mounted, so a plain mount refetch would not fire.
  const refetchFeed = feed.refetch;
  const refetchChannels = channels.refetch;
  useFocusEffect(useCallback(() => { void refetchFeed(); void refetchChannels(); }, [refetchFeed, refetchChannels]));

  const authors = feed.data ?? [];
  const mine = authors.find((author) => author.userId === user?.id);
  const others = authors.filter((author) => author.userId !== user?.id);
  const channelRows = exploring && search.data ? search.data : channels.data ?? [];

  const openStatuses = (userId: number, name: string) => {
    router.push({ pathname: "/chat/status-viewer", params: { userId: String(userId), name } });
  };

  const openChannel = (channelId: string, name: string) => {
    router.push({ pathname: "/chat/channel", params: { channelId, name } });
  };

  const renderStory = ({ item }: { item: (typeof authors)[number] }) => {
    const latest = item.items[0];
    const ring = latest?.seen ? colors.border : STORY_COLORS[latest?.background ?? "amber"] ?? colors.primary;
    const photo = latest?.kind === "image" ? resolveMediaUrl(latest.mediaUrl) : undefined;
    const avatar = avatarUrl(item.userId, item.avatarUpdatedAt);
    return (
      <Pressable onPress={() => openStatuses(item.userId, item.name)} style={({ pressed }) => [styles.storyItem, pressed && styles.pressed]}>
        <View style={[styles.storyRing, { borderColor: ring }]}>
          {photo ? (
            <Image source={{ uri: photo }} style={styles.storyPhoto} resizeMode="cover" />
          ) : avatar ? (
            <Image source={{ uri: avatar }} style={styles.storyPhoto} resizeMode="cover" />
          ) : (
            <View style={[styles.storyBubble, { backgroundColor: STORY_COLORS[latest?.background ?? "amber"] ?? colors.primary }]}>
              <Text style={styles.storyInitials}>{initialsOf(item.name)}</Text>
            </View>
          )}
        </View>
        <Text style={[styles.storyName, { color: colors.foreground }]} numberOfLines={1}>{item.userId === user?.id ? "My status" : item.name}</Text>
      </Pressable>
    );
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "left", "right"]}>
      <StatusBar style="light" />
      <View style={styles.header}>
        <View>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>STAY IN THE LOOP</Text>
          <Text style={[styles.heading, { color: colors.foreground }]}>Updates</Text>
        </View>
        <Pressable onPress={() => setExploring((value) => !value)} style={({ pressed }) => [styles.headerIcon, pressed && styles.pressed]}>
          <MaterialIcons name={exploring ? "close" : "search"} size={24} color={colors.foreground} />
        </Pressable>
      </View>

      {exploring ? (
        <View style={[styles.searchWrap, { borderColor: colors.border, backgroundColor: colors.surface }]}>
          <MaterialIcons name="search" size={19} color={colors.muted} />
          <TextInput value={query} onChangeText={setQuery} placeholder="Search channels" placeholderTextColor={colors.muted} style={[styles.searchInput, { color: colors.foreground }]} autoFocus />
        </View>
      ) : null}

      <FlatList
        data={channelRows}
        keyExtractor={(item) => item.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.content}
        ListHeaderComponent={
          <>
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Status</Text>
              <Pressable onPress={() => router.push("/chat/new-status")}>
                <Text style={[styles.action, { color: colors.primary }]}>{mine ? "Add another" : "Add status"}</Text>
              </Pressable>
            </View>

            {feed.isLoading ? (
              <ActivityIndicator color={colors.primary} style={styles.loading} />
            ) : (
              <FlatList
                data={others}
                keyExtractor={(item) => String(item.userId)}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.storyList}
                ListHeaderComponent={
                  <Pressable onPress={() => (mine ? openStatuses(user!.id, "My status") : router.push("/chat/new-status"))} style={({ pressed }) => [styles.storyItem, pressed && styles.pressed]}>
                    <View style={[styles.storyRing, { borderColor: mine ? (mine.allSeen ? colors.border : colors.primary) : colors.border }]}>
                      {mine?.items[0]?.kind === "image" ? (
                        <Image source={{ uri: resolveMediaUrl(mine.items[0].mediaUrl) }} style={styles.storyPhoto} resizeMode="cover" />
                      ) : (
                        <View style={[styles.storyBubble, { backgroundColor: mine ? STORY_COLORS[mine.items[0]?.background ?? "amber"] ?? colors.primary : colors.surface }]}>
                          <Text style={[styles.storyInitials, { color: mine ? "#FFFFFF" : colors.muted }]}>{mine ? initialsOf(user?.name ?? "You") : "You"}</Text>
                        </View>
                      )}
                      {!mine ? (
                        <View style={[styles.plusBadge, { backgroundColor: colors.primary }]}>
                          <MaterialIcons name="add" size={13} color="#FFFFFF" />
                        </View>
                      ) : null}
                    </View>
                    <Text style={[styles.storyName, { color: colors.foreground }]} numberOfLines={1}>My status</Text>
                  </Pressable>
                }
                renderItem={renderStory}
              />
            )}

            {!feed.isLoading && others.length === 0 ? (
              <Text style={[styles.empty, { color: colors.muted }]}>No status updates yet. Add one, or start a chat to see theirs.</Text>
            ) : null}

            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Channels</Text>
              <Pressable onPress={() => router.push("/chat/new-channel")}>
                <Text style={[styles.action, { color: colors.primary }]}>Create</Text>
              </Pressable>
            </View>
          </>
        }
        ListEmptyComponent={
          channels.isLoading ? (
            <ActivityIndicator color={colors.primary} style={styles.loading} />
          ) : (
            <Text style={[styles.empty, { color: colors.muted }]}>
              {exploring && query.trim().length > 1 ? `No channels match "${query.trim()}".` : "No channels yet. Create the first one."}
            </Text>
          )
        }
        renderItem={({ item }) => (
          <Pressable onPress={() => openChannel(item.id, item.name)} style={({ pressed }) => [styles.channelRow, pressed && styles.pressed]}>
            <View style={[styles.channelAvatar, { backgroundColor: colors.primary }]}>
              <Text style={styles.channelInitials}>{initialsOf(item.name)}</Text>
            </View>
            <View style={[styles.channelCopy, { borderBottomColor: colors.border }]}>
              <View style={styles.channelTop}>
                <Text style={[styles.channelName, { color: colors.foreground }]} numberOfLines={1}>{item.name}</Text>
                <Text style={[styles.channelTime, { color: colors.muted }]}>{shortTime(item.lastPostAt)}</Text>
              </View>
              <Text style={[styles.channelDescription, { color: colors.muted }]} numberOfLines={1}>
                {item.description || `${item.postCount} ${item.postCount === 1 ? "post" : "posts"}`}
              </Text>
              <View style={styles.channelMeta}>
                <Text style={[styles.channelFollowers, { color: colors.muted }]}>
                  {item.followerCount} {item.followerCount === 1 ? "follower" : "followers"}
                </Text>
                {item.suspendedAt ? <Text style={[styles.channelFollowers, { color: colors.error }]}>Suspended</Text> : null}
                {item.isFollowing ? <MaterialIcons name="check-circle" size={14} color={colors.primary} /> : null}
                {item.isOwner ? <Text style={[styles.channelFollowers, { color: colors.primary }]}>Owner</Text> : null}
              </View>
            </View>
            <MaterialIcons name="chevron-right" size={21} color={colors.muted} />
          </Pressable>
        )}
      />

      {toast ? (
        <View style={[styles.toast, { backgroundColor: colors.foreground }]}>
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingBottom: 40 },
  header: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", paddingHorizontal: 20, paddingTop: 14, paddingBottom: 18 },
  eyebrow: { fontSize: 11, fontWeight: "800", letterSpacing: 1.5, marginBottom: 5 },
  heading: { fontSize: 32, lineHeight: 38, fontWeight: "800", letterSpacing: -1 },
  headerIcon: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: 17 },
  pressed: { opacity: 0.6 },
  searchWrap: { height: 46, borderRadius: 15, marginHorizontal: 20, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", borderWidth: 1, marginBottom: 12 },
  searchInput: { flex: 1, marginLeft: 9, fontSize: 15, paddingVertical: 0 },
  sectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 22, paddingTop: 22, paddingBottom: 10 },
  sectionTitle: { fontSize: 17, fontWeight: "800" },
  action: { fontSize: 12, fontWeight: "800", letterSpacing: 0.3 },
  loading: { marginVertical: 18 },
  storyList: { paddingHorizontal: 20, gap: 14 },
  storyItem: { width: 74, alignItems: "center" },
  storyRing: { width: 66, height: 66, borderRadius: 33, borderWidth: 2.5, padding: 3, alignItems: "center", justifyContent: "center" },
  storyPhoto: { width: "100%", height: "100%", borderRadius: 30 },
  storyBubble: { width: "100%", height: "100%", borderRadius: 30, alignItems: "center", justifyContent: "center" },
  storyInitials: { color: "#FFFFFF", fontWeight: "800", fontSize: 17 },
  plusBadge: { position: "absolute", bottom: -2, right: -2, width: 21, height: 21, borderRadius: 11, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#0B0B0F" },
  storyName: { fontSize: 11, fontWeight: "700", marginTop: 6, textAlign: "center" },
  empty: { fontSize: 13, lineHeight: 19, paddingHorizontal: 22, paddingBottom: 6 },
  channelRow: { flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 18, minHeight: 76 },
  channelAvatar: { width: 52, height: 52, borderRadius: 26, alignItems: "center", justifyContent: "center" },
  channelInitials: { color: "#FFFFFF", fontWeight: "800", fontSize: 17 },
  channelCopy: { flex: 1, marginLeft: 13, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  channelTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  channelName: { flex: 1, fontSize: 15, fontWeight: "800" },
  channelTime: { fontSize: 11, fontWeight: "600" },
  channelDescription: { fontSize: 12, marginTop: 4 },
  channelMeta: { flexDirection: "row", alignItems: "center", gap: 7, marginTop: 6 },
  channelFollowers: { fontSize: 11, fontWeight: "700" },
  toast: { position: "absolute", bottom: 24, left: 24, right: 24, paddingVertical: 13, paddingHorizontal: 16, borderRadius: 14, alignItems: "center" },
  toastText: { color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
});
