import { useEffect, useRef } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import type { Room as LiveKitRoom } from "livekit-client";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { useColors } from "@/hooks/use-colors";
import { formatElapsed, useCall } from "@/lib/call-context";

/**
 * The call UI, rendered once above every screen so it survives navigation. Nothing is drawn
 * while idle, and the whole overlay is pointer-events pass-through only when idle.
 */

function initialsOf(name: string) {
  const initials = name.split(" ").map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return initials || "?";
}

/**
 * Best effort video: livekit-client hands back a <video> element per track, which only exists
 * on web. The element is re-attached on a short interval so a track that arrives after the
 * call screen mounted still shows up. Audio does not depend on any of this.
 */
function VideoSurface({ room, side, fallbackColor }: { room: LiveKitRoom | null; side: "local" | "remote"; fallbackColor: string }) {
  const holder = useRef<View | null>(null);

  useEffect(() => {
    if (!room || Platform.OS !== "web") return;
    let disposed = false;

    const attach = () => {
      try {
        const node = holder.current as unknown as HTMLElement | null;
        if (!node) return;
        // Branches kept separate: local and remote publication types do not unify in Array.from.
        const track = (() => {
          if (side === "local") return Array.from(room.localParticipant.videoTrackPublications.values())[0]?.track;
          const remote = Array.from(room.remoteParticipants.values())[0];
          if (!remote) return undefined;
          return Array.from(remote.videoTrackPublications.values())[0]?.track;
        })();
        if (!track) return;
        if (node.firstChild) return;
        const element = track.attach() as HTMLVideoElement;
        element.style.width = "100%";
        element.style.height = "100%";
        element.style.objectFit = "cover";
        node.appendChild(element);
      } catch {
        // video is optional: never let it take the call down
      }
    };

    attach();
    const timer = setInterval(() => {
      if (disposed) return;
      const node = holder.current as unknown as HTMLElement | null;
      if (node && !node.firstChild) attach();
    }, 2000);

    return () => {
      disposed = true;
      clearInterval(timer);
      try {
        const node = holder.current as unknown as HTMLElement | null;
        if (node) node.innerHTML = "";
      } catch {
        // ignore
      }
    };
  }, [room, side]);

  return <View ref={holder} style={[styles.videoSurface, { backgroundColor: fallbackColor }]} />;
}

export function CallOverlay() {
  const colors = useColors();
  const { phase, session, room, remoteCount, micOn, cameraOn, elapsed, error, accept, decline, hangUp, toggleMic, toggleCamera } = useCall();

  if (phase === "idle" && !error) return null;

  const name = session?.peerName ?? "Call";
  const isVideo = session?.kind === "video";
  const connected = phase === "active" && remoteCount > 0;

  const status =
    phase === "ringing-out" ? "Ringing…"
    : phase === "ringing-in" ? `Incoming ${isVideo ? "video" : "voice"} call`
    : connected ? formatElapsed(elapsed)
    : phase === "active" ? "Connecting…"
    : "";

  return (
    <View style={styles.backdrop} pointerEvents="auto">
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <Text style={styles.avatarText}>{initialsOf(name)}</Text>
        </View>
        <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>{name}</Text>
        <Text style={[styles.status, { color: connected ? colors.success : colors.muted }]}>{status}</Text>

        {isVideo && phase === "active" ? (
          <View style={styles.videos}>
            <VideoSurface room={room} side="remote" fallbackColor="#111116" />
            <VideoSurface room={room} side="local" fallbackColor="#1B1B22" />
          </View>
        ) : null}

        {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

        <View style={styles.actions}>
          {phase === "ringing-in" ? (
            <>
              <Pressable onPress={accept} style={({ pressed }) => [styles.circle, { backgroundColor: "#10B981" }, pressed && styles.pressed]}>
                <MaterialIcons name={isVideo ? "videocam" : "call"} size={26} color="#FFFFFF" />
              </Pressable>
              <Pressable onPress={decline} style={({ pressed }) => [styles.circle, { backgroundColor: "#EF4444" }, pressed && styles.pressed]}>
                <MaterialIcons name="call-end" size={26} color="#FFFFFF" />
              </Pressable>
            </>
          ) : (
            <>
              <Pressable onPress={toggleMic} style={({ pressed }) => [styles.circle, { backgroundColor: micOn ? "#1F2937" : "#EF4444" }, pressed && styles.pressed]}>
                <MaterialIcons name={micOn ? "mic" : "mic-off"} size={23} color="#FFFFFF" />
              </Pressable>
              {isVideo ? (
                <Pressable onPress={toggleCamera} style={({ pressed }) => [styles.circle, { backgroundColor: cameraOn ? "#1F2937" : "#EF4444" }, pressed && styles.pressed]}>
                  <MaterialIcons name={cameraOn ? "videocam" : "videocam-off"} size={23} color="#FFFFFF" />
                </Pressable>
              ) : null}
              <Pressable onPress={hangUp} style={({ pressed }) => [styles.circle, { backgroundColor: "#EF4444" }, pressed && styles.pressed]}>
                <MaterialIcons name="call-end" size={26} color="#FFFFFF" />
              </Pressable>
            </>
          )}
        </View>

        {phase !== "ringing-in" ? (
          <Text style={[styles.hint, { color: colors.muted }]}>
            {connected ? "Connected" : "Waiting for the other side to pick up"}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(6,6,10,0.82)", zIndex: 50, padding: 22 },
  card: { width: "100%", maxWidth: 380, borderRadius: 24, borderWidth: 1, paddingVertical: 26, paddingHorizontal: 22, alignItems: "center" },
  avatar: { width: 78, height: 78, borderRadius: 39, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#FFFFFF", fontSize: 26, fontWeight: "800" },
  name: { fontSize: 19, fontWeight: "800", marginTop: 14, textAlign: "center" },
  status: { fontSize: 13, fontWeight: "700", marginTop: 5 },
  videos: { flexDirection: "row", gap: 10, marginTop: 16, width: "100%", height: 150 },
  videoSurface: { flex: 1, borderRadius: 14, overflow: "hidden" },
  error: { fontSize: 12, lineHeight: 17, marginTop: 12, textAlign: "center" },
  actions: { flexDirection: "row", gap: 18, marginTop: 22 },
  circle: { width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.75, transform: [{ scale: 0.96 }] },
  hint: { fontSize: 11, marginTop: 16, fontWeight: "600" },
});
