import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

/**
 * The document shell for the static export. Expo Router renders each route into this, which is
 * why the app's mounted content is passed straight through as `children`.
 *
 * ScrollViewStyleReset is not optional. It injects
 *   `#root,body,html{height:100%} body{overflow:hidden} #root{display:flex}`
 * and without it #root has no height, so a bottom tab bar collapses to the top of the viewport
 * instead of sitting at the bottom. It is part of Expo's built-in document shell, so replacing
 * that shell means carrying it over.
 */

/** Matches theme.config.js, so the page does not flash white before the app paints. */
const background = `
html, body { background-color: #F0F2F5; }
@media (prefers-color-scheme: dark) { html, body { background-color: #0B141A; } }
input, textarea { background-color: transparent; }
input:focus, textarea:focus { outline: none; }
`;

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, shrink-to-fit=no" />

        <title>Varnox Chat</title>

        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: background }} />

        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#171717" />
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
