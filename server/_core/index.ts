import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import fs from "fs";
import path from "path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { registerPhoneAuthRoutes } from "./phoneAuth";
import { registerPasswordAuthRoutes } from "./passwordAuth";
import { registerStorageProxy } from "./storageProxy";
import { registerAvatarRoutes } from "./avatarRoutes";
import { registerMediaRoutes } from "./mediaRoutes";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { sdk } from "./sdk";
import { isRealtimeEnabled, subscribe } from "../realtime";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

export function createApp() {
  const app = express();

  // Enable CORS for all routes - reflect the request origin to support credentials
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.header("Access-Control-Allow-Origin", origin);
    }
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header(
      "Access-Control-Allow-Headers",
      "Origin, X-Requested-With, Content-Type, Accept, Authorization",
    );
    res.header("Access-Control-Allow-Credentials", "true");

    // Handle preflight requests
    if (req.method === "OPTIONS") {
      res.sendStatus(200);
      return;
    }
    next();
  });

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  registerStorageProxy(app);
  registerAvatarRoutes(app);
  registerMediaRoutes(app);
  registerOAuthRoutes(app);
  registerPhoneAuthRoutes(app);
  registerPasswordAuthRoutes(app);

  // `realtime` lets the client decide how to stay current without guessing: a live stream where a
  // single long-running process serves everyone, polling where it does not.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, timestamp: Date.now(), realtime: isRealtimeEnabled() });
  });

  /**
   * Server-Sent Events stream. Events are nudges - "something changed in this conversation" - and
   * the client answers them by refetching, so the payload stays tiny and there is one code path
   * for applying changes whether they arrived by stream or by poll.
   *
   * This has to sit above the static/SPA fallback at the bottom of this function, or a request for
   * it would be answered with index.html.
   */
  app.get("/api/realtime", async (req, res) => {
    if (!isRealtimeEnabled()) {
      res.status(503).json({ error: "Realtime needs a long-running server. Poll instead." });
      return;
    }
    const user = await sdk.authenticateRequest(req).catch(() => null);
    if (!user) {
      res.status(401).json({ error: "Sign in to receive realtime events." });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    // nginx buffers proxied responses unless told otherwise, which would withhold every event
    // until the connection closed - realtime in name only.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // Tells the client the stream is genuinely open, rather than it waiting on a first event.
    res.write(`data: ${JSON.stringify({ type: "ready" })}\n\n`);

    const unsubscribe = subscribe(user.id, res);
    req.on("close", unsubscribe);
    res.on("close", unsubscribe);
  });

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  // Pterodactyl can host the API and the exported Expo web app in one server.
  // Keep API routes above this fallback so they are never served index.html.
  const webDist = path.resolve(process.cwd(), "web-dist");
  if (fs.existsSync(webDist)) {
    app.use(express.static(webDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  return app;
}

async function startServer() {
  const server = createServer(createApp());
  // Event streams are long-lived by design, and Node's default 300s request timeout would cut
  // every one of them mid-conversation. The 25s keep-alive ping is what detects a dead peer.
  server.requestTimeout = 0;
  // Pterodactyl injects the allocated port as SERVER_PORT, not PORT. Without this the app would
  // fall back to 3000 while the panel routes the allocated port, so the server would look like it
  // was running while nothing answered on the address the panel gives you.
  const preferredPort = parseInt(process.env.PORT || process.env.SERVER_PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`[api] server listening on port ${port}`);
  });
}

if (process.env.VERCEL !== "1") {
  startServer().catch(console.error);
}
