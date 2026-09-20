import type { Express, Request, Response } from "express";
import { getMessageMedia, getSticker } from "../db";

/**
 * Attachments larger than this are refused with a clear message. The limit exists because
 * this deployment stores attachment bytes in the database: fine for photos and voice notes,
 * not for video. Configuring object storage raises the ceiling automatically.
 */
export const MAX_DB_MEDIA_BYTES = 4 * 1024 * 1024;

/**
 * Serves chat attachments stored in the database.
 *
 *   GET /api/media/:id  -> attachment bytes, or 404
 */
export function registerMediaRoutes(app: Express) {
  app.get("/api/media/:id", async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: "Invalid media id" });
        return;
      }

      const media = await getMessageMedia(id);
      if (!media) {
        res.status(404).json({ error: "No such attachment" });
        return;
      }

      const bytes = Buffer.from(media.data, "base64");
      res.setHeader("Content-Type", media.mimeType);
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      res.setHeader(
        "Content-Disposition",
        `inline; filename="${(media.fileName ?? "attachment").replace(/"/g, "")}"`,
      );
      res.send(bytes);
    } catch (error) {
      console.error("[Media] failed to serve attachment:", error);
      res.status(500).json({ error: "Could not load attachment" });
    }
  });

  /**
   * Serves a sticker's bytes.
   *
   *   GET /api/sticker/:id -> image bytes, or 404
   *
   * A sticker is addressed by id rather than being inlined into every message that uses it, so a sticker
   * sent in twenty chats is stored once and fetched once per device.
   */
  app.get("/api/sticker/:id", async (req: Request, res: Response) => {
    try {
      const sticker = await getSticker(String(req.params.id));
      if (!sticker) {
        res.status(404).json({ error: "No such sticker" });
        return;
      }
      const bytes = Buffer.from(sticker.data, "base64");
      res.setHeader("Content-Type", sticker.mimeType);
      res.setHeader("Content-Length", String(bytes.length));
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      res.send(bytes);
    } catch (error) {
      console.error("[Media] failed to serve sticker:", error);
      res.status(500).json({ error: "Could not load sticker" });
    }
  });
}
