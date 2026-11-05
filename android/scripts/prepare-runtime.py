"""Install Termux's Node.js build into the APK's jniLibs.

Android installs only lib*.so files from an APK's lib/ folder, and an app
may only execute files from that installed native library directory. So:
  node                 -> libnode.so (spawned as the server process)
  libssl.so.3 & co.    -> liblh*.so, with SONAME/NEEDED rewritten (patchelf)
The unique liblh* names keep Termux's libz/ssl from clashing with the
system's copies. Termux's hard-coded RUNPATH is dropped: the app sets
LD_LIBRARY_PATH to its native library directory instead.
"""
import argparse, os, shutil, subprocess

ap = argparse.ArgumentParser()
ap.add_argument("--termux", required=True)
ap.add_argument("--patchelf", required=True)
ap.add_argument("--jnilibs", required=True)
ap.add_argument("--assets", required=True)
a = ap.parse_args()

RENAME = {
    "libz.so.1": "liblhz.so",
    "libcares.so": "liblhcares.so",
    "libsqlite3.so": "liblhsqlite3.so",
    "libffi.so": "liblhffi.so",
    "libcrypto.so.3": "liblhcrypto.so",
    "libssl.so.3": "liblhssl.so",
    "libicui18n.so.78": "liblhicui18n.so",
    "libicuuc.so.78": "liblhicuuc.so",
    "libicudata.so.78": "liblhicudata.so",
    "libc++_shared.so": "libc++_shared.so",
}

def pe(*args):
    subprocess.run([a.patchelf, *args], check=True)

def needed(path):
    out = subprocess.run([a.patchelf, "--print-needed", path], check=True, capture_output=True, text=True).stdout
    return out.split()

def install(src, dest_name, soname):
    dest = os.path.join(a.jnilibs, dest_name)
    shutil.copyfile(os.path.realpath(src), dest)
    os.chmod(dest, 0o755)
    pe("--remove-rpath", dest)
    if soname:
        pe("--set-soname", dest_name, dest)
    for n in needed(dest):
        if n in RENAME and RENAME[n] != n:
            pe("--replace-needed", n, RENAME[n], dest)
    left = [n for n in needed(dest) if n not in RENAME.values() and n not in
            ("libc.so", "libm.so", "libdl.so", "liblog.so")]
    if left:
        raise SystemExit(f"[runtime] {dest_name}: unresolved NEEDED {left}")
    print("[runtime]", os.path.basename(src), "->", dest_name)

os.makedirs(a.jnilibs, exist_ok=True)
install(os.path.join(a.termux, "bin", "node"), "libnode.so", soname=False)
for old, new in RENAME.items():
    install(os.path.join(a.termux, "lib", old), new, soname=old != "libsqlite3.so")

rt = os.path.join(a.assets, "runtime")
os.makedirs(rt, exist_ok=True)
shutil.copyfile(os.path.join(a.termux, "etc", "tls", "openssl.cnf"), os.path.join(rt, "openssl.cnf"))
shutil.copyfile(os.path.join(a.termux, "etc", "tls", "cert.pem"), os.path.join(rt, "cert.pem"))
print("[runtime] TLS config + CA bundle -> assets/runtime")
