# Varnox Chat — Android shell

A native Android wrapper (one `WebView` activity) around the web app that lives in this repo, so
the shipped Android app is always the deployed site — no second codebase to keep in sync.

| Field | Value |
|---|---|
| App name | Varnox Chat |
| Package ID | `com.varnox.chat` |
| Version | 1.1 (versionCode 2) |
| Min Android | 7.0 (API 24) |
| Target Android | 14 (API 34) |
| Launched URL | `START_URL` in `java/com/varnox/chat/MainActivity.java` |

## Install

Sideload the built APK:

```bash
adb install -r varnox-chat.apk
```

Or copy it to the device and open it, allowing "install unknown apps" if prompted.

## What the shell does

- Full-screen WebView on the app's dark `#171717` theme, JS/DOM storage/cookies enabled so
  sessions persist (cookies incl. third-party).
- File uploads: `<input type="file">` opens the system picker.
- Camera and microphone: runtime permissions, then `getUserMedia` requests are granted (voice
  notes, calls).
- Downloads handed to the system; `mailto:`/`tel:` and other non-http(s) links delegated.
- Back button walks WebView history before exiting; state survives rotation.
- Offline and TLS errors show a retry dialog instead of a blank screen.
- Adaptive launcher icon generated from the site's own `public/icon-512.png` and
  `public/icon-maskable-512.png`.

## Notifications

Android WebView implements **neither** the Web Notifications API nor the Web Push API, so the web
app's feature detection would report "not supported" and its notification toggle would dead-end.
`NotificationBridge` closes that gap:

- `res/raw/varnox_notify_shim.js` is injected from `onPageStarted` so it is installed **before**
  the app boots; it defines `window.Notification` and forwards every call to the native
  `NotificationManager`.
- Exposed to the page as the JS interface `VarnoxNotify`
  (`permission`, `requestPermission`, `post`, `cancel`, `supported`).
- High-importance channel (`varnox_messages`) with vibration, grouping and `BigTextStyle`, using a
  white brand chevron as the status-bar icon.
- `Notification.requestPermission()` maps onto the Android 13+ `POST_NOTIFICATIONS` runtime
  dialog; if notifications are off at OS level the bridge opens the app's system notification
  settings and resolves the page's promise on return.
- Tapping a notification reopens the activity on the page it came from.
- `ServiceWorkerRegistration.prototype.showNotification` is patched to the same path.

Works for anything the page raises itself. **True push (a notification with the app closed) is not
possible from a WebView shell** — that needs native FCM plus a backend sender, or a polling
foreground service. The site is not set up for it either: `public/sw.js` has no `push` listener and
no VAPID key is configured.

## Source layout

```
apk/
├── AndroidManifest.xml
├── build-apk.sh                     # full build, no Gradle
├── java/com/varnox/chat/
│   ├── MainActivity.java            # WebView shell
│   └── NotificationBridge.java      # web notifications -> Android notifications
└── res/
    ├── values/{strings,colors,styles}.xml
    ├── raw/varnox_notify_shim.js             # injected window.Notification shim
    ├── drawable-*/ic_stat_varnox.png         # status-bar notification icon
    ├── mipmap-*/ic_launcher.png              # legacy launcher icons
    ├── mipmap-*/ic_launcher_foreground.png   # adaptive-icon foregrounds
    └── mipmap-anydpi-v26/ic_launcher.xml     # adaptive icon
```

## Build

Requires an Android SDK with platform 34 and build-tools 34.0.0, and **JDK 17** — d8 8.2.2 from
build-tools 34.0.0 throws an internal NPE on these class files under JDK 21.

```bash
SDK_ROOT=/path/to/android-sdk JAVA_HOME=/path/to/jdk-17 bash apk/build-apk.sh
```

The script runs `aapt2 compile` → `aapt2 link` → `javac` → `d8` → `zipalign` → `apksigner sign`
and writes `varnox-chat.apk` next to the repo root. Override the output with `SDK_ROOT` for the SDK
location.

## Signing

**The signing keystore is deliberately not in this repository.** A public repo would expose the
private key together with the password, and that key is the only thing that can update an
already-installed Varnox APK — losing control of it means shipping a new package name instead.

To build a release APK, generate your own key once and keep it out of version control (`.gitignore`
already covers `apk/*.keystore`):

```bash
keytool -genkeypair -keystore apk/varnox-release.keystore -alias varnox \
  -keyalg RSA -keysize 2048 -validity 10950
```

The build script reuses `apk/varnox-release.keystore` when it exists and only generates a
throwaway key when it is missing, so a real key placed there is picked up automatically. For
Google Play, either use Play App Signing or keep your own upload key, and raise `--version-code`
in `build-apk.sh` for every upload. Play requires an `.aab`, which this Gradle-free pipeline does
not produce.

## Changing the target site or branding

- **URL**: `START_URL` (and `HOST`) in `MainActivity.java`.
- **App name**: `res/values/strings.xml`.
- **Package ID**: the `package` attribute in `AndroidManifest.xml` plus the
  `java/com/varnox/chat/` folder path.
- **Colours**: `res/values/colors.xml`.
- **Icons**: replace the `res/mipmap-*` and `res/drawable-*` PNGs.

## Not verified

The APK is validated statically (manifest, dex, resources, signature, alignment) but has not been
launched on a device or emulator in CI. Notification behaviour in particular — the permission
dialog, a notification rendering, and tap-to-open — has been built and packaged but not observed
on a real device.
