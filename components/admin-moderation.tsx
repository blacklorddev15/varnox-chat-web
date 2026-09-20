import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { useColors } from "@/hooks/use-colors";
import { trpc } from "@/lib/trpc";
import { shortTime } from "@/lib/media-url";

/**
 * Status and channel moderation for the admin screen. Renders plain views rather than a list,
 * because it is mounted as the footer of the users FlatList and nesting lists warns on native.
 */
export function AdminModerationPanel() {
  const colors = useColors();
  const [reason, setReason] = useState("Community safety review");
  const [notice, setNotice] = useState<string | null>(null);

  const statuses = trpc.admin.statuses.useQuery();
  const channels = trpc.admin.channels.useQuery();
  const groups = trpc.admin.groups.useQuery();
  const posts = trpc.admin.channelPosts.useQuery();

  const removeStatus = trpc.admin.removeStatus.useMutation({ onSuccess: () => { void statuses.refetch(); setNotice("Status removed from every feed."); }, onError: (error) => setNotice(error.message) });
  const suspendChannel = trpc.admin.suspendChannel.useMutation({ onSuccess: () => { void channels.refetch(); setNotice("Channel updated."); }, onError: (error) => setNotice(error.message) });
  const suspendGroup = trpc.admin.suspendGroup.useMutation({ onSuccess: () => { void groups.refetch(); setNotice("Group updated."); }, onError: (error) => setNotice(error.message) });
  const deleteChannel = trpc.admin.deleteChannel.useMutation({ onSuccess: () => { void channels.refetch(); void posts.refetch(); setNotice("Channel deleted with its posts and followers."); }, onError: (error) => setNotice(error.message) });
  const removePost = trpc.admin.removeChannelPost.useMutation({ onSuccess: () => { void posts.refetch(); setNotice("Post removed."); }, onError: (error) => setNotice(error.message) });

  const liveStatuses = (statuses.data ?? []).filter((item) => !item.removedAt);
  const removedStatuses = (statuses.data ?? []).filter((item) => item.removedAt);

  return (
    <View style={styles.wrap}>
      <View style={[styles.notice, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <MaterialIcons name="info-outline" size={18} color={colors.primary} />
        <Text style={[styles.noticeText, { color: colors.muted }]}>
          Removing is a soft delete: the row stays for the audit trail and disappears from every feed. Suspending a channel or a group keeps its posts and messages but blocks new ones, and a suspended group is blocked for everyone in it, admins included.
        </Text>
      </View>
      <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder="Moderation reason"
        placeholderTextColor={colors.muted}
        style={[styles.input, { color: colors.foreground, backgroundColor: colors.surface, borderColor: colors.border }]}
      />
      {notice ? <Text style={[styles.actionNote, { color: colors.muted }]}>{notice}</Text> : null}

      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Statuses ({liveStatuses.length} live)</Text>
      {statuses.isLoading ? <ActivityIndicator color={colors.primary} /> : null}
      {!statuses.isLoading && liveStatuses.length === 0 ? <Text style={[styles.empty, { color: colors.muted }]}>No live statuses right now.</Text> : null}
      {liveStatuses.slice(0, 25).map((item) => (
        <View key={item.id} style={[styles.card, { borderColor: colors.border }]}>
          <View style={styles.cardTop}>
            <MaterialIcons name={item.kind === "image" ? "image" : "notes"} size={16} color={colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]} numberOfLines={1}>{item.authorName ?? item.authorUsername ?? `User ${item.userId}`}</Text>
            <Text style={[styles.cardTime, { color: colors.muted }]}>{shortTime(item.createdAt)}</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.muted }]} numberOfLines={3}>{item.body || (item.mediaUrl ? "(photo status)" : "(empty)")}</Text>
          <View style={styles.actions}>
            <Pressable onPress={() => removeStatus.mutate({ statusId: item.id })} disabled={removeStatus.isPending} style={({ pressed }) => [styles.action, { borderColor: colors.error }, pressed && styles.pressed]}>
              <Text style={[styles.actionText, { color: colors.error }]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      ))}
      {removedStatuses.length > 0 ? <Text style={[styles.empty, { color: colors.muted }]}>{removedStatuses.length} removed earlier (kept for audit).</Text> : null}

      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Channels ({channels.data?.length ?? 0})</Text>
      {!channels.isLoading && (channels.data ?? []).length === 0 ? <Text style={[styles.empty, { color: colors.muted }]}>No channels created yet.</Text> : null}
      {(channels.data ?? []).slice(0, 25).map((item) => (
        <View key={item.id} style={[styles.card, { borderColor: item.suspendedAt ? colors.error : colors.border }]}>
          <View style={styles.cardTop}>
            <MaterialIcons name="campaign" size={16} color={item.suspendedAt ? colors.error : colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]} numberOfLines={1}>{item.name}</Text>
            <Text style={[styles.cardTime, { color: colors.muted }]}>{item.followerCount} followers</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.muted }]} numberOfLines={2}>
            by {item.ownerName ?? item.ownerUsername ?? `User ${item.ownerId}`} · {item.postCount} posts{item.suspendedAt ? " · suspended" : ""}
          </Text>
          <View style={styles.actions}>
            <Pressable
              onPress={() => suspendChannel.mutate({ channelId: item.id, suspended: !item.suspendedAt, reason })}
              disabled={suspendChannel.isPending}
              style={({ pressed }) => [styles.action, { borderColor: colors.border }, pressed && styles.pressed]}
            >
              <Text style={[styles.actionText, { color: colors.foreground }]}>{item.suspendedAt ? "Reinstate" : "Suspend"}</Text>
            </Pressable>
            <Pressable onPress={() => deleteChannel.mutate({ channelId: item.id })} disabled={deleteChannel.isPending} style={({ pressed }) => [styles.action, { borderColor: colors.error }, pressed && styles.pressed]}>
              <Text style={[styles.actionText, { color: colors.error }]}>Delete</Text>
            </Pressable>
          </View>
        </View>
      ))}

      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Groups ({groups.data?.length ?? 0})</Text>
      {!groups.isLoading && (groups.data ?? []).length === 0 ? <Text style={[styles.empty, { color: colors.muted }]}>No groups created yet.</Text> : null}
      {(groups.data ?? []).slice(0, 25).map((item) => (
        <View key={item.id} style={[styles.card, { borderColor: item.suspendedAt ? colors.error : colors.border }]}>
          <View style={styles.cardTop}>
            <MaterialIcons name="groups" size={16} color={item.suspendedAt ? colors.error : colors.primary} />
            <Text style={[styles.cardTitle, { color: colors.foreground }]} numberOfLines={1}>{item.title || "Untitled group"}</Text>
            <Text style={[styles.cardTime, { color: colors.muted }]}>{item.memberCount} members</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.muted }]} numberOfLines={2}>
            by {item.ownerName ?? item.ownerUsername ?? `User ${item.createdBy}`}{item.suspendedAt ? ` · suspended${item.suspendedReason ? `: ${item.suspendedReason}` : ""}` : ""}
          </Text>
          <View style={styles.actions}>
            <Pressable
              onPress={() => suspendGroup.mutate({ conversationId: item.id, suspended: !item.suspendedAt, reason })}
              disabled={suspendGroup.isPending}
              style={({ pressed }) => [styles.action, { borderColor: colors.border }, pressed && styles.pressed]}
            >
              <Text style={[styles.actionText, { color: colors.foreground }]}>{item.suspendedAt ? "Reinstate" : "Suspend"}</Text>
            </Pressable>
          </View>
        </View>
      ))}

      <Text style={[styles.sectionTitle, { color: colors.foreground }]}>Recent channel posts</Text>
      {!posts.isLoading && (posts.data ?? []).length === 0 ? <Text style={[styles.empty, { color: colors.muted }]}>No channel posts yet.</Text> : null}
      {(posts.data ?? []).filter((item) => !item.removedAt).slice(0, 15).map((item) => (
        <View key={item.id} style={[styles.card, { borderColor: colors.border }]}>
          <View style={styles.cardTop}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]} numberOfLines={1}>{item.channelName}</Text>
            <Text style={[styles.cardTime, { color: colors.muted }]}>{shortTime(item.createdAt)}</Text>
          </View>
          <Text style={[styles.cardBody, { color: colors.muted }]} numberOfLines={3}>{item.body}</Text>
          <View style={styles.actions}>
            <Pressable onPress={() => removePost.mutate({ postId: item.id })} disabled={removePost.isPending} style={({ pressed }) => [styles.action, { borderColor: colors.error }, pressed && styles.pressed]}>
              <Text style={[styles.actionText, { color: colors.error }]}>Remove</Text>
            </Pressable>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 6 },
  notice: { flexDirection: "row", gap: 9, padding: 13, borderRadius: 15, borderWidth: 1, marginTop: 20 },
  noticeText: { flex: 1, fontSize: 12, lineHeight: 17 },
  input: { height: 46, marginTop: 12, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14 },
  actionNote: { fontSize: 12, marginTop: 9, fontWeight: "700" },
  sectionTitle: { fontSize: 16, fontWeight: "800", marginTop: 22, marginBottom: 9 },
  empty: { fontSize: 12, marginBottom: 6 },
  card: { borderWidth: 1, borderRadius: 16, padding: 12, marginBottom: 8 },
  cardTop: { flexDirection: "row", alignItems: "center", gap: 7 },
  cardTitle: { flex: 1, fontSize: 14, fontWeight: "800" },
  cardTime: { fontSize: 11 },
  cardBody: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  actions: { flexDirection: "row", gap: 7, marginTop: 10 },
  action: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 11, paddingVertical: 8 },
  actionText: { fontSize: 11, fontWeight: "800" },
  pressed: { opacity: 0.7 },
});
