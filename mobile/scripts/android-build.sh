#!/usr/bin/env bash
# Build the Finman Android shell.
#   scripts/android-build.sh bundle   -> release AAB (Play upload), signed with the upload key
#   scripts/android-build.sh apk      -> release APK (for redroid / sideload tests)
#   scripts/android-build.sh debug    -> debug APK
# Env: FINMAN_VERSION_CODE, FINMAN_VERSION_NAME; signing props at ~/.config/finman-app/upload.properties
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="${JAVA_HOME:-/fast/android-tools/jdk-21}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="${GRADLE_USER_HOME:-/fast/android-tools/gradle-cache}"
NODE22="$HOME/.nvm/versions/node/v22.22.3/bin"; [ -d "$NODE22" ] && export PATH="$NODE22:$PATH"
npx cap sync android
cd android
case "${1:-bundle}" in
  bundle) ./gradlew --no-daemon -q bundleRelease; ls -la app/build/outputs/bundle/release/ ;;
  apk)    ./gradlew --no-daemon -q assembleRelease; ls -la app/build/outputs/apk/release/ ;;
  debug)  ./gradlew --no-daemon -q assembleDebug; ls -la app/build/outputs/apk/debug/ ;;
  *) echo "usage: $0 bundle|apk|debug"; exit 64 ;;
esac
