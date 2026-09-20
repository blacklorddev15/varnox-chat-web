/**
 * Tells the Android shell when a call is connected.
 *
 * The shell cannot see a WebRTC connection - from its side this is just a WebView carrying a page -
 * so the page has to say when a call starts and when it ends. While it is live the shell stops
 * pausing its WebView, holds a foreground service so Android does not freeze the process, and keeps
 * the CPU awake. Those three are what let a call survive the app going off screen.
 *
 * A no-op everywhere else. There is no bridge in a browser or on iOS, nothing to signal, and this
 * deliberately does not pretend otherwise - a call in a mobile browser is suspended by the operating
 * system and no page-level code can prevent that.
 *
 * Called on both edges, because the shell is holding real resources: a foreground service and a wake
 * lock that outlive the call if nobody says it has ended would be a battery drain the user cannot
 * see or stop.
 */
export function setNativeCallActive(active: boolean): void {
  const bridge = (globalThis as { VarnoxNotify?: { setCallActive?: (value: string) => void } }).VarnoxNotify;
  if (!bridge || typeof bridge.setCallActive !== "function") return;

  try {
    // A string rather than a boolean: the bridge is declared with String parameters so that both
    // directions of the old WebView API marshal predictably.
    bridge.setCallActive(active ? "1" : "0");
  } catch {
    // Thrown when the WebView is being torn down underneath us. Nothing useful to do, and failing
    // here must never be allowed to affect the call itself.
  }
}
