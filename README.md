# Windows 11 Task Manager for Linux

![Windows 11 Task Manager clone running on Linux, Performance page showing a live CPU utilization graph](screenshots/performance-cpu.png)

A faithful, from-scratch **Task Manager for Linux** that recreates the Windows 11 Task Manager — its layout, its dark Fluent design, its seven pages and its keyboard shortcut. Built with **Electron**, it reads **live system data straight from `/proc` and `/sys`**, so every number on screen is real: your processes, CPU, memory, disks, network, GPUs and services.

If you have ever missed Task Manager after moving to Linux — or wanted a **system monitor that looks like the one you already know** — this is it. No mock data, no dependencies on native libraries: just `/proc`.

![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-Linux-lightgrey) ![Electron](https://img.shields.io/badge/Electron-33-47848f)

**Latest release: 1.2.0** — per-process GPU usage, system-level `Ctrl+Shift+Esc`, sortable process columns, a single frameless title bar, and native quit-on-close.

---

## Table of contents

- [Features](#features)
- [Ctrl+Shift+Esc: the Task Manager hotkey](#ctrlshiftesc-the-task-manager-hotkey)
- [Bugs fixed in 1.2.0: GPU usage, Ctrl+Shift+Esc, double title bar, close behaviour](#bugs-fixed-in-120-gpu-usage-ctrlshiftesc-double-title-bar-close-behaviour)
- [Installation](#installation)
  - [1. AppImage (any Linux distro)](#1-appimage-any-linux-distro)
  - [2. .deb package (Debian / Ubuntu)](#2-deb-package-debian--ubuntu)
  - [3. Build from source](#3-build-from-source)
- [How it works: where every number comes from](#how-it-works-every-number-comes-from-proc)
- [Settings](#settings)
- [System requirements](#system-requirements)
- [Project structure](#project-structure)
- [Roadmap](#roadmap)
- [FAQ](#faq)
- [License and disclaimer](#license-and-disclaimer)

---

## Features

**Processes** — grouped exactly like Windows into **Apps**, **Background processes** and **Windows processes** (here: *System*). Live CPU, memory and **GPU busy %** per process with the same heat-scale colouring — **click any column header to sort** (CPU, Memory, Disk, GPU, …) to surface the heaviest consumers instantly — plus search with `Ctrl+F`, right-click menus, **End task** for any process, and a live status bar showing system-wide CPU, memory, disk and network.

**Performance** — the full two-pane layout:

- Left rail of live thumbnails: **CPU, Memory, each Disk, each network adapter, each GPU**
- 60-second area graph with the `% Utilization` / `100%` / `60 seconds` / `0` axis labels
- Big **Utilization** and **Speed**, a **Processes / Threads / Handles** row, and **Up time** as `d:hh:mm:ss`
- Right-hand spec column: **Base speed, Sockets, Cores, Logical processors, Virtualisation, L1/L2/L3 cache**
- Disk pages report the real media type — **SSD (SATA)** vs **HDD (SATA)** — from `queue/rotational`
- Network pages show per-adapter `S:` / `R:` throughput with an auto-scaled axis

**App history** — CPU time accumulated per application since boot.

**Startup apps** — every XDG autostart entry, with a working **Enable / Disable** toggle that rewrites the `.desktop` entry.

**Users** — signed-in sessions with per-user CPU and memory.

**Details** — a dense sortable table: PID, name, status, user, CPU, memory, threads, description.

**Services** — full systemd service list with **Start / Stop / Restart** and startup type.

**Settings** — update speed, default start page, show-all-users, background behaviour, and the hotkey.

### Extras beyond the original

- **`Ctrl+Shift+Esc` opens Task Manager from anywhere** — same shortcut as Windows, registered as a *system-level* keybinding so it works even while Task Manager is closed
- **Closes like the native original** — closing quits completely and frees every resource; opt into a resident tray instance via **Settings → Keep running in background**
- **Single instance** — relaunching raises the running window instead of opening a second one
- **Run new task** dialog for launching a command

---

## Ctrl+Shift+Esc: the Task Manager hotkey

Press **`Ctrl+Shift+Esc`** anywhere on your desktop and the window appears, focused, showing fresh data — exactly how Task Manager behaves on Windows. If Task Manager isn't running, the shortcut starts it; if it is — open or resident in the tray — the shortcut raises that same instance instead of launching a second one.

The installed app stores the shortcut in your desktop's own keyboard settings (GNOME's `custom-keybindings`), which is why it works reliably on both X11 and Wayland and survives reboots: your desktop owns the key, exactly as it does for native Linux applications.

> On desktops without GNOME's keybinding facility the app falls back to its own in-app grab. If another application already owns `Ctrl+Shift+Esc` there, the shortcut cannot be claimed — a warning is logged and **Settings → Global hotkey** shows *unavailable*. You can always open Task Manager from the app menu.

---

## Bugs fixed in 1.2.0: GPU usage, Ctrl+Shift+Esc, double title bar, close behaviour

Version 1.2.0 came out of a deep debugging session against a real Linux machine — AMD + Intel hybrid graphics, GNOME on Wayland — where five problems were reproduced, traced to their platform causes and fixed at the root rather than patched around.

### 1. Two title bars, two sets of close buttons

**Symptom.** The desktop drew its own title bar above the app's, stacking two rows of window controls.

**Cause.** The window was created with the default frame *and* rendered its own in-app header — two chrome layers by design accident.

**Fix.** The `BrowserWindow` is now created with `frame: false`, so the in-app Fluent header is the only title bar. Minimize, maximize and close travel over a narrow IPC bridge (`win:minimize` / `win:maximize` / `win:close`), and the maximize button subscribes to the real window state so it switches correctly between *maximize* and *restore* icons.

### 2. GPU usage was always empty (`—`)

**Symptom.** The GPU column and the Performance GPU page never produced a number.

**Cause.** On a normal (non-root) account Linux deliberately hides GPU busy percentage: AMD's `gpu_busy_percent` returns `EBUSY`, Intel's `i915` exposes no busy counter at all, and NVIDIA's `utilization` file needs root. Reading only `/sys/class/drm/card*/` therefore fails for almost every real user — which is why the column looked permanently broken.

**Fix.** The collector now reads **DRM fdinfo** — the per-file-descriptor GPU engine counters Linux exposes under `/proc/<pid>/fdinfo/*` (`drm-engine-render`, `drm-engine-video`, `drm-engine-copy`, …). Each file's monotonic millisecond counters are diffed between the 1-second samples to yield **per-process GPU busy %**, and the card's total is derived by summing its active clients — the same trick KDE's system monitor uses to show GPU % without root. The aggregate falls back through `gpu_busy_percent` → derived-from-clients → `0%`, cards are enumerated dynamically, and hybrid setups (Intel iGPU + AMD dGPU) report each card separately.

### 3. Ctrl+Shift+Esc did not always work

**Symptom.** The shortcut sometimes did nothing — and never worked while the app was closed.

**Cause.** Electron's `globalShortcut` is an application-level grab: on Wayland compositors it is unreliable, and it only exists while the app is already running, so a cold start was impossible.

**Fix.** On GNOME the shortcut is registered **where the desktop keeps its own shortcuts** — `org.gnome.settings-daemon.plugins.media-keys.custom-keybindings` — so GNOME's settings daemon handles the key at the compositor level, exactly like a native OS shortcut. It works from cold start, survives reboots, and cannot be lost when the window closes. Installation is idempotent (the list is read first, verified by read-back, never duplicated), the command is stored GVariant-quoted so paths containing spaces parse correctly, and the binding always points at the stable installed binary instead of a temporary AppImage extraction directory — a bug that used to leave the shortcut aimed at a dead `/tmp` path after every AppImage run. Non-GNOME desktops keep Electron's `globalShortcut` as fallback.

### 4. Closing left every process running — but the hotkey spawned them all again

**Symptom.** "Cutting" the software kept its whole process tree resident; pressing the hotkey then started another full tree; and closing was supposed to free everything, like native software.

**Cause.** Close was intercepted with `preventDefault` into a hidden resident state, and nothing enforced a single instance, so each launch was a cold start.

**Fix.** Closing the window now **quits the app completely** — all renderer, GPU and utility processes, timers and tray are torn down (verified: zero processes remain after close). Background residency became an explicit opt-in under **Settings → Keep running in background**. A single-instance lock makes any second launch quit itself and *raise the running window* instead of starting a second process tree, and sampling automatically pauses while the window is not visible, so a resident instance costs nothing.

### 5. No way to find the top CPU / memory consumers

**Symptom.** The process list had no sorting — you could not surface which app was eating CPU or RAM.

**Fix.** Every Processes column header is clickable — Name, Status, CPU, Memory, Disk, Network, GPU — with a live ▲/▼ indicator, defaulting to CPU descending. Sorting is stable inside each group, so rows stay in their Apps / Background / System group while reordering, and one click flips the direction.

---

## Installation

### 1. AppImage (any Linux distro)

Works on Ubuntu, Debian, Fedora, Arch, openSUSE and everything else — no root, no package manager needed.

```bash
chmod +x TaskManager-1.2.0.AppImage
./TaskManager-1.2.0.AppImage
```

Run it once to confirm it works, then optionally install it into your desktop menu:

```bash
mkdir -p ~/.local/bin ~/.local/share/applications
cp TaskManager-1.2.0.AppImage ~/.local/bin/task-manager
cat > ~/.local/share/applications/task-manager.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=Task Manager
Comment=Windows 11 Task Manager for Linux
Exec=%h/.local/bin/task-manager
Icon=task-manager
Terminal=false
Categories=System;Monitor;
EOF
cp app/assets/icon.png ~/.local/share/icons/task-manager.png
update-desktop-database ~/.local/share/applications 2>/dev/null || true
```

**No FUSE?** Some minimal systems need:

```bash
./TaskManager-1.2.0.AppImage --appimage-extract-and-run
```

### 2. .deb package (Debian / Ubuntu)

```bash
sudo apt install ./task-manager_1.2.0_amd64.deb
```

Or with plain `dpkg`:

```bash
sudo dpkg -i task-manager_1.2.0_amd64.deb
sudo apt-get install -f    # resolves any missing dependencies
```

Launch it from your application menu under **System → Task Manager**, or run `task-manager-replica` in a terminal. On first launch the app installs the **Ctrl+Shift+Esc** system shortcut automatically (GNOME) — confirm with:

```bash
dpkg -s task-manager | grep Version        # → Version: 1.2.0
gsettings get org.gnome.settings-daemon.plugins.media-keys.custom-keybinding:/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/task-manager/ binding
# → '<Control><Shift>Escape'
```

Uninstall any time with:

```bash
sudo apt remove task-manager
```

### 3. Build from source

Requires **Node.js 18+** and **npm**. Python 3 is needed only for the `.deb` target.

```bash
git clone https://github.com/asifbaburcopy-a11y/windows-11-task-manager-linux.git
cd windows-11-task-manager-linux/app
npm install
```

| Command | Result |
| --- | --- |
| `npm start` | Run the app in development |
| `npm run dist` | Build `TaskManager-<version>.AppImage` into `../dist/` |
| `npm run deb` | Build `task-manager_<version>_amd64.deb` into `../dist/` |

The `.deb` is produced by [`scripts/make-deb.py`](scripts/make-deb.py), which uses `dpkg-deb` directly so you do not need `binutils`/`fpm`.

---

## How it works: every number comes from `/proc`

The collector ([`app/sysinfo.js`](app/sysinfo.js)) is dependency-free Node.js. It walks `/proc` once per second and derives Windows-style figures from Linux sources:

| Windows Task Manager shows | Linux source |
| --- | --- |
| Process list, CPU %, memory, I/O | `/proc/[pid]/stat`, `/statm`, `/status`, `/io`, `/cmdline` |
| Overall and per-core CPU | `/proc/stat` |
| Speed, base speed, sockets, cores, logical processors | `/proc/cpuinfo`, `/sys/devices/system/cpu/cpu0/cpufreq` |
| Virtualisation enabled/disabled | `vmx` / `svm` CPU flags |
| L1 / L2 / L3 cache | `/sys/devices/system/cpu/cpu0/cache/index*` |
| Handles | `/proc/sys/fs/file-nr` |
| Threads | sum of `nr_threads` across `/proc/[pid]/stat` |
| Memory, committed, cached, paged pools | `/proc/meminfo` |
| Disk read/write and active time | `/proc/diskstats` |
| SSD vs HDD media type | `/sys/block/*/queue/rotational` |
| Network throughput per adapter | `/proc/net/dev` |
| GPU utilization, VRAM, clocks | `/sys/class/drm/card*/` |
| Per-process GPU busy %, per-GPU totals | DRM fdinfo engine counters: `/proc/[pid]/fdinfo/*` |
| Up time, load average | `/proc/uptime`, `/proc/loadavg` |
| Services | `systemctl show --type=service` |
| Startup apps | XDG autostart `.desktop` files |
| Users and sessions | `/etc/passwd`, `/proc/[pid]/environ` |

A 180-sample rolling history feeds the graphs. Nothing is sent anywhere — the app makes no network requests and loads no remote scripts.

---

## Settings

| Setting | What it does |
| --- | --- |
| Real time update speed | Normal (1 s), Low (2 s) or Paused |
| Default start page | Page shown on launch |
| Show processes of all users | Off limits the list to your own processes |
| Keep running in background | Closing the window hides it to the tray so `Ctrl+Shift+Esc` still works. Turn off to quit on close. |
| Global hotkey | Displays the registered shortcut |

---

## System requirements

- **Linux x86_64** with `/proc` and `/sys` mounted (any standard kernel)
- A desktop environment with GTK 3 — the `.deb` pulls in `libgtk-3-0`, `libnss3`, `libxss1`, `libxtst6`, `libnotify4`, `libatspi2.0-0`, `libsecret-1-0`
- **systemd** for the Services page (the app runs, but service control needs `systemctl`)
- A tray-capable panel for the tray icon — GNOME needs the AppIndicator extension

---

## Project structure

```
windows-11-task-manager-linux/
├── app/
│   ├── main.js          # Electron main process, hotkey, tray, IPC
│   ├── preload.js       # contextBridge API (contextIsolation on)
│   ├── sysinfo.js       # /proc + /sys collector — no native deps
│   ├── assets/icon.png  # generated app + tray icon
│   └── src/
│       ├── index.html   # seven-page shell
│       ├── styles.css   # Fluent dark theme
│       └── renderer.js  # tables, graphs, context menus, pages
├── scripts/
│   ├── gen-icon.js      # generates the PNG icon (no image libs)
│   └── make-deb.py      # builds the .deb via dpkg-deb
├── screenshots/
└── README.md
```

**Security model:** `contextIsolation` is enabled, `nodeIntegration` is disabled, and all system access is exposed through a narrow `preload.js` bridge. The renderer carries a Content-Security-Policy that blocks remote scripts.

---

## Roadmap

- Per-core CPU graphs on the Performance page
- Light theme toggle
- GPU power draw and per-process VRAM where the driver exposes it
- Effectiveness/efficiency core breakdown on hybrid CPUs
- Memory pressure and per-process disk I/O columns

Contributions welcome — open an issue first so we can align on direction.

---

## FAQ

**Is this affiliated with Microsoft?**
No. This is an independent, original implementation written for Linux. Windows and Task Manager are trademarks of Microsoft; this project is not endorsed by or connected to Microsoft. No Microsoft code was copied.

**Is any of my data uploaded?**
No. The app reads local kernel interfaces only, makes no outbound network requests, and loads no remote scripts or analytics.

**Why does GPU show `—` for a moment?**
GPU figures come from DRM fdinfo engine counters, which work without root on AMD, Intel and NVIDIA alike, so the column fills on any modern driver. A `—` can appear for the first second only (the collector needs two samples to compute a rate) or on very old kernels that expose no DRM counters at all. VRAM and clock readings are still shown where available.

**Why can't `Ctrl+Shift+Esc` be registered?**
On GNOME it is installed automatically as a system shortcut, so it cannot conflict. On other desktops the app falls back to an in-app grab — if another application already owns the key there, free it up in your DE's keyboard settings. The tray menu and app menu still open Task Manager.

**Does it work on Wayland?**
Yes. It is a normal Electron app; it runs on Wayland and X11 alike.

**Why is there no `sudo`?**
Ending a process or controlling services uses your own permissions. Actions needing elevation go through your desktop's polkit agent, exactly like any other system tool.

---

## License and disclaimer

Released under the [MIT License](LICENSE).

This project is an independent re-creation of a user interface for Linux. It is not affiliated with, endorsed by, or connected to Microsoft. All artwork and code here are original.
