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
KS_PASS="varnox2026"
KS_ALIAS="varnox"
OUT="$PROJ/../varnox-chat.apk"

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
  --version-code 2 \
  --version-name 1.1 \
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
if [ ! -f "$KS" ]; then
  keytool -genkeypair -keystore "$KS" -alias "$KS_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=Varnox Chat, OU=Mobile, O=Varnox, L=Singapore, ST=Singapore, C=SG"
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
