/**
 * The sound an incoming call makes.
 *
 * There was none. An incoming call was delivered to the app as an overlay with Accept and Decline
 * and nothing else - so a phone sitting on a table showed a silent screen, and the person being
 * called had no way to know it was ringing without looking at it. The caller, meanwhile, watched
 * "Ringing…" with no idea whether anything had arrived.
 *
 * Synthesised rather than shipped as an audio file. A ringtone is two tones and a gap, an asset
 * would have to be bundled for web and for the Android shell's WebView, and a file that fails to
 * load is a ringtone that silently does not ring - which is the bug being fixed.
 *
 * Deliberately not an error if the browser refuses: audio that cannot start is a reason to keep
 * ringing in every other way available, not a reason to stop.
 */

type RingHandle = { stop: () => void };

/** Created once and reused; browsers limit how many an app may create. */
let context: AudioContext | null = null;
/** Everything a ring makes is routed through this, so stopping is one ramp rather than a hunt. */
let master: GainNode | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  try {
    if (!context) context = new Ctor();
    return context;
  } catch {
    // Some WebViews refuse to construct one at all.
    return null;
  }
}

/**
 * One ring: two rising tones then a pause.
 *
 * Shaped like a ring on purpose. A single beep repeated is easy to mistake for a notification, and
 * the whole point is that somebody across the room recognises it as a call.
 */
function ringOnce(ctx: AudioContext, out: GainNode) {
  const now = ctx.currentTime;
  for (const [offset, frequency] of [[0, 640], [0.5, 800]] as const) {
    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    oscillator.connect(envelope);
    envelope.connect(out);
    const start = now + offset;
    // Ramped rather than switched on, because a tone that starts at full volume clicks.
    envelope.gain.setValueAtTime(0.0001, start);
    envelope.gain.exponentialRampToValueAtTime(0.22, start + 0.04);
    envelope.gain.setValueAtTime(0.22, start + 0.28);
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.38);
    oscillator.start(start);
    oscillator.stop(start + 0.4);
  }
}

/** Starts ringing, and returns the way to stop it. Safe to call when audio is unavailable. */
export function startRingtone(): () => void {
  const ctx = audioContext();
  if (!ctx) return () => undefined;

  // A call arrives without any gesture from the person receiving it, so playback may be refused.
  // Resuming is the best available attempt; if it is refused the ring simply stays visual.
  void ctx.resume?.().catch(() => undefined);

  try {
    if (!master) {
      master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
    }
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.setValueAtTime(1, ctx.currentTime);

    ringOnce(ctx, master);
    if (timer) clearInterval(timer);
    // Two rings every three seconds, which is roughly the cadence of a phone.
    timer = setInterval(() => {
      if (master) ringOnce(ctx, master);
    }, 3000);
  } catch {
    return () => undefined;
  }

  return () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Silenced immediately rather than left to finish. Stopping a ring has to be instant - it is
    // what happens when the call is answered.
    try {
      if (master && context) {
        master.gain.cancelScheduledValues(context.currentTime);
        master.gain.setValueAtTime(0.0001, context.currentTime);
      }
    } catch {
      // Nothing left to silence.
    }
  };
}
