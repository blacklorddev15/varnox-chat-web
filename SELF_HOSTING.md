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
| `server-dist/index.cjs` | the API bundle, with every dependency inlined |

`pnpm build:selfhost` is the same as `pnpm build:pterodactyl`.

### The bundle has no dependencies

`server-dist/index.cjs` inlines express, pg, drizzle and the rest into one ~2.6 MB file, so the
server runs with **no `node_modules` directory at all**. That matters on a panel where you have no
admin rights: you can upload three things and start, without an install step or a build.

Why CommonJS rather than the ES module it used to be: several dependencies call `require()` for Node
builtins at runtime, and an ES module bundle cannot shim that - it dies at boot with
`Dynamic require of "fs" is not supported`. CommonJS has `require` natively.

### Upload-only deployment (no admin, no install)

If your server's startup command is `npm start`, it runs the `start` script from `package.json`,
which points at this bundle. Nothing else is needed.

1. Upload to the server root, keeping the paths:

   ```text
   package.json               (or just a package.json containing the start script)
   server-dist/index.cjs
   web-dist/                  (only if you want this server to render the site)
   ```

2. If the panel gives you no `DATABASE_URL` variable, upload a `.env` file beside them - the server
   loads `dotenv/config`, and that is where the secrets come from.
3. Start the server.

`SERVER_PORT` is provided by the panel automatically, so nothing needs configuring for the port.

Migrations are the one thing that still needs a full install (`drizzle-kit` is a dev dependency), so
run `pnpm db:push` from a machine that has the repo, against the same `DATABASE_URL`. The server also
applies pending migrations itself on boot, so this is only needed when that step fails.

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
NODE_ENV=production node server-dist/index.cjs
```

**Pterodactyl / panel startup command:** `node server-dist/index.cjs`

> If your panel was configured for the old build, its command pointed at `server-dist/index.js`.
> The filename changed to `.mjs` deliberately - the previous `.js` bundle was ES-module syntax in a
> package without `"type": "module"`, which Node 22 only ran by guessing and Node 20 would have
> refused outright. Update the startup command when you deploy.

## Pterodactyl panel

One server hosts **both** the rendered web app and the API. They are the same process on the same
port, so do not create a second server or split them.

**Startup command** (egg → Startup tab):

```text
node server-dist/index.cjs
```

The allocated port is read from `SERVER_PORT`, which is the variable the panel injects. Being
explicit works too:

```text
PORT={{SERVER_PORT}} node server-dist/index.cjs
```

> If the app binds anything other than the server's allocation, the panel's `IP:port` answers
> nothing even though the console says it started. `PORT` wins when both are set.

**Egg / image requirements**

| | |
|---|---|
| Node | 20+ (22 LTS recommended) - the bundle is ESM (`.mjs`) |
| pnpm | the image must provide it, else `npm install -g pnpm` (or `corepack enable`) once |
| RAM | 512 MB is comfortable for a small team; each signed-in client holds one SSE connection |
| Instance | exactly one |

**Upload and install**

Extract `varnox-pterodactyl-selfhost.zip` in the server root through the panel file manager, then:

```bash
pnpm install --frozen-lockfile
```

The archive ships `web-dist/` and `server-dist/` prebuilt, so the panel never runs Metro.

**Why one server is enough:** API routes are registered before the static handler, and the SPA
fallback explicitly skips `/api/`, so an API request can never be answered with `index.html`.
Verified on a running build - `/` returns the app HTML and `/api/health` returns JSON, same port.

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

---

## Split deployment: frontend on Vercel, API here

Both hosts must sit under the **same registrable domain**:

```text
app.yourdomain.com  ->  Vercel          (renders the web app)
api.yourdomain.com  ->  this server     (behind a TLS proxy)
```

### Why the domains have to match

The session cookie is `SameSite=Lax`. Those two hostnames are different origins but the *same
site*, so the cookie is sent and everything works unchanged. Put the API on a different registrable
domain - or a bare `IP:port` - and the cookie is dropped:

- Ordinary API calls still work: the client also sends a `Bearer` token from `localStorage`, and the
  server prefers that over the cookie.
- **The event stream does not.** `EventSource` cannot set an `Authorization` header, so it would
  401, back off, and silently fall back to polling - you would keep the split and lose the real-time
  you self-hosted for.

### Steps

1. **DNS**
   - `app` → CNAME `cname.vercel-dns.com`
   - `api` → A / CNAME to your node
2. **Vercel** → project → Settings → Domains: add `app.yourdomain.com`.
3. **Vercel** → Environment Variables: `EXPO_PUBLIC_API_BASE_URL=https://api.yourdomain.com` for
   Production, then **redeploy**. Expo inlines `EXPO_PUBLIC_*` at build time, so setting it without
   a rebuild changes nothing.
4. **TLS on the API host.** The frontend is HTTPS, so a plain HTTP `IP:port` will be blocked by the
   browser as mixed content. Terminate TLS for `api.yourdomain.com` and proxy to the allocated port,
   forwarding `Host` and `X-Forwarded-Proto: https` (the `Secure` flag on the session cookie is
   derived from that header - no `trust proxy` setting is needed).
5. Leave `PORT` / `SERVER_PORT` and the startup command as documented above.

CORS needs no configuration: the server reflects the request origin, allows the `Authorization`
header, and answers the preflight.

### Notes

- **The API host still renders the app too.** `web-dist/` is served by the same process, so
  `https://api.yourdomain.com` is also a working copy. Harmless, and a useful fallback - delete
  `web-dist/` from the panel if you would rather it did not.
- **Android.** The APK loads the frontend and its background watcher calls the API on that same
  origin, so with the frontend on Vercel the watcher talks to Vercel's API rather than this one. Both
  can run against the same database; if you retire the Vercel API, the watcher needs repointing at
  `api.yourdomain.com` as well.
- **Signing out on storage clear.** Cross-origin means no cookie is stored for the frontend's own
  origin, so clearing site data signs the user out until they sign in again.
