#!/usr/bin/env python3
"""Build a .deb from dist/linux-unpacked using dpkg-deb (no binutils/ar needed)."""
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJ = os.path.dirname(ROOT)
UNPACKED = os.path.join(PROJ, "dist", "linux-unpacked")
DEBROOT = os.path.join(PROJ, "dist", "debroot")
NAME = "task-manager"
PRETTY = "Task Manager"
ARCH = "amd64"

# keep the .deb version in step with app/package.json
with open(os.path.join(PROJ, "app", "package.json"), encoding="utf-8") as _f:
    VERSION = json.load(_f)["version"]
OUT = os.path.join(PROJ, "dist", f"task-manager_{VERSION}_{ARCH}.deb")
MAINTAINER = "windows-11-task-manager-linux contributors <noreply@users.noreply.github.com>"
SUMMARY = "Windows 11 Task Manager replica"
DESCRIPTION = (
    "A from-scratch Linux implementation of the Windows 11 Task Manager interface.\n"
    "Shows live processes, performance graphs, services, startup apps and users,\n"
    "reading real system data from /proc. Built with Electron."
)

if not os.path.isdir(UNPACKED):
    sys.exit(f"missing {UNPACKED} — run electron-builder first")

# --- stage root ---
if os.path.exists(DEBROOT):
    shutil.rmtree(DEBROOT)
optdir = os.path.join(DEBROOT, "opt", PRETTY)
os.makedirs(os.path.dirname(optdir), exist_ok=True)
shutil.copytree(UNPACKED, optdir, symlinks=True)
# electron names the executable after package.json "name"
EXEC_NAME = "task-manager-replica"
exec_path = os.path.join(optdir, EXEC_NAME)
if not os.path.isfile(exec_path):
    sys.exit(f"missing executable {exec_path}")
os.chmod(exec_path, 0o755)

# icon
icons = os.path.join(DEBROOT, "usr", "share", "icons", "hicolor", "512x512", "apps")
os.makedirs(icons, exist_ok=True)
shutil.copy2(os.path.join(PROJ, "app", "assets", "icon.png"),
             os.path.join(icons, NAME + ".png"))

# desktop entry
apps = os.path.join(DEBROOT, "usr", "share", "applications")
os.makedirs(apps, exist_ok=True)
with open(os.path.join(apps, NAME + ".desktop"), "w") as f:
    f.write(
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={PRETTY}\n"
        "Comment=Manage processes and system performance\n"
        f"Exec=\"/opt/{PRETTY}/{EXEC_NAME}\"\n"
        f"Icon={NAME}\n"
        "Terminal=false\n"
        "Categories=System;Monitor;\n"
        "StartupNotify=true\n"
    )

# DEBIAN/control
deb = os.path.join(DEBROOT, "DEBIAN")
os.makedirs(deb, exist_ok=True)
inst_size = sum(
    os.path.getsize(os.path.join(dp, fn))
    for dp, _, fns in os.walk(DEBROOT) for fn in fns
)
with open(os.path.join(deb, "control"), "w") as f:
    f.write(
        f"Package: {NAME}\n"
        f"Version: {VERSION}\n"
        f"Section: utils\n"
        f"Priority: optional\n"
        f"Architecture: {ARCH}\n"
        f"Installed-Size: {inst_size // 1024}\n"
        f"Maintainer: {MAINTAINER}\n"
        f"Depends: libgtk-3-0, libnotify4, libnss3, libxss1, libxtst6, "
        f"xdg-utils, libatspi2.0-0, libuuid1, libsecret-1-0\n"
        f"Homepage: https://example.com/task-manager-replica\n"
        f"Description: {SUMMARY}\n"
    )
    # continuation lines of a Description field must start with a space
    for line in DESCRIPTION.split("\n"):
        f.write(" " + line + "\n")

with open(os.path.join(deb, "postinst"), "w") as f:
    f.write("#!/bin/sh\nset -e\nif command -v update-desktop-database >/dev/null 2>&1; then\n"
            "  update-desktop-database -q /usr/share/applications || true\nfi\nexit 0\n")
with open(os.path.join(deb, "postrm"), "w") as f:
    f.write("#!/bin/sh\nset -e\nif command -v update-desktop-database >/dev/null 2>&1; then\n"
            "  update-desktop-database -q /usr/share/applications || true\nfi\nexit 0\n")
for s in ("postinst", "postrm"):
    os.chmod(os.path.join(deb, s), 0o755)

# --- build ---
if os.path.exists(OUT):
    os.remove(OUT)
r = subprocess.run(
    ["dpkg-deb", "--build", "--root-owner-group", DEBROOT, OUT],
    capture_output=True, text=True,
)
print(r.stdout.strip())
if r.returncode != 0:
    sys.exit("dpkg-deb failed:\n" + r.stderr)
print("built", OUT, os.path.getsize(OUT), "bytes")
