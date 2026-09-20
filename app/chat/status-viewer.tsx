import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";

/**
 * Plays a video or a recording inside the status stage.
 *
 * A component of its own because the players are hooks, and the viewer decides what to render with a
 * conditional - hooks cannot be created inside one branch of a ternary.
 */
function StatusMedia({ kind, url, durationMs }: { kind: "video" | "voice"; url: string; durationMs?: number | null }) {
  const source = resolveMediaUrl(url) ?? null;
  const videoPlayer = useVideoPlayer(kind === "video" ? source : null, (player) => {
    player.loop = false;
    player.play();
  });
  const audioPlayer = useAudioPlayer(kind === "voice" ? source : null);
  const audioStatus = useAudioPlayerStatus(audioPlayer);

  if (kind === "video") {
    return <VideoView player={videoPlayer} style={styles.image} contentFit="contain" nativeControls />;
  }

  const seconds = Math.round((durationMs ?? 0) / 1000);
  return (
    <View style={styles.voiceStage}>
      <MaterialIcons name="mic" size={38} color="#FFFFFF" />
      <Text style={styles.voiceStageText}>{seconds}s recording</Text>
      <Pressable
        onPress={() => (audioStatus.playing ? audioPlayer.pause() : audioPlayer.play())}
        style={({ pressed }) => [styles.voiceStageButton, pressed && styles.pressed]}
      >
        <MaterialIcons name={audioStatus.playing ? "pause" : "play-arrow"} size={24} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}
import { useLocalSearchParams, useRouter } from "expo-router";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import { resolveMediaUrl, shortTime } from "@/lib/media-url";

const STORY_COLORS: Record<string, string> = {
  amber: "#F59E0B",
  violet: "#8B5CF6",
  emerald: "#10B981",
  rose: "#EC4899",
  sky: "#0EA5E9",
};

export default function StatusViewerScreen() {
  const colors = useColors();
  const router = useRouter();
  const { user } = useAuth();
  const params = useLocalSearchParams<{ userId?: string; name?: string }>();
  const authorId = Number(params.userId ?? 0);

  const feed = trpc.status.feed.useQuery();
  const author = useMemo(() => (feed.data ?? []).find((entry) => entry.userId === authorId), [feed.data, authorId]);
  const items = author?.items ?? [];
  const isMine = authorId === user?.id;

  const [index, setIndex] = useState(0);
  const current = items[Math.min(index, Math.max(items.length - 1, 0))];

  const view = trpc.status.view.useMutation();
  const remove = trpc.status.remove.useMutation({ onSuccess: () => router.back() });
  const viewers = trpc.status.viewers.useQuery({ statusId: current?.id ?? "" }, { enabled: Boolean(isMine && current?.id) });

  // Opening a status is what marks it seen; the ring in Updates reads that back.
  const markView = view.mutate;
  useEffect(() => {
    if (current && !isMine) markView({ statusId: current.id });
  }, [current, isMine, markView]);

  const [showViewers, setShowViewers] = useState(false);

  const goNext = () => {
    if (index + 1 < items.length) setIndex(index + 1);
    else router.back();
  };
  const goPrevious = () => {
    if (index > 0) setIndex(index - 1);
  };

  const background = STORY_COLORS[current?.background ?? "amber"] ?? colors.primary;

  return (
    <ScreenContainer className="bg-background" edges={["top", "bottom", "left", "right"]} containerClassName="bg-black">
      <View style={styles.bars}>
        {items.map((item, position) => (
          <View key={item.id} style={[styles.bar, { backgroundColor: position <= index ? "#FFFFFF" : "rgba(255,255,255,0.3)" }]} />
        ))}
      </View>

      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={styles.name}>{isMine ? "My status" : author?.name ?? params.name ?? "Status"}</Text>
          <Text style={styles.time}>{shortTime(current?.createdAt)} ago</Text>
        </View>
        {isMine && current ? (
          <Pressable onPress={() => remove.mutate({ statusId: current.id })} hitSlop={12} style={styles.headerAction}>
            <MaterialIcons name="delete-outline" size={22} color="#FFFFFF" />
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.headerAction}>
          <MaterialIcons name="close" size={22} color="#FFFFFF" />
        </Pressable>
      </View>

      {feed.isLoading ? (
        <ActivityIndicator color="#FFFFFF" style={styles.loading} />
      ) : !current ? (
        <View style={styles.emptyWrap}>
          <MaterialIcons name="hourglass-empty" size={40} color="rgba(255,255,255,0.6)" />
          <Text style={styles.emptyTitle}>This status has expired</Text>
          <Text style={styles.emptyCopy}>Statuses disappear 24 hours after they are posted.</Text>
        </View>
      ) : (
        <View style={styles.stage}>
          {current.kind === "image" && current.mediaUrl ? (
            <Image source={{ uri: resolveMediaUrl(current.mediaUrl) }} style={styles.image} resizeMode="contain" />
          ) : (current.kind === "video" || current.kind === "voice") && current.mediaUrl ? (
            <StatusMedia kind={current.kind} url={current.mediaUrl} durationMs={current.voiceDurationMs} />
          ) : (
            <View style={[styles.textStage, { backgroundColor: background }]}>
              <Text style={styles.stageText}>{current.body}</Text>
            </View>
          )}

          <Pressable style={styles.tapLeft} onPress={goPrevious} />
          <Pressable style={styles.tapRight} onPress={goNext} />

          {isMine ? (
            <Pressable onPress={() => setShowViewers((value) => !value)} style={styles.viewersBar}>
              <MaterialIcons name="visibility" size={17} color="#FFFFFF" />
              <Text style={styles.viewersText}>
                {viewers.data?.length ? `${viewers.data.length} ${viewers.data.length === 1 ? "view" : "views"}` : "No views yet"}
              </Text>
              <MaterialIcons name={showViewers ? "expand-more" : "expand-less"} size={19} color="#FFFFFF" />
            </Pressable>
          ) : null}
        </View>
      )}

      {showViewers && isMine ? (
        <View style={styles.viewerSheet}>
          {viewers.data?.length ? (
            viewers.data.map((viewer) => (
              <View key={viewer.userId} style={styles.viewerRow}>
                <View style={[styles.viewerAvatar, { backgroundColor: colors.primary }]}>
                  <Text style={styles.viewerInitials}>{(viewer.name ?? viewer.username ?? "?").slice(0, 2).toUpperCase()}</Text>
                </View>
                <Text style={styles.viewerName}>{viewer.name ?? viewer.username ?? `User ${viewer.userId}`}</Text>
                <Text style={styles.viewerTime}>{shortTime(viewer.viewedAt)}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.viewerEmpty}>Nobody has opened this status yet.</Text>
          )}
        </View>
      ) : null}
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  voiceStage: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, backgroundColor: "#1B1B22" },
  voiceStageText: { color: "#FFFFFF", fontSize: 14, fontWeight: "700" },
  voiceStageButton: { width: 54, height: 54, borderRadius: 27, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(255,255,255,0.18)" },
  pressed: { opacity: 0.6 },
  bars: { flexDirection: "row", gap: 4, paddingHorizontal: 10, paddingTop: 8 },
  bar: { flex: 1, height: 3, borderRadius: 2 },
  header: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 12 },
  headerCopy: { flex: 1 },
  name: { color: "#FFFFFF", fontSize: 15, fontWeight: "800" },
  time: { color: "rgba(255,255,255,0.7)", fontSize: 11, marginTop: 2 },
  headerAction: { padding: 4 },
  loading: { marginTop: 40 },
  stage: { flex: 1 },
  image: { flex: 1, width: "100%" },
  textStage: { flex: 1, alignItems: "center", justifyContent: "center", padding: 34 },
  stageText: { color: "#FFFFFF", fontSize: 24, lineHeight: 33, fontWeight: "800", textAlign: "center" },
  tapLeft: { position: "absolute", left: 0, top: 0, bottom: 0, width: "32%" },
  tapRight: { position: "absolute", right: 0, top: 0, bottom: 0, width: "68%" },
  viewersBar: { position: "absolute", left: 0, right: 0, bottom: 0, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: "rgba(0,0,0,0.55)" },
  viewersText: { flex: 1, color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  viewerSheet: { maxHeight: 240, paddingHorizontal: 18, paddingBottom: 12 },
  viewerRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 9 },
  viewerAvatar: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  viewerInitials: { color: "#FFFFFF", fontSize: 12, fontWeight: "800" },
  viewerName: { flex: 1, color: "#FFFFFF", fontSize: 13, fontWeight: "700" },
  viewerTime: { color: "rgba(255,255,255,0.6)", fontSize: 11 },
  viewerEmpty: { color: "rgba(255,255,255,0.7)", fontSize: 12, paddingVertical: 10 },
  emptyWrap: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 30 },
  emptyTitle: { color: "#FFFFFF", fontSize: 17, fontWeight: "800", marginTop: 12 },
  emptyCopy: { color: "rgba(255,255,255,0.65)", fontSize: 12, marginTop: 6, textAlign: "center" },
});
