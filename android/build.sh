#!/usr/bin/env bash
# Build the standalone Android APK (arm64-v8a).
#
# LH_ANDROID_ABI=x86_64 builds a test APK for the x86_64 emulator instead:
# Termux x86_64 Node (.sdks/termux-x86_64), Claude Code linux-x64-musl, and
# no canvas/resvg (they have no Android x64 builds: PDF page rendering and
# SVG rasterizing are unavailable there).
#
# The desktop sources are never modified: the repo is copied into
# a staging folder next to the repo, the Android-only overlay (overlay/apply.mjs) patches
# THAT copy, and the Next server built from it ships inside the APK together
# with an Android build of Node.js (Termux's nodejs package).
#
# Tools come from <repo>/.sdks (JDK 21, Android SDK, Gradle, patchelf,
# Termux packages) — see android/README.md.
set -euo pipefail

A="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$A/.." && pwd)"
SDKS="$ROOT/.sdks"
# Outside the repo on purpose: a staged copy inside it would be swept into the
# desktop typecheck/lint (tsconfig includes **/*.ts) and Next's workspace
# root detection.
STAGE="${LH_ANDROID_STAGE:-$(dirname "$ROOT")/.learnharness-android-build}"
SRC="$STAGE/src"
OUT="$A/out"

export JAVA_HOME="$SDKS/jdk-21"
export ANDROID_HOME="$SDKS/android-sdk"
export GRADLE_USER_HOME="$SDKS/gradle-home"
export ANDROID_USER_HOME="$SDKS/android-user"
PATCHELF="$SDKS/patchelf-py/bin/patchelf"
ABI="${LH_ANDROID_ABI:-arm64-v8a}"
case "$ABI" in
	arm64-v8a) TERMUX="$SDKS/termux"; CC_PKG=linux-arm64-musl; MUSL=aarch64; CC_DIR="$SDKS/claude-code"; APK_ARCH=arm64 ;;
	x86_64) TERMUX="$SDKS/termux-x86_64"; CC_PKG=linux-x64-musl; MUSL=x86_64; CC_DIR="$SDKS/claude-code/x86_64"; APK_ARCH=x86_64-emulator ;;
	*) echo "[android] unknown LH_ANDROID_ABI=$ABI (arm64-v8a or x86_64)"; exit 1 ;;
esac
TERMUX_USR="$TERMUX/root/data/data/com.termux/files/usr"
JNI="$A/app/src/main/jniLibs/$ABI"

for need in "$JAVA_HOME/bin/java" "$ANDROID_HOME/platforms" "$SDKS/gradle/bin/gradle" "$PATCHELF" "$TERMUX_USR/bin/node"; do
	[ -e "$need" ] || { echo "[android] missing $need — see android/README.md"; exit 1; }
done

VERSION="$(node -p "require('$ROOT/package.json').version")"
echo "[android] LearnHarness $VERSION ($ABI)"

# 1) Stage a copy of the sources (working tree, including uncommitted work).
echo "[android] staging sources"
mkdir -p "$SRC"
rsync -a --delete \
	--exclude '/node_modules' --exclude '/.next' --exclude '/dist' --exclude '/.sdks' \
	--exclude '/android' --exclude '/data' --exclude '/.git' --exclude '/auth.json' \
	--exclude '/.env*' --exclude '*-credentials.json*' \
	"$ROOT/" "$SRC/"

# 2) Dependencies (cached between builds unless the lockfile changes).
if ! cmp -s "$ROOT/package-lock.json" "$STAGE/.lock-installed" 2>/dev/null; then
	echo "[android] npm ci (staging)"
	(cd "$SRC" && npm ci --no-audit --no-fund)
	cp "$ROOT/package-lock.json" "$STAGE/.lock-installed"
fi

# 3) Android-only source changes.
echo "[android] applying overlay"
node "$A/overlay/apply.mjs" "$SRC"

# 4) Build the server exactly like the desktop pipeline.
echo "[android] next build"
(cd "$SRC" && rm -rf .next && npm run build && node scripts/build-server.mjs)

# 5) Curate the payload for Android and pack it.
echo "[android] packing server payload"
python3 -I "$A/scripts/pack-payload.py" \
	--standalone "$SRC/.next/standalone" \
	--assets "$A/app/src/main/assets" \
	--jnilibs "$JNI" \
	--abi "$ABI" \
	--npm-cache "$STAGE/npm-packs" \
	--version "$VERSION"

# 6) The Node runtime: Termux's build, renamed so Android installs it as
#    native libraries (the only place an app may execute code from).
echo "[android] preparing Node runtime"
python3 -I "$A/scripts/prepare-runtime.py" \
	--termux "$TERMUX_USR" \
	--patchelf "$PATCHELF" \
	--jnilibs "$JNI" \
	--assets "$A/app/src/main/assets"

# 6b) Claude Code: its Linux arm64 musl build runs on Android through musl's
#     own loader (Alpine's), both installed as native libraries. Fetched once
#     per version into .sdks/claude-code. Pin with CLAUDE_CODE_VERSION=x.y.z.
CC_VERSION="${CLAUDE_CODE_VERSION:-$(npm view @anthropic-ai/claude-code version)}"
if [ ! -x "$CC_DIR/$CC_VERSION/claude" ]; then
	echo "[android] fetching Claude Code $CC_VERSION ($CC_PKG)"
	mkdir -p "$CC_DIR/$CC_VERSION"
	TGZ="$(cd "$CC_DIR" && npm pack "@anthropic-ai/claude-code-$CC_PKG@$CC_VERSION" --silent | tail -1)"
	tar -xzf "$CC_DIR/$TGZ" -C "$CC_DIR/$CC_VERSION" --strip-components=1 package/claude
	rm -f "$CC_DIR/$TGZ"
fi
if [ ! -f "$CC_DIR/musl/ld-musl-$MUSL.so.1" ]; then
	echo "[android] fetching Alpine musl ($MUSL)"
	mkdir -p "$CC_DIR/musl"
	ALP=https://dl-cdn.alpinelinux.org/alpine/latest-stable/main/$MUSL
	APK="$(curl -fsSL "$ALP/" | grep -oE 'href="musl-1[^"]+\.apk"' | head -1 | cut -d'"' -f2)"
	curl -fsSL "$ALP/$APK" | tar -xzf - -C "$CC_DIR/musl" --strip-components=1 "lib/ld-musl-$MUSL.so.1" 2>/dev/null
fi
cp "$CC_DIR/$CC_VERSION/claude" "$JNI/libclaude.so"
cp "$CC_DIR/musl/ld-musl-$MUSL.so.1" "$JNI/libldmusl.so"
chmod 755 "$JNI/libclaude.so" "$JNI/libldmusl.so"
echo "[android] Claude Code $CC_VERSION bundled"

# 7) APK.
echo "[android] gradle assembleRelease"
echo "sdk.dir=$ANDROID_HOME" > "$A/local.properties"
(cd "$A" && "$SDKS/gradle/bin/gradle" --no-daemon -q -PlhVersion="$VERSION" -PlhAbi="$ABI" assembleRelease)

mkdir -p "$OUT"
APK="$OUT/LearnHarness-$VERSION-$APK_ARCH.apk"
cp "$A/app/build/outputs/apk/release/app-release.apk" "$APK"
ls -la "$APK"
