import type { Express, Request, Response } from "express";
import { COOKIE_NAME, ONE_YEAR_MS } from "../../shared/const.js";
import { getSessionCookieOptions } from "./cookies";
import { deviceMetaFrom, sdk } from "./sdk";
import { consumeDeviceLinkCode, getUserById } from "../db";

/**
 * Linking a second device with a short code.
 *
 * This lives beside the other auth routes rather than on the tRPC router because of the one thing it
 * must do that a tRPC route cannot: set the session cookie for the device making the request. The
 * device being linked is by definition not signed in yet, so it cannot call an authenticated
 * mutation to sign itself in.
 *
 * The exchange mirrors password login exactly - same `createSessionToken`, same cookie options, same
 * refusal for a banned account - so a linked device is indistinguishable from one that logged in
 * normally, and stays revocable from the linked devices list.
 */
export function registerDeviceLinkRoutes(app: Express) {
  app.post("/api/auth/device-link/claim", async (req: Request, res: Response) => {
    try {
      // Single use and short lived, enforced in one statement inside consumeDeviceLinkCode so two
      // devices racing the same code cannot both succeed.
      const userId = await consumeDeviceLinkCode(String(req.body?.code ?? ""));
      if (!userId) {
        res.status(400).json({ error: "That code is not valid, has already been used, or has expired." });
        return;
      }

      const user = await getUserById(userId);
      if (!user) {
        res.status(400).json({ error: "That account no longer exists." });
        return;
      }

      // A banned account must not be able to regain access by linking a device, which is why the
      // same check password login performs is repeated here rather than assumed.
      if (user.moderationStatus === "banned") {
        res.status(403).json({ error: `This Varnox account is banned${user.moderationReason ? `: ${user.moderationReason}` : "."}` });
        return;
      }

      const sessionToken = await sdk.createSessionToken(user.openId, {
        name: user.name ?? user.username ?? "Varnox",
        expiresInMs: ONE_YEAR_MS,
        meta: deviceMetaFrom(req),
      });
      res.cookie(COOKIE_NAME, sessionToken, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });

      res.json({ ok: true, user: { id: user.id, openId: user.openId, username: user.username, name: user.name, email: user.email } });
    } catch (error) {
      console.error("[DeviceLink] claim failed:", error);
      res.status(500).json({ error: "Could not link that device" });
    }
  });
}
