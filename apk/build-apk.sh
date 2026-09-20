#!/usr/bin/env bash
# Build a signed release APK for the Varnox Chat web app without Gradle.
# Requires: Android SDK platform 34 & build-tools 34.0.0.
# NOTE: use JDK 17. R8/d8 8.2.2 (shipped in build-tools 34.0.0) crashes with an
# internal NPE on this app's class files when run on JDK 21.
set -euo pipefail

PROJ="$(cd "$(dirname "$0")" && pwd)"
SDK="${SDK_ROOT:-$PROJ/../.android-build/sdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"
export JAVA_HOME="${JAVA_HOME:-/usr/lib/jvm/java-17-openjdk-amd64}"
export PATH="$JAVA_HOME/bin:$PATH"

KS="$PROJ/varnox-release.keystore"
KS_ALIAS="varnox"
OUT="$PROJ/../varnox-chat.apk"

# The password comes from the environment and must never be written into this file again.
#
# It used to be a literal here, in a public repository, sitting next to the encrypted keystore. That
# combination is not a risk, it is the key: the blob and its password published together mean anyone
# can extract the private key and sign an APK that Android accepts as an update to this app. The
# keystore was regenerated on 21 Sep 2026 because of it, and this is the half that stops it
# recurring - a fresh key published the same way would have been worth nothing.
if [ -z "${KS_PASS:-}" ]; then
  {
    echo "ERROR: KS_PASS is not set."
    echo "       Export the password for $KS before building:"
    echo "         export KS_PASS='...'"
    echo "       Keep it where secrets belong, not in this script."
    echo "       The password can be changed whenever you like without touching the certificate"
    echo "       or invalidating installed apps - 'keytool -storepasswd' keeps the key."
  } >&2
  exit 1
fi

cd "$PROJ"
rm -rf build
mkdir -p build/compiled build/gen build/classes build/dex

echo "==> 1/6 compiling resources"
"$BT/aapt2" compile --dir res -o build/compiled/res.zip

echo "==> 2/6 linking resources + manifest"
"$BT/aapt2" link \
  -o build/base.apk \
  -I "$PLATFORM" \
  --manifest AndroidManifest.xml \
  -R build/compiled/res.zip \
  --java build/gen \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  # Raised because the signing key changed on 21 Sep 2026. An installed copy will not accept an
  # equal version code, and a new key cannot update over an old one anyway - the certificate differs
  # - so every existing install has to be uninstalled and reinstalled once.
  --version-code 4 \
  --version-name 1.3 \
  --auto-add-overlay

echo "==> 3/6 compiling java sources"
javac -nowarn -source 11 -target 11 \
  -classpath "$PLATFORM" \
  -d build/classes \
  $(find java build/gen -name '*.java')

echo "==> 4/6 dexing"
"$BT/d8" --release --lib "$PLATFORM" --min-api 24 \
  --output build/dex $(find build/classes -name '*.class')

echo "==> 5/6 packaging"
( cd build/dex && zip -q -X -j ../base.apk classes.dex )
"$BT/zipalign" -f -p 4 build/base.apk build/aligned.apk

echo "==> 6/6 signing"
# A missing release keystore is an error, not something to invent.
#
# This used to generate one on the spot. Every machine that lacked the file therefore produced a
# differently-signed APK under the same package name - which cannot update an installed copy, and
# which silently stops matching the fingerprint published in
# public/.well-known/assetlinks.json, so app links break with nothing to show why.
#
# Generating a key is a deliberate act, so it is now a deliberate opt-in.
if [ ! -f "$KS" ]; then
  if [ "${ALLOW_NEW_KEY:-}" != "1" ]; then
    {
      echo "ERROR: $KS is missing."
      echo "       Restore the release keystore, or set ALLOW_NEW_KEY=1 if you really intend to"
      echo "       start a new signing identity (this changes the certificate, so every install"
      echo "       must be removed and reinstalled, and the fingerprint in"
      echo "       public/.well-known/assetlinks.json must be updated to match)."
    } >&2
    exit 1
  fi
  echo "==> ALLOW_NEW_KEY=1: generating a new signing identity"
  keytool -genkeypair -keystore "$KS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 4096 -validity 10000 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Varnox Release, O=Varnox"
fi
"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias "$KS_ALIAS" \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --min-sdk-version 24 \
  --out "$OUT" build/aligned.apk

"$BT/apksigner" verify --print-certs "$OUT"
ls -lh "$OUT"
echo "BUILD OK -> $OUT"
