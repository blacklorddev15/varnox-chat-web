import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Room as LiveKitRoom } from "livekit-client";

import { useAuth } from "@/hooks/use-auth";
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
};

type CallContextValue = {
  phase: CallPhase;
  session: CallSession | null;
  room: LiveKitRoom | null;
  remoteCount: number;
  micOn: boolean;
  cameraOn: boolean;
  elapsed: number;
  error: string | null;
  startCall: (input: { conversationId: string; kind: CallKind; peerName: string }) => Promise<void>;
  joinLink: (input: { room: string; token: string; url: string; peerName: string; kind: CallKind }) => Promise<void>;
  accept: () => Promise<void>;
  decline: () => Promise<void>;
  hangUp: () => void;
  toggleMic: () => void;
  toggleCamera: () => void;
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
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const roomRef = useRef<LiveKitRoom | null>(null);
  const sessionRef = useRef<CallSession | null>(null);
  const phaseRef = useRef<CallPhase>("idle");
  const ringTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

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
      setElapsed(0);
      setPhaseBoth("idle");
    },
    [endCall, setPhaseBoth],
  );

  const connect = useCallback(async (next: CallSession, withCamera: boolean) => {
    const { Room, RoomEvent } = await import("livekit-client");
    const instance = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = instance;
    setRoom(instance);

    instance.on(RoomEvent.ParticipantConnected, () => setRemoteCount(instance.remoteParticipants.size));
    instance.on(RoomEvent.ParticipantDisconnected, () => setRemoteCount(instance.remoteParticipants.size));
    instance.on(RoomEvent.Disconnected, () => {
      // The other side hung up, or the room closed underneath us.
      if (roomRef.current === instance) teardown(false);
    });

    await instance.connect(next.url, next.token);
    await instance.localParticipant.setMicrophoneEnabled(true);
    if (withCamera) {
      await instance.localParticipant.setCameraEnabled(true);
      setCameraOn(true);
    }
    // Browser autoplay policy: audio only starts inside a user gesture, which dialling or
    // answering both are.
    await instance.startAudio().catch(() => undefined);
    setRemoteCount(instance.remoteParticipants.size);

    if (tick.current) clearInterval(tick.current);
    tick.current = setInterval(() => setElapsed((value) => value + 1), 1000);
  }, [teardown]);

  const startCall = useCallback(
    async ({ conversationId, kind, peerName }: { conversationId: string; kind: CallKind; peerName: string }) => {
      if (phaseRef.current !== "idle") return;
      setError(null);
      try {
        const started = await startMutation.mutateAsync({ conversationId, kind });
        const next: CallSession = { callId: started.callId, room: started.room, token: started.token, url: started.url, kind: started.kind === "video" ? "video" : "audio", peerName, conversationId, outgoing: true };
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
      peerName: ringing.conversationTitle ?? "Incoming call",
      conversationId: ringing.conversationId,
      outgoing: false,
    };
    sessionRef.current = next;
    setSession(next);
    setPhaseBoth("ringing-in");
  }, [incoming.data, setPhaseBoth]);

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

  const value: CallContextValue = {
    phase,
    session,
    room,
    remoteCount,
    micOn,
    cameraOn,
    elapsed,
    error,
    startCall,
    joinLink,
    accept,
    decline,
    hangUp,
    toggleMic,
    toggleCamera,
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
