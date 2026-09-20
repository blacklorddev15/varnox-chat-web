import { useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { RoomEvent, type Room as LiveKitRoom } from "livekit-client";
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
function VideoSurface({
  room,
  identity,
  side,
  fallbackColor,
}: {
  room: LiveKitRoom | null;
  /** The participant this tile belongs to. `null` for the local tile, which is looked up differently. */
  identity: string | null;
  side: "local" | "remote";
  fallbackColor: string;
}) {
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
          // Looked up by identity rather than by position: in a group call the participant at index 0
          // changes as people join and leave, which would slide every other tile's picture sideways.
          const remote = identity ? room.remoteParticipants.get(identity) : Array.from(room.remoteParticipants.values())[0];
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
    // `identity` is part of the dependency list so a tile that was reused for a different participant
    // re-attaches instead of keeping the previous person's picture.
  }, [room, side, identity]);

  return <View ref={holder} style={[styles.videoSurface, { backgroundColor: fallbackColor }]} />;
}

/**
 * Who else is on the call, kept in sync with the room.
 *
 * The room is the source of truth and it is a live object, so this subscribes rather than reading it
 * once. Mute and unmute are included because a participant whose camera is switched on after joining
 * publishes a track without a connection event, and without those the new tile would have no picture
 * until something else happened to trigger a re-render.
 */
function useRemoteParticipants(room: LiveKitRoom | null) {
  const [participants, setParticipants] = useState<Array<{ identity: string; name: string }>>([]);

  useEffect(() => {
    if (!room) {
      setParticipants([]);
      return;
    }

    const sync = () =>
      setParticipants(
        Array.from(room.remoteParticipants.values()).map((participant) => ({
          identity: participant.identity,
          // `name` is what the app set when joining; identity is the user id and is the fallback.
          name: participant.name || participant.identity,
        })),
      );

    sync();
    const events = [
      RoomEvent.ParticipantConnected,
      RoomEvent.ParticipantDisconnected,
      RoomEvent.TrackSubscribed,
      RoomEvent.TrackUnsubscribed,
      RoomEvent.TrackMuted,
      RoomEvent.TrackUnmuted,
    ];
    for (const event of events) room.on(event, sync);

    return () => {
      for (const event of events) room.off(event, sync);
    };
  }, [room]);

  return participants;
}

/** Columns for the grid, so a two-person call fills the row and a large one does not get tiny. */
function columnsFor(tiles: number): number {
  if (tiles <= 1) return 1;
  if (tiles <= 4) return 2;
  return 3;
}

export function CallOverlay() {
  const colors = useColors();
  const { phase, session, room, remoteCount, micOn, cameraOn, elapsed, error, accept, decline, hangUp, toggleMic, toggleCamera } = useCall();

  if (phase === "idle" && !error) return null;

  const name = session?.peerName ?? "Call";
  const isVideo = session?.kind === "video";
  const connected = phase === "active" && remoteCount > 0;

  // One tile per remote participant plus your own, laid out in rows. Tiles are `flex: 1` inside a
  // row rather than a percentage width: the card has a maximum width but a shrinking one, and
  // percentages would overflow it on a narrow screen.
  const remotes = useRemoteParticipants(room);
  const tiles = [
    ...remotes.map((participant) => ({ key: participant.identity, identity: participant.identity as string | null, label: participant.name })),
    // Your own tile goes last and is labelled, so a grid needs no legend to be readable.
    { key: "__self", identity: null as string | null, label: "You" },
  ];
  const columns = columnsFor(tiles.length);
  const videoRows: Array<typeof tiles> = [];
  for (let index = 0; index < tiles.length; index += columns) videoRows.push(tiles.slice(index, index + columns));

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
            {videoRows.map((row, rowIndex) => (
              <View key={`row-${rowIndex}`} style={styles.videoRow}>
                {row.map((tile) => (
                  <View key={tile.key} style={styles.tile}>
                    <VideoSurface
                      room={room}
                      identity={tile.identity}
                      side={tile.identity === null ? "local" : "remote"}
                      fallbackColor={tile.identity === null ? "#1B1B22" : "#111116"}
                    />
                    <Text style={styles.tileLabel} numberOfLines={1}>
                      {tile.label}
                    </Text>
                  </View>
                ))}
                {/* Keeps the last row's tiles the same width as the rows above them. */}
                {Array.from({ length: Math.max(0, columns - row.length) }).map((_, fillerIndex) => (
                  <View key={`filler-${fillerIndex}`} style={styles.tileFiller} />
                ))}
              </View>
            ))}
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
  videos: { marginTop: 16, width: "100%", gap: 8 },
  videoRow: { flexDirection: "row", gap: 8 },
  // Height comes from the tile's own width, so a row of two and a row of three both end up sensibly
  // shaped instead of one being stretched thin.
  tile: { flex: 1, aspectRatio: 4 / 3, borderRadius: 14, overflow: "hidden", backgroundColor: "#111116" },
  tileFiller: { flex: 1 },
  videoSurface: { flex: 1 },
  // Dark chip rather than a plain label, so a name stays readable over whatever the camera shows.
  tileLabel: { position: "absolute", left: 6, bottom: 6, right: 6, fontSize: 10, fontWeight: "700", color: "#FFFFFF", backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  error: { fontSize: 12, lineHeight: 17, marginTop: 12, textAlign: "center" },
  actions: { flexDirection: "row", gap: 18, marginTop: 22 },
  circle: { width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.75, transform: [{ scale: 0.96 }] },
  hint: { fontSize: 11, marginTop: 16, fontWeight: "600" },
});
