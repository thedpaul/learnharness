"""Curate the Next standalone server for Android and pack it into the APK.

- Drops packages that cannot run on Android (local Whisper's onnxruntime /
  transformers.js / sharp) and the build host's native canvas/resvg builds.
- Adds the official Android arm64 builds of @napi-rs/canvas and
  @resvg/resvg-js (fetched with `npm pack`, version-matched to the app's).
- Moves every native addon (*.node) into jniLibs as lib*.so: Android only
  lets apps execute code from their native library directory. The app
  symlinks each addon back to its original path at extraction time.
- Symlinks inside the payload are recorded in a manifest (zip can't carry
  them portably) and recreated by the app.
"""
import argparse, json, os, shutil, subprocess, sys, tarfile, zipfile

ap = argparse.ArgumentParser()
ap.add_argument("--standalone", required=True)
ap.add_argument("--assets", required=True)
ap.add_argument("--jnilibs", required=True)
ap.add_argument("--npm-cache", required=True)
ap.add_argument("--version", required=True)
a = ap.parse_args()

S = a.standalone
NM = os.path.join(S, "node_modules")

def rm(rel):
    p = os.path.join(S, rel)
    if os.path.islink(p) or os.path.isfile(p):
        os.remove(p)
    elif os.path.isdir(p):
        shutil.rmtree(p)
    else:
        return
    print("[pack] removed", rel)

for rel in ["node_modules/onnxruntime-node", "node_modules/onnxruntime-common", "node_modules/@huggingface",
            "node_modules/sharp", "node_modules/@img"]:
    rm(rel)
for scope, prefix in (("@napi-rs", "canvas-"), ("@resvg", "resvg-js-")):
    d = os.path.join(NM, scope)
    if os.path.isdir(d):
        for name in os.listdir(d):
            if name.startswith(prefix):
                rm(f"node_modules/{scope}/{name}")

def version_of(pkg):
    with open(os.path.join(NM, pkg, "package.json")) as f:
        return json.load(f)["version"]

os.makedirs(a.npm_cache, exist_ok=True)
for base, android in (("@napi-rs/canvas", "@napi-rs/canvas-android-arm64"),
                      ("@resvg/resvg-js", "@resvg/resvg-js-android-arm64")):
    spec = f"{android}@{version_of(base)}"
    tgz = subprocess.run(["npm", "pack", spec, "--silent"], cwd=a.npm_cache, check=True,
                         capture_output=True, text=True).stdout.strip().splitlines()[-1]
    dest = os.path.join(NM, android)
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(os.path.join(a.npm_cache, tgz)) as t:
        for m in t.getmembers():
            if not m.name.startswith("package/"):
                continue
            m.name = m.name[len("package/"):]
            t.extract(m, dest, filter="data")
    print("[pack] added", spec)

# Native addons → jniLibs.
if os.path.isdir(a.jnilibs):
    for f in os.listdir(a.jnilibs):
        if f.startswith("libaddon_"):
            os.remove(os.path.join(a.jnilibs, f))
os.makedirs(a.jnilibs, exist_ok=True)
links = []  # [relative path in server, target] — target "@native/<lib>" = native lib dir
for dirpath, dirnames, filenames in os.walk(S):
    for fn in filenames:
        if not fn.endswith(".node"):
            continue
        full = os.path.join(dirpath, fn)
        if os.path.islink(full):
            continue
        rel = os.path.relpath(full, S)
        if "android-arm64" not in fn:
            sys.exit(f"[pack] REFUSING: non-Android native addon in payload: {rel}")
        lib = "libaddon_" + fn.replace(".node", "").replace(".", "_").replace("-", "_") + ".so"
        shutil.move(full, os.path.join(a.jnilibs, lib))
        links.append([rel, "@native/" + lib])
        print("[pack] addon", rel, "->", lib)

os.makedirs(a.assets, exist_ok=True)
zpath = os.path.join(a.assets, "server.zip")
count = 0
with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for dirpath, dirnames, filenames in os.walk(S):
        for name in list(dirnames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                dirnames.remove(name)
                target = os.readlink(full)
                if os.path.exists(full):
                    links.append([os.path.relpath(full, S), target])
        for fn in filenames:
            full = os.path.join(dirpath, fn)
            rel = os.path.relpath(full, S)
            if os.path.islink(full):
                if os.path.exists(full):
                    links.append([rel, os.readlink(full)])
                continue
            z.write(full, rel)
            count += 1
    z.writestr("symlinks.json", json.dumps(links, indent=0))

with open(os.path.join(a.assets, "server.version"), "w") as f:
    f.write(f"{a.version}-{int(os.path.getmtime(zpath))}\n")
print(f"[pack] {count} files, {len(links)} links -> {zpath} ({os.path.getsize(zpath) // 1048576} MiB)")
