# Varnox Chat

A messenger: 1:1 chat, groups, statuses, channels and calls. Expo / React Native Web frontend with a
tRPC + Express API and PostgreSQL behind it, wrapped in an Android WebView shell.

```text
app/          screens (Expo Router: tabs, chat, settings, admin)
server/       the API - tRPC routers, data access, SSE bus, auth
shared/       constants and types used by both sides
drizzle/      database schema and migrations
apk/          Android shell source
components/   shared UI
hooks/ lib/   client hooks and helpers
tests/        vitest
```

---

## Environment variables

Both deployments read the same set. Get the values from
**Vercel → your project → Settings → Environment Variables**.

### Needed for the API to work

| Variable | Notes |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. Add `sslmode=require` for hosted providers. |
| `JWT_SECRET` | Signs session tokens, 32+ characters. **Use the same value on every server** — see below. |
| `OWNER_OPEN_ID` | Username of the first account, which gets admin rights. |

### Needed for specific features

| Variable | Notes |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Voice and video calls. The call UI is built end to end but will not connect without all three. |
| `RESEND_API_KEY`, `RESEND_FROM` | Verification and password-reset email. Without the key, those emails are logged instead of sent. `RESEND_FROM` must be on a domain verified in Resend. |
| `VONAGE_API_KEY`, `VONAGE_API_SECRET`, `VONAGE_BRAND` | SMS verification. Without them, phone codes are logged instead of sent. |
| `VITE_APP_ID` | Platform OAuth sign-in only. Password and phone sign-in do not use it. |

### Supplied by the host, do not set these

| Variable | Notes |
|---|---|
| `SERVER_PORT` | Pterodactyl injects the allocated port and the server reads it. `PORT` wins if both are set. |
| `VERCEL` | **Never set this to `1`.** When it is set the server deliberately does not listen, because on Vercel it is loaded as a function rather than owning a port. Symptom: the process runs and nothing answers. |

### Three things that are easy to get wrong

1. **`JWT_SECRET` must match across servers.** Sessions are signed symmetrically, and tokens last a
   year. A server with a different secret rejects every existing token, so everyone is signed out at
   once. Matching values make two deployments interchangeable.
2. **`EXPO_PUBLIC_API_BASE_URL` belongs in the build environment, not a server `.env`.** Expo inlines
   `EXPO_PUBLIC_*` at build time; setting it afterwards changes nothing. It is only needed when the
   frontend and API are on different hosts.
3. **The API must run as one instance.** The realtime event bus lives inside the process, so a second
   instance would deliver events to nobody - the app still works, it just falls back to polling.

### Getting a filled-in file

`.env` and `.env.example` both start with a dot and are hidden by many file managers and panels.
[`env-template.txt`](env-template.txt) holds the same content under a name nothing hides. The server
needs a file named exactly `.env`, in the same directory as `package.json`.

Never commit a filled-in `.env` — it holds your database password. `.gitignore` refuses it.

---

## Running it

### Development

```bash
pnpm install
cp .env.example .env    # then fill it in
pnpm dev
```

### Vercel

The frontend and API deploy together from this repository. `pnpm build:web` produces the static
export; `api/index.ts` serves the API as a function. Realtime is unavailable there and the client
detects that and polls instead.

### Pterodactyl / self-hosted

A long-lived process, which is what makes realtime work.

- [`egg-varnox-chat-api.json`](egg-varnox-chat-api.json) - import through the panel (needs admin).
- [`SELF_HOSTING.md`](SELF_HOSTING.md) - what the panel needs, and the proxy settings SSE depends on.

```bash
pnpm install --frozen-lockfile
pnpm build:selfhost     # web-dist/ + server-dist/index.cjs
pnpm start
```

`server-dist/index.cjs` inlines every dependency, so it runs with no `node_modules` at all. Upload
`package.json`, `server-dist/` and (optionally) `web-dist/`, add `.env`, and start.

### Migrations

Nothing applies them automatically except the egg's install step.

```bash
DATABASE_URL="postgresql://..." pnpm db:push
```

### Checks

```bash
pnpm typecheck
pnpm test
```
