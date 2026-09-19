# Varnox Chat — Vercel + Neon Only

This deployment runs the complete web application on Vercel:

```text
Vercel
  ├── Expo web frontend
  └── Serverless Express/tRPC API
          │
          ▼
      Neon PostgreSQL
```

No Pterodactyl, Render, or separate API server is required.

## Vercel project settings

Import this repository into Vercel and use:

- Framework preset: **Other**
- Install command: `pnpm install --frozen-lockfile`
- Build command: `pnpm build:web`
- Output directory: `dist`

The API function is `api/index.ts`. `vercel.json` routes `/api/*` requests to that function and routes the remaining paths to the Expo web app.

## Vercel environment variables

Add these variables in the Vercel project settings. Use **Production**, **Preview**, or both as needed:

```text
DATABASE_URL=postgresql://user:password@ep-example-pooler.region.aws.neon.tech/neondb?sslmode=require
JWT_SECRET=replace-with-a-long-random-secret
OWNER_OPEN_ID=blacklorddev
RESEND_API_KEY=re_xxxxxxxxx
RESEND_FROM=Varnox Chat <no-reply@your-domain.com>
NODE_ENV=production
```

Optional SMS verification variables:

```text
VONAGE_API_KEY=...
VONAGE_API_SECRET=...
```

Do not add `DATABASE_URL`, `JWT_SECRET`, or email credentials as `EXPO_PUBLIC_*` variables. They must remain server-side.

Do not set `EXPO_PUBLIC_API_BASE_URL` for the Vercel-only deployment. The client uses the same-origin Vercel URL automatically when that variable is absent.

## Neon database migration

After configuring `DATABASE_URL`, run the PostgreSQL migration from a trusted local environment:

```bash
pnpm install --frozen-lockfile
DATABASE_URL="your-neon-connection-string" pnpm drizzle-kit migrate
```

The active baseline migration is `drizzle/0000_warm_stingray.sql`.

Vercel deployments should not run migrations automatically on every request. Run migrations once before the first production deployment and again only when a new migration is added.

## Verify the deployment

After deployment, test:

```text
https://your-project.vercel.app/api/health
```

Expected response:

```json
{"ok":true,"timestamp":1234567890}
```

Then open the root Vercel URL and test registration, username/password login, phone/email OTP, support bot, moderation, appeals, and settings.

## Browser notifications

On the web, open the chat menu and choose **Notification setup**, then allow notifications in the browser prompt. While the Vercel tab is open or in the background, the chat polls for new messages and displays a browser notification for incoming messages. Browser notifications require HTTPS, which Vercel provides automatically. If the browser tab is fully closed, background delivery requires a future Web Push service worker and VAPID configuration.

## Native builds

This Vercel deployment is for the browser version. Android and iOS builds still use Expo/EAS and should use the deployed Vercel URL or API configuration as appropriate.
