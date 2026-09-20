import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import type { Room as LiveKitRoom } from "livekit-client";

import { useAuth } from "@/hooks/use-auth";
import { setNativeCallActive } from "@/lib/native-call";
import { isOnline, OFFLINE_CALL_MESSAGE } from "@/lib/offline";
import { startRingtone } from "@/lib/ringtone";
import { reportDiagnostic } from "@/lib/diagnostics";
import { trpc } from "@/lib/trpc";

/**
 * Call state that outlives the screen that started it.
 *
 * Mounted once in the root layout, so leaving a conversation, opening another tab or pushing a
 * new route does not drop the call. The LiveKit client is imported lazily inside connect(), so
 * the ~200 KB SDK is only fetched when someone actually calls or answers.
 */

export type CallKind = "audio" | "video";
export type CallPhase = "idle" | "ringing-out" | "ringing-in" | "active";

export type CallSession = {
  callId: string | null;
  room: string;
  token: string;
  url: string;
  kind: CallKind;
  peerName: string;
  conversationId: string | null;
  outgoing: boolean;
  /**
   * Who is on the other end, so the call screen can show their face rather than a blank circle.
   *
   * `peerName` was already here and the name was never the problem - the picture was, because
   * nothing carried the id needed to fetch one. Absent for a call link, which has no person behind
   * it, and the overlay falls back to initials there.
   */
  peerId?: number | null;
  avatarUpdatedAt?: string | Date | null;
};

type CallContextValue = {
  phase: CallPhase;
  session: CallSession | null;
  room: LiveKitRoom | null;
  remoteCount: number;
  micOn: boolean;
  cameraOn: boolean;
  /** True while this device is sharing its screen into the call. */
  screenSharing: boolean;
  /** True while the transport is being rebuilt. The call is still up; it is catching up. */
  reconnecting: boolean;
  elapsed: number;
  error: string | null;
  /** False when the browser has blocked audio playback and needs a tap before it will start. */
  canPlaybackAudio: boolean;
  /** Retry playback from a fresh user gesture - the only thing that unblocks it. */
  enableAudio: () => void;
  startCall: (input: { conversationId: string; kind: CallKind; peerName: string; peerId?: number | null; avatarUpdatedAt?: string | Date | null }) => Promise<void>;
  joinLink: (input: { room: string; token: string; url: string; peerName: string; kind: CallKind }) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  hangUp: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
  toggleScreenShare: () => void;
  clearError: () => void;
};

const CallContext = createContext<CallContextValue | null>(null);

/** Rings for this long before giving up on the other side. */
const RING_TIMEOUT_MS = 45_000;

