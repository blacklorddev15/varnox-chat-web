import { useEffect, useRef, useState } from "react";
import { Image, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { RoomEvent, Track, type Room as LiveKitRoom } from "livekit-client";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";

import { useColors } from "@/hooks/use-colors";
import { formatElapsed, useCall } from "@/lib/call-context";
import { avatarUrl } from "@/lib/media-url";

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
  // The track currently in the DOM, so a change of picture can be told apart from the same picture
  // being seen again on the next poll.
  const attachedRef = useRef<unknown>(null);

  useEffect(() => {
    if (!room || Platform.OS !== "web") return;
    let disposed = false;

    const attach = () => {
      try {
        const node = holder.current as unknown as HTMLElement | null;
        if (!node) return;
        // Branches kept separate: local and remote publication types do not unify in Array.from.
        // The local and remote branches stay written out separately, and the two look almost the
        // same. They cannot be merged: LocalTrackPublication and RemoteTrackPublication do not
        // unify, so a single Array.from over either does not typecheck. The original guard here said
        // the same thing, and merging them is exactly the mistake that broke it.
        const chosen =
          side === "local"
            ? (() => {
                const published = Array.from(room.localParticipant.videoTrackPublications.values());
                // A screen share wins over a camera. Somebody publishing both is sharing their screen,
                // and the screen is what the call is about - showing their face instead would look
                // like a broken feature rather than a choice.
                const share = published.find((publication) => isScreenShare(publication.source) && publication.track);
                const picked = share ?? published.find((publication) => publication.track);
                return picked?.track ? { track: picked.track, isShare: picked === share } : undefined;
              })()
            : (() => {
                // Looked up by identity rather than by position: in a group call the participant at
                // index 0 changes as people join and leave, which would slide every other tile's
                // picture sideways.
                const remote = identity ? room.remoteParticipants.get(identity) : Array.from(room.remoteParticipants.values())[0];
                if (!remote) return undefined;
                const published = Array.from(remote.videoTrackPublications.values());
                const share = published.find((publication) => isScreenShare(publication.source) && publication.track);
                const picked = share ?? published.find((publication) => publication.track);
                return picked?.track ? { track: picked.track, isShare: picked === share } : undefined;
              })();

        if (!chosen) return;

        // Re-attach when the picture changes - starting a share, or stopping one and falling back to
        // the camera. Without this the first frame ever attached would stay on screen, because the
        // guard below exists to avoid re-attaching the same thing on every poll.
        if (attachedRef.current === chosen.track && node.firstChild) return;
        node.innerHTML = "";

        const element = chosen.track.attach() as HTMLVideoElement;
        element.style.width = "100%";
        element.style.height = "100%";
        // A shared screen is letterboxed rather than cropped: cropping it cuts off exactly the part
        // being talked about. A camera is cropped, which is what makes a face fill a tile.
        element.style.objectFit = chosen.isShare ? "contain" : "cover";
        node.appendChild(element);
        attachedRef.current = chosen.track;
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
  const [participants, setParticipants] = useState<Array<{ identity: string; name: string; sharing: boolean }>>([]);

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
          // Known here rather than derived later, because whether the video stage should be on
          // screen at all depends on it: a share on an audio call still needs somewhere to appear.
          sharing: Array.from(participant.videoTrackPublications.values()).some(
            (publication) => publication.source === Track.Source.ScreenShare && Boolean(publication.track),
          ),
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

/**
 * Whether a published video track is a shared screen rather than a camera.
 *
 * A named helper because the same comparison appears in both the local and remote branches below,
 * and a typo in one of two string comparisons is the sort of thing that leaves a feature silently
 * half-working. LiveKit reports it as a source, which is the only reliable way to tell them apart.
 */
function isScreenShare(source: string | undefined): boolean {
  return source === Track.Source.ScreenShare;
}

/** Columns for the grid, so a two-person call fills the row and a large one does not get tiny. */
function columnsFor(tiles: number): number {
  if (tiles <= 1) return 1;
  if (tiles <= 4) return 2;
  return 3;
}

export function CallOverlay() {
  const colors = useColors();
  // Every hook this component needs is called here, above the early return below. See the note on
  // `useRemoteParticipants` for what happens otherwise.
  const { phase, session, room, remoteCount, micOn, cameraOn, screenSharing, reconnecting, elapsed, error, canPlaybackAudio, enableAudio, accept, decline, hangUp, toggleMic, toggleCamera, toggleScreenShare } = useCall();

  // One tile per remote participant plus your own, laid out in rows. Tiles are `flex: 1` inside a
  // row rather than a percentage width: the card has a maximum width but a shrinking one, and
  // percentages would overflow it on a narrow screen.
  //
  // Above the early return, and it has to stay there.
  //
  // A hook after a conditional return runs on some renders and not others. Idle renders stopped at
  // the line below having called only the two hooks above; the first call skipped that return,
  // reached this one, and React threw #310 - "Rendered more hooks than during the previous render"
  // - and unmounted the entire tree. That is not a visible glitch: it takes the whole app down to a
  // blank screen. It is why a call on this app was reported blank four times while nothing in the
  // call logic was at fault, and why every fix aimed at the call itself changed nothing.
  const remotes = useRemoteParticipants(room);

  if (phase === "idle" && !error) return null;

  const name = session?.peerName ?? "Call";
  const isVideo = session?.kind === "video";
  const connected = phase === "active" && remoteCount > 0;
  const peerPhoto = session?.peerId ? avatarUrl(session.peerId, session.avatarUpdatedAt) : undefined;

  // A share needs a stage even on a call with no camera in it, which is the whole point of being
  // able to share during an audio call.
  const showStage = isVideo || screenSharing || remotes.some((participant) => participant.sharing);
  const tiles = [
    ...remotes.map((participant) => ({ key: participant.identity, identity: participant.identity as string | null, label: participant.name, sharing: participant.sharing })),
    // Your own tile goes last and is labelled, so a grid needs no legend to be readable.
    { key: "__self", identity: null as string | null, label: "You", sharing: screenSharing },
  ];
  const columns = columnsFor(tiles.length);
  const videoRows: Array<typeof tiles> = [];
  for (let index = 0; index < tiles.length; index += columns) videoRows.push(tiles.slice(index, index + columns));

  const status =
    // Reconnecting comes first: a dropped transport on a live call is the thing a person most needs
    // told about, and the elapsed timer ticking on regardless would read as the call being fine.
    reconnecting ? "Reconnecting…"
    : phase === "ringing-out" ? "Ringing…"
    : phase === "ringing-in" ? `Incoming ${isVideo ? "video" : "voice"} call`
    : connected ? formatElapsed(elapsed)
    : phase === "active" ? "Connecting…"
    : "";

  return (
    <View style={styles.screen} pointerEvents="auto">
      {/* Name and status at the top, the way every call screen puts them. The photo and the video
          live in the middle and take whatever room is left, which is the whole point of the layout:
          this used to be a small card floating in the middle of a dimmed screen, so a call occupied
          about a third of the display and the rest of it was empty dark space. */}
      <View style={styles.topBar}>
        <Text style={[styles.name, { color: colors.foreground }]} numberOfLines={1}>{name}</Text>
        <Text style={[styles.status, { color: connected ? colors.success : colors.muted }]}>{status}</Text>
      </View>

      <View style={styles.stage}>
        {showStage && phase === "active" ? (
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
                      {/* Says which picture this is. In a call where one person is sharing and
                          another is on camera, the tiles look alike without it. */}
                      {tile.sharing ? `${tile.label} · screen` : tile.label}
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
        ) : (
          /* Their face, filling the middle of the screen. This drew initials and nothing else
             whatever the person had set, which on a dark call screen is just an empty ring - the
             thing that made a ringing call look like nothing had happened. Initials remain the
             fallback for somebody who has no photo and for a call link, which has no person behind
             it. */
          peerPhoto ? (
            <Image source={{ uri: peerPhoto }} style={styles.photo} />
          ) : (
            <View style={[styles.photo, styles.photoEmpty, { backgroundColor: colors.primary }]}>
              <Text style={styles.photoText}>{initialsOf(name)}</Text>
            </View>
          )
        )}
      </View>

      {/*
        A call can be connected, publishing and receiving perfectly, and still be silent, because the
        browser is refusing to play audio until a gesture allows it. Both sides being unable to hear
        each other is exactly what that looks like, and nothing on screen used to say so.

        Shown for both sides - whoever is not hearing the other needs it, and either end can be the
        one that was blocked.
      */}
      {!canPlaybackAudio ? (
        <Pressable onPress={enableAudio} style={({ pressed }) => [styles.soundBar, { backgroundColor: colors.warning }, pressed && styles.pressed]}>
          <MaterialIcons name="volume-off" size={18} color="#3A2A05" />
          <Text style={styles.soundText}>Tap to turn on sound — your device is blocking it</Text>
        </Pressable>
      ) : null}

      <View style={styles.footer}>
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
              {/* Sharing a screen is a browser capability - the picker is the browser's - so the
                  button is withheld where it could not do anything rather than shown and inert.
                  Offered on audio calls too: sharing a document is a reason to call someone even
                  when neither side wants to be on camera. */}
              {Platform.OS === "web" ? (
                <Pressable
                  onPress={toggleScreenShare}
                  style={({ pressed }) => [styles.circle, { backgroundColor: screenSharing ? "#10B981" : "#1F2937" }, pressed && styles.pressed]}
                >
                  <MaterialIcons name={screenSharing ? "stop-screen-share" : "screen-share"} size={23} color="#FFFFFF" />
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

        {/*
          TEMPORARY. Remove once calls are confirmed working on a device.
 
          "The call screen is blank" could be five different faults, and they were being diagnosed by
          reading this file and guessing. This prints the state instead: which phase the call is in,
          whether the LiveKit room exists at all, how many other people are in it, whether this side
          actually has a camera track published, and how many the others are publishing. Between them
          those distinguish a call that never started from one that started and has no media to draw,
          which is the difference between fixing the connection and fixing the picture.
 
          `cam` is the switch's own state; `pub` is whether a track exists for it. If `cam=on` and
          `pub=0/0`, the camera was asked for and nothing came back - a permission problem, not a
          rendering one.
        */}
        <Text style={[styles.diagnostics, { color: colors.muted }]} numberOfLines={3}>
          {[
            `phase=${phase}`,
            `room=${room ? "yes" : "no"}`,
            `remote=${remoteCount}`,
            `mic=${micOn ? "on" : "off"}`,
            // Audio tracks are counted separately from video because they answer the question this
            // bug turns on. `aPub=0/1` means the other side is sending sound and this side has
            // nothing to play it with; `aPub=0/0` means nobody is sending any at all, which is a
            // capture problem and a different fix entirely.
            `aPub=${room ? room.localParticipant.audioTrackPublications.size : 0}/${room ? Array.from(room.remoteParticipants.values()).reduce((total, participant) => total + participant.audioTrackPublications.size, 0) : 0}`,
            `vPub=${room ? room.localParticipant.videoTrackPublications.size : 0}/${room ? Array.from(room.remoteParticipants.values()).reduce((total, participant) => total + participant.videoTrackPublications.size, 0) : 0}`,
            `spk=${canPlaybackAudio ? "ok" : "blocked"}`,
            `err=${error ? "yes" : "no"}`,
          ].join("  ")}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * Full screen, opaque, above everything.
   *
   * This was a translucent backdrop with a 380pt card centred in it, so a call covered about a third
   * of the display and the rest was the app showing through behind it. A call is the one thing in a
   * messenger that should take the whole screen.
   */
  screen: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "#0B0B10", zIndex: 50 },
  topBar: { paddingTop: 54, paddingHorizontal: 28, alignItems: "center" },
  name: { fontSize: 21, fontWeight: "800", textAlign: "center" },
  status: { fontSize: 14, fontWeight: "700", marginTop: 6 },
  // Takes every pixel the top bar and footer leave. `minHeight: 0` so a tall video grid is able to
  // shrink inside a flex column instead of pushing the controls off the bottom of the screen.
  stage: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 20, paddingVertical: 18, minHeight: 0 },
  // No fixed size: 42% of the screen's width, so it reads as the subject of the screen on a phone and
  // does not become absurd on a tablet.
  photo: { width: "62%", aspectRatio: 1, borderRadius: 999, maxWidth: 300, maxHeight: 300, alignItems: "center", justifyContent: "center" },
  photoEmpty: {},
  photoText: { color: "#FFFFFF", fontSize: 54, fontWeight: "800" },
  // The grid fills the stage rather than sitting at its natural height, so a video call uses the
  // whole screen instead of a band across the middle of it.
  videos: { width: "100%", height: "100%", gap: 8, justifyContent: "center" },
  videoRow: { flexDirection: "row", gap: 8, flex: 1 },
  // Height comes from the row it is in, so a row of two and a row of three both fill the space given
  // to them and stay sensibly shaped instead of one being stretched thin.
  tile: { flex: 1, borderRadius: 14, overflow: "hidden", backgroundColor: "#111116" },
  tileFiller: { flex: 1 },
  videoSurface: { flex: 1 },
  // Dark chip rather than a plain label, so a name stays readable over whatever the camera shows.
  tileLabel: { position: "absolute", left: 6, bottom: 6, right: 6, fontSize: 10, fontWeight: "700", color: "#FFFFFF", backgroundColor: "rgba(0,0,0,0.45)", borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: "hidden" },
  // Extra padding at the bottom clears the Android navigation bar, which is drawn over the app.
  footer: { paddingHorizontal: 20, paddingBottom: 44, paddingTop: 10, alignItems: "center" },
  error: { fontSize: 12, lineHeight: 17, marginBottom: 12, textAlign: "center" },
  // Monospace so a screenshot is unambiguous about which value is which - a proportional font makes
  // "1" and "l" and "0" and "O" a guess, and this line exists to be read off a screenshot.
  diagnostics: { fontSize: 10, lineHeight: 14, marginTop: 10, textAlign: "center", fontFamily: Platform.OS === "web" ? "monospace" : undefined },
  actions: { flexDirection: "row", gap: 18 },
  circle: { width: 62, height: 62, borderRadius: 31, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.75, transform: [{ scale: 0.96 }] },
  hint: { fontSize: 11, marginTop: 16, fontWeight: "600" },
  soundBar: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, marginHorizontal: 20, paddingVertical: 12, paddingHorizontal: 16, borderRadius: 14 },
  soundText: { color: "#3A2A05", fontSize: 13, fontWeight: "800" },
});
