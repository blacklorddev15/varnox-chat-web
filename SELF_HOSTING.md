# Varnox Chat — self-hosted API (real-time)

Running the API as a long-lived Node process instead of a Vercel function. This is what turns on
**real-time**: the API holds one Server-Sent Events stream open per signed-in client, so messages,
typing indicators and read ticks arrive immediately instead of on a poll.

```text
Your host (one Node process)
  ├── Express API  /api/*
  ├── SSE stream   /api/realtime
  └── Expo web app (web-dist/)
          │
          ▼
      PostgreSQL
```

The same repository still deploys to Vercel. The client asks `/api/health` what it is talking to and
falls back to polling when realtime is unavailable, so you can run both or switch freely.

---

## Why serverless can't do this

Vercel's functions and the SSE model disagree in two ways:

1. **No shared memory.** The event bus is a `Map` inside the process. On Vercel each request may
   land on a different instance, so a message sent on instance A would never reach a client
   streaming from instance B.
2. **A 60s ceiling.** `vercel.json` caps the function at `maxDuration: 60`, so a stream is torn down
   every minute - and a held-open function bills far more than the short polls it replaces.

Neither is a code problem; they are properties of the platform. A long-lived process has neither.

---

## Requirements

- **Node 20+** (22 LTS recommended). The server bundle is emitted as ESM (`.mjs`) so it does not
  depend on Node guessing the module type.
- **PostgreSQL** (the Neon instance you already use is fine).
- **One process only.** See "Do not scale out" below.
- **No `VERCEL` variable.** If `VERCEL=1` is set, the server deliberately will not listen.

---

## Build

```bash
pnpm install --frozen-lockfile
pnpm build:selfhost
```

That produces two things:

| Output | What it is |
|---|---|
| `web-dist/` | the exported Expo web app, served statically by the API |
| `server-dist/index.mjs` | the API bundle |

`pnpm build:selfhost` is the same as `pnpm build:pterodactyl`.

## Environment variables

```text
PORT=3000
NODE_ENV=production
DATABASE_URL=postgresql://user:password@host/db?sslmode=require
JWT_SECRET=replace-with-a-long-random-secret
OWNER_OPEN_ID=blacklorddev
RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM=Varnox Chat <no-reply@your-domain.com>
```

Optional, for SMS verification: `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_BRAND`.

Do **not** set `EXPO_PUBLIC_API_BASE_URL`. The web app and the API share an origin here, and the
client falls back to a relative URL, which is exactly right.

## Migrations

Run once before the first start, and again whenever `drizzle/` gains a migration:

```bash
DATABASE_URL="your-connection-string" pnpm drizzle-kit migrate
```

## Start

```bash
pnpm start
# or explicitly:
NODE_ENV=production node server-dist/index.mjs
```

**Pterodactyl / panel startup command:** `node server-dist/index.mjs`

> If your panel was configured for the old build, its command pointed at `server-dist/index.js`.
> The filename changed to `.mjs` deliberately - the previous `.js` bundle was ES-module syntax in a
> package without `"type": "module"`, which Node 22 only ran by guessing and Node 20 would have
> refused outright. Update the startup command when you deploy.

## Verify

```bash
curl https://your-host/api/health
```

```json
{"ok":true,"timestamp":1789839636563,"realtime":true}
```

`realtime: true` means the stream is available. Then sign in and watch the network tab: there should
be a single long-lived request to `/api/realtime`, and no repeating `/api/trpc/...` polls while it
is open.

---

## Reverse proxy notes

nginx buffers proxied responses by default, which would hold every event until the connection closed
and make real-time a lie. The API already sends `X-Accel-Buffering: no`, but the proxy has to allow
long-lived connections:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
```

SSE is ordinary HTTP - no WebSocket upgrade is needed, so no special proxy configuration beyond the
timeouts.

---

## Do not scale out

The event bus lives inside the process. If you run two instances behind a load balancer, a client
connected to instance 1 will not hear about a message written on instance 2.

- Keep **one** process (`-w 1`, one container, no cluster mode).
- If you ever need more, the bus in `server/realtime.ts` must move to a shared broker (Redis pub/sub
  or Postgres `LISTEN`/`NOTIFY`). The interface is deliberately small - `subscribe` and
  `publishToUsers` - so that swap is contained to one file.

Missed events are not lost messages: every client keeps a **30s safety-net poll** while the stream is
open, so anything that slips past the bus arrives within half a minute.

---

## Android app

The APK wraps the web app, so point it at the new host. In
`varnox-chat-android/java/com/varnox/chat/MainActivity.java`:

```java
static final String START_URL = "https://your-new-host/";
```

Then rebuild with `bash varnox-chat-android/build-apk.sh` (JDK 17 required). The APK's background
notification watcher polls `START_URL`'s API, so it follows automatically.

---

## What changes once this is running

| | Vercel (before) | Self-hosted (after) |
|---|---|---|
| New message latency | up to 2.5s | immediate |
| Typing indicator | up to 4s | immediate |
| Read ticks | up to 8s | immediate |
| Calls ringing | next poll | immediate |
| Requests while idle in a chat | ~24/min | ~2/min (keep-alives) |
| Backgrounded app | 0 | 0 |
