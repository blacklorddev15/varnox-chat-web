import { useEffect, useState } from "react";
import { onlineManager } from "@tanstack/react-query";

import { isOnline } from "@/lib/offline";

/**
 * Whether the device currently has a connection, as a value a component can render from.
 *
 * Subscribes to React Query's `onlineManager` rather than adding a `window.online` listener of its
 * own, so the banner, the disabled send button and the data layer are all reading the same flag.
 * Two listeners would eventually disagree, and the visible symptom of that is a "no connection"
 * banner sitting above a message that just sent successfully.
 *
 * The initial read exists only to avoid a flash of the wrong state on the first render -
 * `subscribe` fires immediately with the current value anyway.
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => isOnline());

  useEffect(() => onlineManager.subscribe((next) => setOnline(next)), []);

  return online;
}
