import type { PropsWithChildren } from "react";

/**
 * The document shell for the static export. Expo Router renders each route into this, which is
 * why the app's mounted content is passed straight through as `children`.
 *
 * Everything here exists to make the site installable as an app on a phone: the web app
 * manifest, the theme colour, and the Apple equivalents, since iOS ignores WebKit's
 * equivalents of the manifest fields and needs its own meta tags and touch icon.
 */
export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        <title>Varnox Chat</title>

        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#0B0B0F" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/icon-192.png" />

        {/* iOS needs these two to launch full screen rather than in Safari's chrome. */}
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Varnox" />
      </head>
      <body>{children}</body>
    </html>
  );
}
