# VARNOX Android shell

The Android app is a WebView container around https://varnox-chat-web.vercel.app — it is not a
separate application, so most changes ship by deploying the website. This folder exists so the
container itself (permissions, notification bridge, icon, build script) is version-controlled
rather than living in someone's sandbox.

## What is here

| Path | Purpose |
|---|---|
| `AndroidManifest.xml` | Permissions, launcher activity, the foreground service, version code/name |
| `java/com/varnox/chat/MainActivity.java` | WebView setup, external-link handling, file picker, mic/camera grants, notification permission |
| `java/com/varnox/chat/NativeBridge.java` | The `VarnoxNative` object the page talks to (validated against the loaded host) |
| `java/com/varnox/chat/VarnoxNotifications.java` | Notification channels, message alerts, the connection notice |
| `java/com/varnox/chat/VarnoxConnectionService.java` | Foreground service that keeps the WebView alive so alerts arrive in the background |
| `res/raw/varnox_bridge.js` | Shims `window.Notification` onto Android notifications — the web app's own alert code drives it |
| `res/mipmap-*`, `res/drawable/ic_notification.xml` | Launcher icon (adaptive + legacy) and the status-bar icon |
| `assets/icon-source.png` | The original brand artwork the icon set is generated from |
| `tools/make_icons.py` | Regenerates the icon set: `python3 tools/make_icons.py` |
| `tools/test_bridge.js` | 23 assertions over the notification shim: `node tools/test_bridge.js` |
| `build.sh` | aapt2 → javac → d8 → zipalign → apksigner, no Gradle |

## Building

Needs a JDK (17+), Android SDK `platforms;android-34` and `build-tools;36.0.0`. Point `SDK=/tmp/apk-tools/sdk`
at the top of `build.sh` to wherever yours live, then:

```bash
bash build.sh          # writes ../VARNOX-<versionName>.apk
node tools/test_bridge.js   # after touching res/raw/varnox_bridge.js
```

Use build-tools **36**, not 34: d8 from 34 crashes on classes that extend `WebViewClient` with an
internal null-pointer error, which fails the whole build.

## Signing

**The release keystore is deliberately not in this repository** — this repo is public, and the
keystore plus its password is enough to publish updates that Android would accept as genuine
VARNOX releases. Keep the keystore (and the password) somewhere private; `build.sh` expects it at
`apk/varnox-release.keystore`, alias `varnox`. Nothing can be installed *over* an existing
install unless it is signed with the same key, so losing it means every user must uninstall first.

## Shipping a new version

1. Bump `versionCode` and `versionName` in `AndroidManifest.xml`.
2. `bash build.sh`.
3. Copy the output over `public/VARNOX.apk` in the repository root.
4. Bump `APK_VERSION` in `lib/apk.ts` so the download label matches.
5. Commit and push — Vercel redeploys and the site serves the new file at `/VARNOX.apk`.
