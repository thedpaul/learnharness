# LearnHarness for Android (standalone, arm64)

A self-contained Android build: the phone runs the same LearnHarness server
the desktop app ships, and the app shows it in a WebView. No PC is needed at
runtime. The desktop sources and the Linux/Windows/macOS builds are
unaffected — everything Android-specific lives in this folder.

## How it works

- **Server:** `build.sh` copies the repo into `../.learnharness-android-build/src` (next to the repo, so it never touches the desktop typecheck), applies
  `overlay/apply.mjs` to that copy only, and runs the normal `next build`
  standalone pipeline.
- **Node.js:** Termux's `nodejs` package (Node 26, built for Android/bionic)
  ships as `libnode.so` with its libraries renamed to `liblh*.so`
  (`scripts/prepare-runtime.py`). Android only lets apps execute code from
  their native library directory, so every native file (Node, its
  libraries, the canvas/resvg addons) is installed there.
- **App shell** (`app/src/main/java/...`): `ServerService` unpacks the server
  on first launch (and after updates), starts Node on a random loopback port,
  and protects the API with a per-launch secret that the WebView presents as
  an HttpOnly cookie. `MainActivity` hosts the WebView.
- **Dictation:** the Android build adds an **Android speech recognition**
  engine (the phone's SpeechRecognizer, on-device when available; default),
  keeps the **Transcription endpoint** and **Deepgram** engines, and hides
  local Whisper (onnxruntime has no Android build).

- **Claude Code (Pro/Max subscription):** the build bundles Claude Code's
  Linux arm64 **musl** binary plus Alpine's musl loader (`libclaude.so`,
  `libldmusl.so`); LearnHarness starts it as `loader cli …`. Turn it on in
  Settings → Providers → External CLI, then **Sign in with Claude**: the app
  opens the sign-in page in the phone's browser and you paste back the code.
  Credentials stay in the app's private storage; auto-update is disabled
  (rebuild to update). LearnHarness runs the CLI with all built-in tools off,
  so it needs no shell on the phone.

## Build

Tools live in `<repo>/.sdks` (git-ignored via `.git/info/exclude`):
`jdk-21/`, `android-sdk/` (platform 36, build-tools 36.0.0, platform-tools),
`gradle/`, `patchelf-py/`, and `termux/` (the extracted Termux packages:
`nodejs` and its dependencies, from packages.termux.dev, aarch64).

```sh
android/build.sh    # → android/out/LearnHarness-<version>-arm64.apk
```

Install on a phone with USB debugging enabled:

```sh
.sdks/android-sdk/platform-tools/adb install -r android/out/LearnHarness-*-arm64.apk
```

## Limitations

- arm64-v8a phones only, Android 10+.
- Not available on Android: local Whisper, the interactive-demo verification
  step (needs a desktop Chrome/Electron), subscription sign-ins that rely on
  the desktop shell, and attaching files by path from the phone's storage.
- The APK is signed with a local debug key: it's for sideloading, not Play.
