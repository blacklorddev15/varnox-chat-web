#!/usr/bin/env bash
# Build VARNOX.apk without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner
set -euo pipefail

SDK=/tmp/apk-tools/sdk
BT="$SDK/build-tools/36.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
export JAVA_HOME=/tmp/apk-tools/jdk
export PATH="$JAVA_HOME/bin:$PATH"

PROJ="$(cd "$(dirname "$0")" && pwd)"
OUT="$PROJ/build"
KS="$PROJ/varnox-release.keystore"
KS_PASS="varnox2026"
APK_OUT="$PROJ/../VARNOX-1.3.apk"

rm -rf "$OUT"
mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo "==> generating launcher icons"
python3 "$PROJ/tools/make_icons.py"

echo "==> aapt2 compile"
"$BT/aapt2" compile --dir "$PROJ/res" -o "$OUT/res.zip"

echo "==> aapt2 link"
"$BT/aapt2" link \
  -o "$OUT/base.apk" \
  -I "$PLAT" \
  --manifest "$PROJ/AndroidManifest.xml" \
  "$OUT/res.zip" \
  --java "$OUT/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code 4 \
  --version-name 1.3 \
  --no-version-vectors

echo "==> javac"
javac -source 8 -target 8 -nowarn -classpath "$PLAT" -d "$OUT/classes" \
  $(find "$PROJ/java" "$OUT/gen" -name '*.java')

echo "==> d8"
"$BT/d8" --release --min-api 24 --lib "$PLAT" --output "$OUT/dex" \
  $(find "$OUT/classes" -name '*.class')

echo "==> package dex"
python3 - "$OUT" <<'PY'
import sys, zipfile, os
out = sys.argv[1]
apk = os.path.join(out, "base.apk")
with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(os.path.join(out, "dex", "classes.dex"), "classes.dex")
print("classes.dex added")
PY

echo "==> keystore"
if [ ! -f "$KS" ]; then
  keytool -genkeypair -v \
    -keystore "$KS" -alias varnox -keyalg RSA -keysize 2048 -validity 10950 \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -dname "CN=VARNOX, OU=Mobile, O=VARNOX, L=NA, ST=NA, C=NA"
fi

echo "==> zipalign"
"$BT/zipalign" -f -p 4 "$OUT/base.apk" "$OUT/aligned.apk"

echo "==> sign"
"$BT/apksigner" sign \
  --ks "$KS" --ks-key-alias varnox \
  --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" \
  --v1-signing-enabled true --v2-signing-enabled true \
  --out "$APK_OUT" "$OUT/aligned.apk"

echo "==> verify"
"$BT/apksigner" verify --print-certs "$APK_OUT"
ls -la "$APK_OUT"
