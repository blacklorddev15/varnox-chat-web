import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "http";
import type { Response } from "express";

import { publishToUsers, subscribe, subscriberCount } from "../server/realtime";

// Importing the server entry calls startServer() unless the runtime looks serverless, which would
// bind a port as a side effect of the test run. So pretend to be serverless for the import and
// flip the flag per test - `isRealtimeEnabled` reads it live, and the app itself does not care.
process.env.VERCEL = "1";
const { createApp } = await import("../server/_core/index");

/** The bus only ever writes, so this is a faithful stand-in for an express Response. */
function fakeResponse() {
  const written: string[] = [];
  const res = {
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
  } as unknown as Response;
  return { res, written };
}

const servers: Server[] = [];

async function listen(): Promise<string> {
  const server = createServer(createApp());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not bind a test port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("realtime bus", () => {
  it("frames events as SSE and delivers to the named user only", () => {
    const mine = fakeResponse();
    const theirs = fakeResponse();
    const stopMine = subscribe(7, mine.res);
    const stopTheirs = subscribe(8, theirs.res);

    const delivered = publishToUsers([7], { type: "message", conversationId: "direct-1-4" });

    expect(delivered).toBe(1);
    expect(mine.written).toEqual(['data: {"type":"message","conversationId":"direct-1-4"}\n\n']);
    expect(theirs.written).toEqual([]);

    stopMine();
    stopTheirs();
  });

  it("stops delivering after teardown and forgets the user", () => {
    const { res, written } = fakeResponse();
    const stop = subscribe(7, res);
    expect(subscriberCount()).toBe(1);

    stop();
    expect(subscriberCount()).toBe(0);

    // The important half: a closed stream must not keep receiving writes into a dead socket.
    expect(publishToUsers([7], { type: "message" })).toBe(0);
    expect(written).toEqual([]);
  });

  it("keeps serving a user's other streams when one of them throws", () => {
    // A socket that died between the liveness check and the write must not take the batch down.
    const dead = {
      write: () => {
        throw new Error("EPIPE");
      },
    } as unknown as Response;
    const healthy = fakeResponse();
    const stopDead = subscribe(7, dead);
    const stopHealthy = subscribe(7, healthy.res);

    expect(publishToUsers([7], { type: "message" })).toBe(1);
    expect(healthy.written).toHaveLength(1);

    stopDead();
    stopHealthy();
  });

  it("treats publishing to nobody as a no-op", () => {
    expect(publishToUsers([], { type: "message" })).toBe(0);
    expect(publishToUsers([999], { type: "message" })).toBe(0);
  });
});

describe("realtime endpoint", () => {
  it("reports whether this deployment can stream at all", async () => {
    process.env.VERCEL = "0";
    const longRunning = await listen();
    expect(await (await fetch(`${longRunning}/api/health`)).json()).toMatchObject({ ok: true, realtime: true });

    process.env.VERCEL = "1";
    expect(await (await fetch(`${longRunning}/api/health`)).json()).toMatchObject({ ok: true, realtime: false });
  });

  it("refuses an unauthenticated stream with 401", async () => {
    process.env.VERCEL = "0";
    const base = await listen();
    const response = await fetch(`${base}/api/realtime`);
    expect(response.status).toBe(401);
    // And says so as data rather than leaving the client parsing an HTML error page.
    expect(await response.json()).toHaveProperty("error");
  });

  it("answers 503 on a serverless runtime rather than opening a stream that cannot work", async () => {
    // On Vercel each request may hit a different instance, so an in-process bus would deliver
    // events to nobody. Refusing is the honest answer; the client falls back to polling.
    process.env.VERCEL = "1";
    const base = await listen();
    const response = await fetch(`${base}/api/realtime`);
    expect(response.status).toBe(503);
  });
});
