import { useEffect, useRef, useState } from "react";

import { getApiBaseUrl } from "@/constants/oauth";

export type RealtimeEvent = { type: string; conversationId?: string };

type RealtimeState = {
  /** The server can stream events at all (only where one long-running process serves everyone). */
  supported: boolean;
  /** A stream is open right now. */
  live: boolean;
};

/**
 * Subscribes to the server's event stream, when there is one to subscribe to.
 *
 * Two things make this safe to ship against a backend that cannot support it:
 *   - it asks `/api/health` whether the deployment offers realtime before opening anything, so a
 *     serverless deployment does not get hammered with reconnect attempts
 *   - a dropped stream reconnects with exponential backoff, and while it is down the caller keeps
 *     polling, so the worst case is the behaviour that already existed
 *
 * Events are nudges, not state. The handler is expected to refetch, which means a lost event costs
 * a few seconds rather than correctness.
 */
export function useRealtime(onEvent: (event: RealtimeEvent) => void, enabled: boolean): RealtimeState {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

  const [supported, setSupported] = useState(false);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setSupported(false);
      return;
    }
    let cancelled = false;
    fetch(`${getApiBaseUrl()}/api/health`, { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (!cancelled) setSupported(Boolean(data?.realtime));
      })
      .catch(() => {
        // An unreachable health check means no stream either; polling covers it.
        if (!cancelled) setSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !supported || typeof EventSource === "undefined") return;

    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let attempt = 0;

    const open = () => {
      if (closed) return;
      source = new EventSource(`${getApiBaseUrl()}/api/realtime`, { withCredentials: true });

      source.onopen = () => {
        attempt = 0;
        setLive(true);
      };

      source.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as RealtimeEvent;
          // The server's opening frame only confirms the stream; there is nothing to refetch yet.
          if (event.type !== "ready") handlerRef.current(event);
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      };

      source.onerror = () => {
        setLive(false);
        source?.close();
        source = null;
        if (closed) return;
        attempt += 1;
        retry = setTimeout(open, Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)));
      };
    };

    open();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [enabled, supported]);

  return { supported, live };
}
