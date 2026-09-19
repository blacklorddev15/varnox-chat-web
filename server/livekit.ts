/**
 * LiveKit helpers.
 *
 * Tokens are minted here with `jose`, which the project already depends on, rather than by
 * adding the LiveKit server SDK: the claim shape is small and stable, and this keeps the
 * serverless bundle unchanged. The credentials come from the environment
 * (LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET).
 */
const TOKEN_TTL_SECONDS = 60 * 60;

export function isLiveKitConfigured(): boolean {
  return Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET);
}

export function liveKitUrl(): string {
  return process.env.LIVEKIT_URL ?? "";
}

function requireCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error(
      "Calls are not configured on this server. Set LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET.",
    );
  }
  return { apiKey, apiSecret };
}

/**
 * A room-join token for one participant. `identity` must be unique per participant, so the
 * caller passes the numeric user id rather than a display name.
 */
export async function createRoomToken(
  identity: string,
  displayName: string,
  room: string,
  options: { canPublish?: boolean } = {},
): Promise<string> {
  const { apiKey, apiSecret } = requireCredentials();
  // jose is ESM-only and this bundle is CommonJS, so it is loaded lazily (same reason as sdk.ts).
  const { SignJWT } = await import("jose");
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    name: displayName,
    video: {
      roomJoin: true,
      room,
      canPublish: options.canPublish !== false,
      canSubscribe: true,
      canPublishData: true,
    },
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(apiKey)
    .setSubject(identity)
    .setIssuedAt(now)
    .setNotBefore(now - 10)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .sign(new TextEncoder().encode(apiSecret));
}
