import type { Express, Request, Response } from "express";
import { getConversationIcon, getUserAvatar } from "../db";

/**
 * Serves a user's profile photo.
 *
 * The image lives in the `userAvatars` table (base64) rather than object storage: this
 * deployment has no BUILT_IN_FORGE_API_* credentials, so the generic upload path
 * (trpc.files.upload -> Forge presign -> S3) cannot work. Avatars are small, change
 * rarely, and are visible to contacts anyway, so serving them from the database behind a
 * cacheable URL keeps profile photos working with no extra service to configure.
 *
 *   GET /api/avatar/:userId  -> image bytes, or 404 when the user has no photo
 */
export function registerAvatarRoutes(app: Express) {
  app.get("/api/avatar/:userId", async (req: Request, res: Response) => {
    try {
      const userId = Number(req.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        res.status(400).json({ error: "Invalid user id" });
        return;
      }

      const avatar = await getUserAvatar(userId);
      if (!avatar) {
        res.status(404).json({ error: "No profile photo" });
        return;
      }

      const bytes = Buffer.from(avatar.data, "base64");
      res.setHeader("Content-Type", avatar.mimeType);
      res.setHeader("Content-Length", String(bytes.length));
      // Public and stable: clients cache it, and the ?v= suffix changes when it is replaced.
      res.setHeader("Cache-Control", "public, max-age=604800");
      res.setHeader("ETag", `"${avatar.updatedAt.getTime()}"`);
      res.send(bytes);
    } catch (error) {
      console.error("[Avatar] failed to serve photo:", error);
      res.status(500).json({ error: "Could not load profile photo" });
    }
  });

  /**
   * Serves a group photo.
   *
   *   GET /api/group-icon/:conversationId  -> image bytes, or 404 when the group has no photo
   *
   * Served the same way as a profile photo and with the same reasoning. Unlike a profile photo there
   * is no membership check here, for the same reason the avatar route has none: the URL is only
   * handed out to members through `conversations.iconVersions`, and adding a session requirement
   * would mean the client could no longer use plain cached <Image> sources on either platform.
   *
   * Cache-Control is short rather than a week, because a group photo is changed far more often than a
   * personal one and there is no cheap way to invalidate an image the client already holds.
   */
  app.get("/api/group-icon/:conversationId", async (req: Request, res: Response) => {
    try {
      const conversationId = String(req.params.conversationId ?? "");
      if (!conversationId || conversationId.length > 64) {
        res.status(400).json({ error: "Invalid conversation id" });
        return;
      }

      const icon = await getConversationIcon(conversationId);
      if (!icon) {
        res.status(404).json({ error: "No group photo" });
        return;
      }

      const bytes = Buffer.from(icon.data, "base64");
      res.setHeader("Content-Type", icon.mimeType);
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "public, max-age=300");
      res.setHeader("ETag", `"${icon.updatedAt.getTime()}"`);
      res.send(bytes);
    } catch (error) {
      console.error("[GroupIcon] failed to serve photo:", error);
      res.status(500).json({ error: "Could not load group photo" });
    }
  });
}