export function CallProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();

  const [phase, setPhase] = useState<CallPhase>("idle");
  const [session, setSession] = useState<CallSession | null>(null);
  const [room, setRoom] = useState<LiveKitRoom | null>(null);
  const [remoteCount, setRemoteCount] = useState(0);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(false);
  const [screenSharing, setScreenSharing] = useState(false);
  /** True while the transport is being rebuilt. The call is not over; it is catching up. */
  const [reconnecting, setReconnecting] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /**
   * Whether the browser is actually allowed to play the call's audio.
   *
   * Starts true so the prompt never flashes on a call that was fine, and is corrected by connect()
   * and by LiveKit's own status event. A call can be connected, publishing and receiving perfectly
   * and still be silent - this is the only thing that can tell the difference.
   */
  const [canPlaybackAudio, setCanPlaybackAudio] = useState(true);

  const roomRef = useRef<LiveKitRoom | null>(null);
  // Mirrors screenSharing so the toggle can read the current value without depending on it, which
  // would rebuild the callback on every change.
  const screenShareRef = useRef(false);
  const sessionRef = useRef<CallSession | null>(null);
  const phaseRef = useRef<CallPhase>("idle");
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);
  const notificationRef = useRef<Notification | null>(null);

  const setPhaseBoth = useCallback((next: CallPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const startMutation = trpc.calls.start.useMutation();
  const answerMutation = trpc.calls.answer.useMutation();
  const declineMutation = trpc.calls.decline.useMutation();
  const endMutation = trpc.calls.end.useMutation();
  const endCall = endMutation.mutate;

  const teardown = useCallback(
    (notifyServer: boolean) => {
      if (ringTimer.current) clearTimeout(ringTimer.current);
      if (tick.current) clearInterval(tick.current);
      ringTimer.current = null;
      tick.current = null;

      const active = roomRef.current;
      roomRef.current = null;
      if (active) void active.disconnect().catch(() => undefined);

      const current = sessionRef.current;
      if (notifyServer && current?.callId) endCall({ callId: current.callId });

      sessionRef.current = null;
      setRoom(null);
      setSession(null);
      setRemoteCount(0);
      setMicOn(true);
      setCameraOn(false);
      // A share belongs to one call: the browser stops capturing when the room closes, so leaving
      // this set would show the button as pressed on the next call while nothing was being sent.
      setScreenSharing(false);
      screenShareRef.current = false;
      // A fresh call starts connected or not; a leftover flag would show "Reconnecting" on a call
      // that has not begun.
      setReconnecting(false);
      setElapsed(0);
      setPhaseBoth("idle");
    },
    [endCall, setPhaseBoth],
  );

  /**
   * Ask the browser to start playing the remote audio, and report whether it agreed.
   *
   * `room.canPlaybackAudio` is the authoritative answer, not the absence of a thrown error: the call
   * can resolve and still not be playing. Never swallowed here, because the difference between "the
   * call is silent" and "the call is working" is not something to leave to a `.catch`.
   */
  const tryStartAudio = async (instance: LiveKitRoom): Promise<boolean> => {
    try {
      await instance.startAudio();
    } catch {
      // Refused, most often for want of a user gesture. The status below is the real answer.
    }
    return instance.canPlaybackAudio;
  };

  const connect = useCallback(async (next: CallSession, withCamera: boolean) => {
    const { Room, RoomEvent } = await import("livekit-client");
    const instance = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = instance;
    setRoom(instance);

    // Playback can be blocked after connecting too - a call that starts silent and is unlocked later,
    // or one that loses the ability when the page is backgrounded. This is what keeps the screen's
    // "tap for sound" state honest rather than a guess made once at connect time.
    instance.on(RoomEvent.AudioPlaybackStatusChanged, () => setCanPlaybackAudio(instance.canPlaybackAudio));

    /**
     * Somebody else appearing in the room is what "answered" looks like from the caller's side.
     *
     * This is where an outgoing call turns into a live one, and it has to be here rather than at the
     * end of startCall. connect() resolves as soon as *this* side is in the room, which is
     * immediately - long before the other phone is picked up. Promoting there would replace
     * "Ringing…" with "Connecting…" for as long as it rang. Promoting on the participant arriving
     * keeps "Ringing…" while it rings and switches the moment somebody joins.
     */
    const promoteOnAnswer = () => {
      const others = instance.remoteParticipants.size;
      setRemoteCount(others);
      // Somebody has to actually be there. This is called once after connecting as well, to cover a
      // room that already had people in it, and without the count it promoted every outgoing call to
      // "active" the instant it connected - replacing "Ringing…" with "Connecting…" and hiding that
      // nobody had picked up, which is precisely what the caller needs to see while they wait.
      if (others === 0) return;

      // Somebody is here, so this is no longer a ringing call - and the ring timeout must go with
      // that, because what it does is hang up.
      //
      // It was left armed. startCall sets a 45 second timer to abandon an unanswered call, and
      // nothing cancelled it when the call was answered, so a call picked up at 40 seconds was torn
      // down at 45 - the caller's side closing itself mid-conversation. From the other end that is a
      // person who answers, connects, and then finds nobody there and no sound, which is exactly the
      // report: answered, and could not hear anybody.
      if (ringTimer.current) clearTimeout(ringTimer.current);
      ringTimer.current = null;

      if (phaseRef.current === "ringing-out") setPhaseBoth("active");
    };
    instance.on(RoomEvent.ParticipantConnected, promoteOnAnswer);
    // Deliberately not the same handler: somebody else leaving does not make this side stop being a
    // live call, and demoting on it would hide the video and the timer mid-conversation.
    instance.on(RoomEvent.ParticipantDisconnected, () => setRemoteCount(instance.remoteParticipants.size));
    instance.on(RoomEvent.Disconnected, () => {
      // The other side hung up, or the room closed underneath us.
      if (roomRef.current === instance) teardown(false);
    });
    // LiveKit rebuilds the transport itself when the network blips - which is exactly what a phone
    // changing between wifi and mobile data, or waking from sleep, looks like. These two only
    // reflect that so a brief drop reads as "Reconnecting" instead of a call that has frozen.
    // `Disconnected` above is the one that means it is genuinely over, and remains the only thing
    // that tears a call down.
    instance.on(RoomEvent.Reconnecting, () => setReconnecting(true));
    instance.on(RoomEvent.Reconnected, () => {
      setReconnecting(false);
      // Whoever is left, in case anyone dropped while the transport was being rebuilt.
      setRemoteCount(instance.remoteParticipants.size);
    });

    await instance.connect(next.url, next.token);

    // Audio playback first, before anything else that awaits.
    //
    // It has to happen inside the browser's transient user activation, which is what dialling or
    // answering provides - but that window is a few seconds, and the microphone and camera below
    // each wait on a permission dialog and a device. Doing them first spent the window, and a
    // startAudio() that arrives outside it is refused by both Chrome and the Android WebView.
    //
    // That refusal was the whole "neither of us can hear the other" report. Both sides were
    // publishing sound; neither was allowed to play it, and the failure was being discarded by a
    // `.catch(() => undefined)` so nothing said so. The status is kept instead, and the call screen
    // offers a button to start it on a fresh gesture when it is still blocked.
    const playback = await tryStartAudio(instance);
    setCanPlaybackAudio(playback);

    // Neither of these is allowed to end the call.
    //
    // Both used to be awaited bare, so a refusal - no permission, no device, a WebView that will not
    // hand one over - threw out of connect() and straight into the caller's catch, which tears the
    // whole call down. A video call that could not open the camera therefore failed even though the
    // audio was fine and both people were already in the room, and the report was simply that the
    // call did not connect.
    //
    // A call that connects with one of them missing is worth having; a call that disappears because
    // of a camera permission is not. What failed is visible on the call screen either way - the
    // microphone and camera buttons show their own state, and `mic=`/`aPub=` in the diagnostics line
    // say whether a track was actually published.
    try {
      await instance.localParticipant.setMicrophoneEnabled(true);
      setMicOn(true);
    } catch (cause) {
      setMicOn(false);
      reportDiagnostic("call-mic", String(cause instanceof Error ? cause.message : cause));
    }
    if (withCamera) {
      try {
        await instance.localParticipant.setCameraEnabled(true);
        setCameraOn(true);
      } catch (cause) {
        setCameraOn(false);
        reportDiagnostic("call-camera", String(cause instanceof Error ? cause.message : cause));
      }
    }
    // They may already have been in the room - a link join, or a call placed into a room that
    // already had somebody in it - in which case no ParticipantConnected fires for them and the
    // phase would sit at "ringing-out" with the video hidden for the whole call.
    promoteOnAnswer();

    if (tick.current) clearInterval(tick.current);
    tick.current = setInterval(() => setElapsed((value) => value + 1), 1000);
  }, [setPhaseBoth, teardown]);

  const startCall = useCallback(
    async ({ conversationId, kind, peerName, peerId, avatarUpdatedAt }: { conversationId: string; kind: CallKind; peerName: string; peerId?: number | null; avatarUpdatedAt?: string | Date | null }) => {
      if (phaseRef.current !== "idle") return;
      // Refused before the mutation is fired, not after. React Query pauses a mutation while offline
      // rather than failing it, so `mutateAsync` below would never settle and the ring timer below it
      // would never be armed - a call button that hangs with no explanation. The screens that offer
      // the button say why; this is the backstop for a path that forgets to.
      if (!isOnline()) {
        setError(OFFLINE_CALL_MESSAGE);
        return;
      }
      setError(null);
      try {
        const started = await startMutation.mutateAsync({ conversationId, kind });
        const next: CallSession = { callId: started.callId, room: started.room, token: started.token, url: started.url, kind: started.kind === "video" ? "video" : "audio", peerName, conversationId, outgoing: true, peerId: peerId ?? null, avatarUpdatedAt: avatarUpdatedAt ?? null };
        sessionRef.current = next;
        setSession(next);
        setPhaseBoth("ringing-out");
        await connect(next, kind === "video");
        // Whoever is called has a minute to pick up before we stop ringing.
        ringTimer.current = setTimeout(() => teardown(true), RING_TIMEOUT_MS);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not start the call.");
        teardown(false);
      }
    },
    [connect, setPhaseBoth, startMutation, teardown],
  );

  const joinLink = useCallback(
    async ({ room: roomName, token, url, peerName, kind }: { room: string; token: string; url: string; peerName: string; kind: CallKind }) => {
      if (phaseRef.current !== "idle") return;
      // A link can be opened from anywhere, including a place with no signal, and joining a LiveKit
      // room with no transport produces a call screen that sits at "Connecting…" indefinitely.
      if (!isOnline()) {
        setError(OFFLINE_CALL_MESSAGE);
        return;
      }
      setError(null);
      const next: CallSession = { callId: null, room: roomName, token, url, kind, peerName, conversationId: null, outgoing: true };
      sessionRef.current = next;
      setSession(next);
      setPhaseBoth("active");
      try {
        await connect(next, kind === "video");
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not join that call.");
        teardown(false);
      }
    },
    [connect, setPhaseBoth, teardown],
  );

  const accept = useCallback(async () => {
    const current = sessionRef.current;
    if (!current?.callId) return;
    // Answering is a write like any other: without a connection the answer never reaches the caller,
    // who keeps ringing while this side shows a call that is not connected to anything.
    if (!isOnline()) {
      setError(OFFLINE_CALL_MESSAGE);
      return;
    }
    setError(null);
    try {
      const answered = await answerMutation.mutateAsync({ callId: current.callId });
      const next: CallSession = { ...current, room: answered.room, token: answered.token, url: answered.url, kind: answered.kind === "video" ? "video" : "audio", outgoing: false };
      sessionRef.current = next;
      setSession(next);
      setPhaseBoth("active");
      await connect(next, answered.kind === "video");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not answer the call.");
      teardown(false);
    }
  }, [answerMutation, connect, setPhaseBoth, teardown]);

  const decline = useCallback(async () => {
    const current = sessionRef.current;
    if (current?.callId) declineMutation.mutate({ callId: current.callId });
    teardown(false);
  }, [declineMutation, teardown]);

  /**
   * Tells the Android shell when a call becomes live, and when it stops being live.
   *
   * Keyed on `phase` because that is the only thing that knows: the shell sees a WebView, not a
   * connection. The cleanup runs both on the next phase change and on unmount, so every path out of
   * a call - hanging up, the other side leaving, the screen closing - releases the foreground
   * service and the wake lock the shell is holding.
   */
  useEffect(() => {
    setNativeCallActive(phase === "active");
    return () => setNativeCallActive(false);
  }, [phase]);

  const hangUp = useCallback(() => teardown(true), [teardown]);

  const toggleMic = useCallback(() => {
    const instance = roomRef.current;
    if (!instance) return;
    setMicOn((on) => {
      void instance.localParticipant.setMicrophoneEnabled(!on).catch(() => undefined);
      return !on;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    const instance = roomRef.current;
    if (!instance) return;
    setCameraOn((on) => {
      void instance.localParticipant.setCameraEnabled(!on).catch(() => undefined);
      return !on;
    });
  }, []);

  /**
   * Shares this device's screen into the call.
   *
   * Unlike the mic and camera toggles this cannot be fire-and-forget: the browser shows a picker,
   * and the user may cancel it. The state is therefore set optimistically and put back when the
   * promise rejects, so cancelling the picker does not leave the button stuck looking pressed.
   *
   * The room is unaffected either way - a share is an extra video track, so a call that was audio
   * only stays audio only and simply gains a picture.
   */
  const toggleScreenShare = useCallback(() => {
    const instance = roomRef.current;
    if (!instance) return;

    // Read from the ref rather than from state: reading state here would either need it in the
    // dependency list, or would read a stale value from the closure.
    const next = !screenShareRef.current;
    screenShareRef.current = next;
    setScreenSharing(next);

    void instance.localParticipant
      .setScreenShareEnabled(next)
      .then(() => undefined)
      .catch(() => {
        // Cancelled at the picker, or the browser refused. Either way nothing is being sent.
        screenShareRef.current = !next;
        setScreenSharing(!next);
      });
  }, []);

  /**
   * TEMPORARY. Remove once calls are confirmed working on a device.
   *
   * Report the call's state to the server log as it changes, so a call placed on a phone can be
   * diagnosed without a screenshot. Reported on every phase change, and once more five seconds into
   * a live call - tracks take a moment to publish, and the first report would say `pub=0/0` for a
   * call that was about to work perfectly.
   */
  const diagMutation = trpc.calls.diag.useMutation();
  // Read through a ref so the report always carries the current playback status. `reportDiag` itself
  // is captured into a ref that is refreshed every render, but the closure inside it would otherwise
  // keep whatever `canPlaybackAudio` was at the time it was defined.
  const canPlaybackAudioRef = useRef(canPlaybackAudio);
  canPlaybackAudioRef.current = canPlaybackAudio;
  const reportDiag = useCallback(() => {
    const snapshot = [
      `phase=${phaseRef.current}`,
      `room=${roomRef.current ? "yes" : "no"}`,
      `remote=${roomRef.current?.remoteParticipants.size ?? 0}`,
      `mic=${roomRef.current?.localParticipant.isMicrophoneEnabled ? "on" : "off"}`,
      `cam=${roomRef.current?.localParticipant.isCameraEnabled ? "on" : "off"}`,
      // Both kinds of track, counted separately. The audible-either-way report comes down to which
      // of these is zero, and they point at opposite fixes.
      `aPub=${roomRef.current?.localParticipant.audioTrackPublications.size ?? 0}/${roomRef.current ? Array.from(roomRef.current.remoteParticipants.values()).reduce((total, participant) => total + participant.audioTrackPublications.size, 0) : 0}`,
      `vPub=${roomRef.current?.localParticipant.videoTrackPublications.size ?? 0}/${roomRef.current ? Array.from(roomRef.current.remoteParticipants.values()).reduce((total, participant) => total + participant.videoTrackPublications.size, 0) : 0}`,
      `spk=${canPlaybackAudioRef.current ? "ok" : "blocked"}`,
      `plat=${Platform.OS}`,
    ].join(" ");
    diagMutation.mutate({ snapshot });
  }, [diagMutation]);
  const reportDiagOnce = useRef(reportDiag);
  reportDiagOnce.current = reportDiag;

  useEffect(() => {
    if (!isAuthenticated || phase === "idle") return;
    reportDiagOnce.current();
    if (phase !== "active") return;
    const settled = setTimeout(() => reportDiagOnce.current(), 5000);
    return () => clearTimeout(settled);
    // `canPlaybackAudio` is in here because a call being silent is the fault being chased. That it
    // changes at all is the interesting event, and it is the one a later report has to carry.
  }, [isAuthenticated, phase, canPlaybackAudio]);

  // Poll for an incoming call only while idle, so we never ring over a live call.
  const incoming = trpc.calls.incoming.useQuery(undefined, {
    enabled: isAuthenticated && phase === "idle" && !error,
    refetchInterval: phase === "idle" ? 4000 : false,
  });

  useEffect(() => {
    const ringing = incoming.data;
    if (!ringing || phaseRef.current !== "idle" || sessionRef.current) return;
    const next: CallSession = {
      callId: ringing.id,
      room: "",
      token: "",
      url: "",
      kind: ringing.kind === "video" ? "video" : "audio",
      // The person first, then the conversation: a one-to-one has no title, so using the title
      // alone showed "Incoming call" for somebody whose name we know perfectly well.
      peerName: ringing.callerName ?? ringing.conversationTitle ?? ringing.callerUsername ?? "Incoming call",
      conversationId: ringing.conversationId,
      outgoing: false,
      peerId: ringing.initiatorId,
      avatarUpdatedAt: ringing.callerAvatarUpdatedAt,
    };
    sessionRef.current = next;
    setSession(next);
    setPhaseBoth("ringing-in");
  }, [incoming.data, setPhaseBoth]);

  // While the app is hidden the ringing overlay is invisible, so the call has to surface
  // outside the page. The Android shell maps window.Notification onto NotificationManager and
  // taps reopen the app, where the overlay is already ringing - so answering from the
  // background needs no native change. The tag is fixed so a new call replaces the old alert
  // rather than stacking, since the native bridge has no way to cancel one.
  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    if (!("Notification" in window)) return;

    const clear = () => {
      const posted = notificationRef.current;
      notificationRef.current = null;
      try {
        posted?.close();
      } catch {
        // the bridge has no cancel; the ring is simply replaced by the next one
      }
    };

    if (phase !== "ringing-in" || !session) {
      clear();
      return;
    }

    const post = () => {
      if (notificationRef.current) return;
      if (document.visibilityState !== "hidden") return;
      try {
        if (window.Notification.permission !== "granted") return;
        const alert = new window.Notification(`Incoming ${session.kind === "video" ? "video" : "voice"} call`, { body: session.peerName, tag: "varnox-incoming-call" });
        alert.onclick = () => {
          try {
            window.focus();
          } catch {
            // the shell has already brought the activity forward
          }
          alert.close();
          notificationRef.current = null;
        };
        notificationRef.current = alert;
        try {
          navigator.vibrate?.([300, 150, 300]);
        } catch {
          // no VIBRATE permission yet; harmless
        }
      } catch {
        // a failed alert must never take a call down
      }
    };

    post();
    // The call can also arrive while the app is visible and then be backgrounded mid-ring.
    document.addEventListener("visibilitychange", post);
    return () => {
      document.removeEventListener("visibilitychange", post);
      clear();
    };
  }, [phase, session]);

  /**
   * Ring, and buzz, while an incoming call is arriving.
   *
   * Separate from the notification above, and deliberately not conditional on the page being hidden.
   * That notification is a system alert for a call that arrived while the app was elsewhere; this is
   * the ring itself, and a call arriving on a phone sitting on a table is exactly the case that used
   * to be silent - the overlay appeared with Accept and Decline and made no sound at all, so nobody
   * looked, and the caller watched "Ringing…" with no way to tell whether anything had arrived.
   *
   * It starts on the transition into "ringing-in" and stops on the way out of it, which covers both
   * answering and declining, and a caller who hangs up first.
   */
  useEffect(() => {
    if (phase !== "ringing-in" || !session) return;
    const stopRinging = startRingtone();

    // Repeats, because one buzz is over before anybody notices it. Needs the VIBRATE permission in
    // the Android shell, which it does not have yet - so this works on the web build and is
    // harmless in the app until the APK is rebuilt.
    const buzz = () => {
      try {
        navigator.vibrate?.(400);
      } catch {
        // No motor, or no permission. The ring still sounds.
      }
    };
    buzz();
    const buzzTimer = setInterval(buzz, 3000);

    return () => {
      clearInterval(buzzTimer);
      stopRinging();
    };
  }, [phase, session]);

  // Tell the Android shell when a call is running. It holds a wake lock so audio survives the
  // screen going off, and promotes its foreground service so Android 14+ will let it keep the
  // microphone. Re-runs on every phase change on purpose: if the promotion is refused while
  // the app is backgrounded, answering brings it forward and the next transition retries.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const bridge = (window as unknown as { __varnoxCall?: { setActive: (active: boolean) => void } }).__varnoxCall;
    if (!bridge) return;
    try {
      bridge.setActive(phase !== "idle");
    } catch {
      // native refused the promotion; the call itself is unaffected
    }
  }, [phase]);

  // Leaving the app entirely (web tab closed) should not leave a ringing call behind.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onUnload = () => {
      const current = sessionRef.current;
      if (current?.callId) void endMutation.mutateAsync({ callId: current.callId }).catch(() => undefined);
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, [endMutation]);

  /**
   * Retry audio playback from a tap on the call screen.
   *
   * The tap is the entire point: a blocked playback is only unblocked by a fresh user gesture, so
   * this cannot be retried on a timer or from an effect. Synchronous start, no awaits before the
   * call to `startAudio`, or the gesture is spent before it is used.
   */
  const enableAudio = useCallback(() => {
    const instance = roomRef.current;
    if (!instance) return;
    void tryStartAudio(instance).then(setCanPlaybackAudio);
  }, []);

  const value: CallContextValue = {
    phase,
    session,
    room,
    remoteCount,
    micOn,
    cameraOn,
    screenSharing,
    reconnecting,
    canPlaybackAudio,
    enableAudio,
    elapsed,
    error,
    startCall,
    joinLink,
    accept,
    decline,
    hangUp,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    clearError: () => setError(null),
  };

  return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall(): CallContextValue {
  const context = useContext(CallContext);
  if (!context) throw new Error("useCall must be used inside CallProvider");
  return context;
}

/** mm:ss for the in-call timer. */
export function formatElapsed(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
