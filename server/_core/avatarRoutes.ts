import type { Express, Request, Response } from "express";
import { getUserAvatar } from "../db";

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
}
