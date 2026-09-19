import { useCallback, useState } from "react";
import { ActivityIndicator, FlatList, Image, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { prepareAttachment } from "@/lib/media-upload";
import { resolveMediaUrl, shortTime } from "@/lib/media-url";

export default function ChannelScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ channelId?: string; name?: string }>();
  const channelId = String(params.channelId ?? "");

  const [draft, setDraft] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showFollowers, setShowFollowers] = useState(false);

  const channel = trpc.channels.get.useQuery({ channelId }, { enabled: Boolean(channelId) });
  const posts = trpc.channels.posts.useQuery({ channelId, limit: 50 }, { enabled: Boolean(channelId) });
  const followers = trpc.channels.followers.useQuery({ channelId }, { enabled: Boolean(channelId) && showFollowers });

  const follow = trpc.channels.follow.useMutation({ onSuccess: () => { void channel.refetch(); setNotice("Following. New posts appear here."); } });
  const unfollow = trpc.channels.unfollow.useMutation({ onSuccess: () => { void channel.refetch(); setNotice("Unfollowed."); } });
  const read = trpc.channels.read.useMutation();
  const removePost = trpc.channels.removePost.useMutation({ onSuccess: () => void posts.refetch() });
  const upload = trpc.media.upload.useMutation();
  const post = trpc.channels.post.useMutation({ onSuccess: () => { setDraft(""); setPhotoUrl(null); void posts.refetch(); } });

  const refetchChannel = channel.refetch;
  const refetchPosts = posts.refetch;
  const markRead = read.mutate;
  useFocusEffect(
    useCallback(() => {
      void refetchChannel();
      void refetchPosts();
      if (channelId) markRead({ channelId });
    }, [refetchChannel, refetchPosts, markRead, channelId]),
  );

  const info = channel.data;
  const isOwner = info?.isOwner ?? false;

  const pickPhoto = async () => {
    setNotice(null);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setNotice("Photo access was refused. Allow photos for this app, then try again.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.85, base64: true });
      if (result.canceled || !result.assets?.length) return;
      const payload = await prepareAttachment(result.assets[0], "image");
      if (!payload) {
        setNotice("Could not read that image: the picker returned no usable data.");
        return;
      }
      const uploaded = await upload.mutateAsync(payload);
      setPhotoUrl(uploaded.url);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not attach that photo.");
    }
  };

  const publish = async () => {
    if (!draft.trim() && !photoUrl) return;
    setNotice(null);
    try {
      await post.mutateAsync({ channelId, body: draft.trim() || "(photo)", mediaUrl: photoUrl ?? undefined });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not publish that post.");
    }
  };

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <MaterialIcons name="arrow-back-ios" size={20} color={colors.foreground} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={[styles.title, { color: colors.foreground }]} numberOfLines={1}>{info?.name ?? params.name ?? "Channel"}</Text>
            <Pressable onPress={() => setShowFollowers((value) => !value)}>
              <Text style={[styles.sub, { color: colors.muted }]}>
                {info ? `${info.followerCount} ${info.followerCount === 1 ? "follower" : "followers"} · ${info.postCount} ${info.postCount === 1 ? "post" : "posts"}` : "Loading…"}
              </Text>
            </Pressable>
          </View>
          {info && !isOwner ? (
            info.isFollowing ? (
              <Pressable onPress={() => unfollow.mutate({ channelId })} style={({ pressed }) => [styles.followButton, { borderColor: colors.border }, pressed && styles.pressed]}>
                <Text style={[styles.followText, { color: colors.muted }]}>Following</Text>
              </Pressable>
            ) : (
              <Pressable onPress={() => follow.mutate({ channelId })} style={({ pressed }) => [styles.followButton, { backgroundColor: colors.primary, borderColor: colors.primary }, pressed && styles.pressed]}>
                <Text style={[styles.followText, { color: "#FFFFFF" }]}>Follow</Text>
              </Pressable>
            )
          ) : null}
          {isOwner ? <MaterialIcons name="verified" size={20} color={colors.primary} /> : null}
        </View>

        {info?.description ? <Text style={[styles.description, { color: colors.muted }]}>{info.description}</Text> : null}
        {info?.suspendedAt ? (
          <View style={[styles.suspended, { borderColor: colors.error }]}>
            <MaterialIcons name="block" size={16} color={colors.error} />
            <Text style={[styles.suspendedText, { color: colors.error }]}>Suspended by an administrator{info.suspendedReason ? `: ${info.suspendedReason}` : ""}</Text>
          </View>
        ) : null}

        {showFollowers ? (
          <View style={[styles.followerSheet, { borderColor: colors.border }]}>
            {followers.data?.length ? (
              followers.data.map((follower) => (
                <View key={follower.userId} style={styles.followerRow}>
                  <View style={[styles.followerAvatar, { backgroundColor: colors.primary }]}>
                    <Text style={styles.followerInitials}>{(follower.name ?? follower.username ?? "?").slice(0, 2).toUpperCase()}</Text>
                  </View>
                  <Text style={[styles.followerName, { color: colors.foreground }]}>{follower.name ?? follower.username ?? `User ${follower.userId}`}</Text>
                  <Text style={[styles.followerTime, { color: colors.muted }]}>{shortTime(follower.followedAt)}</Text>
                </View>
              ))
            ) : (
              <Text style={[styles.followerEmpty, { color: colors.muted }]}>No followers yet.</Text>
            )}
          </View>
        ) : null}

        <FlatList
          data={posts.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={posts.isLoading ? <ActivityIndicator color={colors.primary} style={styles.loading} /> : <Text style={[styles.empty, { color: colors.muted }]}>{isOwner ? "Nothing posted yet. Publish the first update below." : "No posts yet."}</Text>}
          renderItem={({ item }) => (
            <View style={[styles.postCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.postTop}>
                <MaterialIcons name="campaign" size={16} color={colors.primary} />
                <Text style={[styles.postAuthor, { color: colors.muted }]}>{item.authorName ?? item.authorUsername ?? "Channel"} · {shortTime(item.createdAt)}</Text>
                {isOwner || item.authorId === user?.id ? (
                  <Pressable onPress={() => removePost.mutate({ postId: item.id })} hitSlop={10}>
                    <MaterialIcons name="delete-outline" size={18} color={colors.muted} />
                  </Pressable>
                ) : null}
              </View>
              <Text style={[styles.postBody, { color: colors.foreground }]}>{item.body}</Text>
              {item.mediaUrl ? <Image source={{ uri: resolveMediaUrl(item.mediaUrl) }} style={styles.postImage} resizeMode="cover" /> : null}
            </View>
          )}
        />

        {notice ? <Text style={[styles.notice, { color: colors.muted }]}>{notice}</Text> : null}

        {isOwner && !info?.suspendedAt ? (
          <View style={[styles.composerArea, { borderTopColor: colors.border }]}>
            {photoUrl ? (
              <View style={styles.attachment}>
                <Image source={{ uri: resolveMediaUrl(photoUrl) }} style={styles.attachmentImage} resizeMode="cover" />
                <Pressable onPress={() => setPhotoUrl(null)} style={styles.attachmentRemove}>
                  <MaterialIcons name="close" size={15} color="#FFFFFF" />
                </Pressable>
              </View>
            ) : null}
            <View style={styles.composerRow}>
              <Pressable onPress={pickPhoto} hitSlop={8} style={styles.composerIcon}>
                <MaterialIcons name="photo-camera" size={22} color={colors.muted} />
              </Pressable>
              <View style={[styles.composer, { borderColor: colors.border, backgroundColor: colors.surface }]}>
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="Post to your channel"
                  placeholderTextColor={colors.muted}
                  multiline
                  maxLength={2000}
                  style={[styles.composerInput, { color: colors.foreground }]}
                />
              </View>
              <Pressable onPress={publish} disabled={post.isPending || (!draft.trim() && !photoUrl)} style={({ pressed }) => [styles.sendButton, { backgroundColor: draft.trim() || photoUrl ? colors.primary : colors.surface }, (pressed || post.isPending) && styles.pressed]}>
                <MaterialIcons name="send" size={19} color={draft.trim() || photoUrl ? "#FFFFFF" : colors.muted} />
              </Pressable>
            </View>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 18, paddingTop: 16, paddingBottom: 12 },
  headerCopy: { flex: 1 },
  title: { fontSize: 19, fontWeight: "800" },
  sub: { fontSize: 11, marginTop: 3, fontWeight: "600" },
  followButton: { borderWidth: 1, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 8 },
  followText: { fontSize: 12, fontWeight: "800" },
  pressed: { opacity: 0.7 },
  description: { fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingBottom: 10 },
  suspended: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 18, marginBottom: 10, padding: 11, borderRadius: 13, borderWidth: 1 },
  suspendedText: { flex: 1, fontSize: 11, lineHeight: 16, fontWeight: "700" },
  followerSheet: { maxHeight: 190, marginHorizontal: 18, marginBottom: 10, borderWidth: 1, borderRadius: 14, padding: 10 },
  followerRow: { flexDirection: "row", alignItems: "center", gap: 9, paddingVertical: 7 },
  followerAvatar: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  followerInitials: { color: "#FFFFFF", fontSize: 11, fontWeight: "800" },
  followerName: { flex: 1, fontSize: 13, fontWeight: "700" },
  followerTime: { fontSize: 11 },
  followerEmpty: { fontSize: 12, paddingVertical: 6 },
  list: { paddingHorizontal: 18, paddingBottom: 20, gap: 10 },
  loading: { marginTop: 24 },
  empty: { fontSize: 13, lineHeight: 19, paddingTop: 18 },
  postCard: { borderWidth: 1, borderRadius: 17, padding: 13 },
  postTop: { flexDirection: "row", alignItems: "center", gap: 7, marginBottom: 7 },
  postAuthor: { flex: 1, fontSize: 11, fontWeight: "700" },
  postBody: { fontSize: 14, lineHeight: 20 },
  postImage: { width: "100%", height: 190, borderRadius: 13, marginTop: 10 },
  notice: { fontSize: 12, lineHeight: 17, paddingHorizontal: 18, paddingBottom: 8 },
  composerArea: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 9, paddingBottom: 9, paddingHorizontal: 12 },
  attachment: { width: 88, height: 88, borderRadius: 13, overflow: "hidden", marginBottom: 9 },
  attachmentImage: { width: "100%", height: "100%" },
  attachmentRemove: { position: "absolute", top: 5, right: 5, width: 24, height: 24, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.6)", alignItems: "center", justifyContent: "center" },
  composerRow: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  composerIcon: { width: 40, height: 46, alignItems: "center", justifyContent: "center" },
  composer: { flex: 1, minHeight: 46, maxHeight: 110, borderRadius: 23, borderWidth: 1, justifyContent: "center" },
  composerInput: { fontSize: 15, maxHeight: 94, paddingHorizontal: 16, paddingVertical: 12 },
  sendButton: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
});
