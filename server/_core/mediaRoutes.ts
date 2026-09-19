import type { Express, Request, Response } from "express";
import { getMessageMedia } from "../db";

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
}
