'use strict';
/* Linux system collector — reads /proc directly. Pure Node, no native deps. */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const NCPU = os.cpus().length || 1;
let HZ = 100;
try { HZ = parseInt(require('child_process').execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim(), 10) || 100; } catch { /* default */ }
const PAGE_KB = 4;
const DISK_BASELINE = 250 * 1024 * 1024; // bytes/sec considered "100%" activity

function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readLink(p) { try { return fs.readlinkSync(p); } catch { return null; } }

const currentUid = process.getuid ? process.getuid() : 1000;
let uidNames = null;
function uidToName(uid) {
  if (!uidNames) {
    uidNames = new Map();
    const txt = read('/etc/passwd') || '';
    for (const line of txt.split('\n')) {
      const f = line.split(':');
      if (f.length >= 4) uidNames.set(parseInt(f[2], 10), f[0]);
    }
  }
  return uidNames.get(uid) || String(uid);
}

/* ---------- static CPU facts (parsed once, they never change) ---------- */
function parseSizeKB(txt) {
  if (!txt) return 0;
  const m = String(txt).trim().match(/^([\d.]+)\s*([KMG]?)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = { '': 1 / 1024, k: 1, m: 1024, g: 1048576 }[m[2].toLowerCase()];
  return n * mult;
}
let cpuTopoCache = null;
function cpuTopology() {
  if (cpuTopoCache) return cpuTopoCache;
  const t = {
    model: (os.cpus()[0] && os.cpus()[0].model) || 'CPU',
    baseMHz: 0, maxMHz: 0, sockets: 1, cores: NCPU, logical: NCPU,
    virtualisation: 'Disabled', cache: { l1KB: 0, l2KB: 0, l3KB: 0 },
  };
  const txt = read('/proc/cpuinfo') || '';
  const pairs = new Set(), physIds = new Set();
  let flags = '';
  for (const block of txt.split(/\n\s*\n/)) {
    let physId = null, coreId = null;
    for (const line of block.split('\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const k = line.slice(0, i).trim().toLowerCase();
      const v = line.slice(i + 1).trim();
      if (k === 'model name') t.model = v;
      else if (k === 'physical id') physId = v;
      else if (k === 'core id') coreId = v;
      else if (k === 'flags' || k === 'features') flags = v;
    }
    if (physId !== null || coreId !== null) {
      physIds.add(String(physId));
      pairs.add(String(physId) + '/' + String(coreId));
    }
  }
  if (pairs.size) t.cores = pairs.size;
  if (physIds.size) t.sockets = physIds.size;
  t.logical = NCPU;
  t.virtualisation = /(^|\s)(vmx|svm)(\s|$)/i.test(flags) ? 'Enabled' : 'Disabled';

  // base speed: sysfs is authoritative, then "@ X.XXGHz" in the model name
  const baseKHz = parseInt(read('/sys/devices/system/cpu/cpu0/cpufreq/base_frequency') || '', 10);
  const maxKHz = parseInt(read('/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq') || '', 10);
  if (Number.isFinite(baseKHz)) t.baseMHz = baseKHz / 1000;
  if (Number.isFinite(maxKHz)) t.maxMHz = maxKHz / 1000;
  if (!t.baseMHz) {
    const m = t.model.match(/@\s*([\d.]+)\s*(GHz|MHz|THz)/i);
    if (m) {
      const scale = { mhz: 1, ghz: 1e3, thz: 1e6 }[m[2].toLowerCase()] || 1;
      t.baseMHz = parseFloat(m[1]) * scale;
    }
  }

  // caches from sysfs (per-core L1/L2 summed from cpu0's cache indices, L3 is shared)
  const cdir = '/sys/devices/system/cpu/cpu0/cache';
  try {
    for (const idx of fs.readdirSync(cdir)) {
      const lvl = parseInt(read(`${cdir}/${idx}/level`) || '', 10);
      const kb = parseSizeKB(read(`${cdir}/${idx}/size`));
      if (lvl === 1) t.cache.l1KB += kb;
      else if (lvl === 2) t.cache.l2KB = Math.max(t.cache.l2KB, kb);
      else if (lvl === 3) t.cache.l3KB = Math.max(t.cache.l3KB, kb);
    }
  } catch { /* no sysfs */ }

  cpuTopoCache = t;
  return t;
}

/* ---------- GPU engine activity via DRM fdinfo ----------
 * Per-process and system-wide GPU busy time comes from the kernel's DRM client
 * usage stats: every fd a process holds on /dev/dri exposes cumulative
 * drm-engine-<name> busy nanoseconds in /proc/<pid>/fdinfo/<fd>. Sampling the
 * counters twice gives a real busy percentage — this is what KDE KSystemStats
 * and Mission Center do, it needs no root, and it works on both amdgpu and
 * i915 (verified on this machine: Intel render engine + amdgpu).            */
const drmProcCache = new Map(); // pid -> { starttime, fds, scannedAt, prev: Map, prevAt }
const pdevBusy = new Map();     // PCI device id -> busiest-engine busy % derived from fdinfo
const GPU_FD_RESCAN_MS = 10000; // how often a process's DRM fd list is re-enumerated
let gpuSystemAt = 0;
let engineDeltas = new Map();   // 'pdev|engine' -> summed busy ns since last sample
const engineCaps = new Map();   // 'pdev|engine' -> capacity (>1 engines count as one unit)

function parseDrmFdinfo(txt) {
  let pdev = '', client = '';
  const engines = new Map();
  for (const line of txt.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i), v = line.slice(i + 1).trim();
    if (k === 'drm-pdev') pdev = v;
    else if (k === 'drm-client-id') client = v;
    else if (k.startsWith('drm-engine-capacity-')) engineCaps.set(pdev + '|' + k.slice(20), parseInt(v, 10) || 1);
    else if (k.startsWith('drm-engine-')) {
      const ns = parseInt(v, 10);
      if (Number.isFinite(ns)) engines.set(k.slice(12), ns);
    }
  }
  return pdev && engines.size ? { pdev, client, engines } : null;
}

function sampleGpuClients(procs) {
  const now = Date.now();
  const procPct = new Map(); // pid -> % (busiest engine, like Windows Task Manager)
  const live = new Set();
  for (const p of procs) {
    if (p.kernel) continue;
    live.add(p.pid);
    let rec = drmProcCache.get(p.pid);
    if (!rec || rec.starttime !== p.starttime) {
      // stagger first scans so 300 processes don't all rescan on the same tick
      rec = { starttime: p.starttime, fds: [], scannedAt: 0, prev: new Map(), prevAt: 0 };
      drmProcCache.set(p.pid, rec);
    }
    if (now - rec.scannedAt > GPU_FD_RESCAN_MS) {
      rec.scannedAt = now;
      rec.fds = [];
      try {
        for (const fd of fs.readdirSync('/proc/' + p.pid + '/fd')) {
          try {
            if (fs.readlinkSync('/proc/' + p.pid + '/fd/' + fd).startsWith('/dev/dri/')) rec.fds.push(fd);
          } catch { /* fd closed mid-scan */ }
        }
      } catch { continue; } // gone, or another user's process (no permission)
    }
    if (!rec.fds.length) continue;
    // one entry per DRM client: duplicated fds share a client id and the same
    // counters, so keep the max per engine instead of summing
    const clients = new Map();
    for (const fd of rec.fds) {
      let txt;
      try { txt = fs.readFileSync('/proc/' + p.pid + '/fdinfo/' + fd, 'utf8'); } catch { continue; }
      const info = parseDrmFdinfo(txt);
      if (!info) continue;
      const ck = info.pdev + '|' + info.client;
      const slot = clients.get(ck);
      if (!slot) clients.set(ck, info);
      else for (const [e, ns] of info.engines) if (ns > (slot.engines.get(e) ?? 0)) slot.engines.set(e, ns);
    }
    if (!clients.size) continue;
    const totals = new Map(); // 'pdev|engine' -> busy ns across this process's clients
    for (const { pdev, engines } of clients.values())
      for (const [e, ns] of engines) totals.set(pdev + '|' + e, (totals.get(pdev + '|' + e) || 0) + ns);
    const dtMs = now - rec.prevAt;
    if (rec.prevAt && dtMs >= 200) {
      let best = 0;
      for (const [k, ns] of totals) {
        const prevNs = rec.prev.get(k);
        if (prevNs == null || ns <= prevNs) { rec.prev.set(k, ns); continue; }
        const cap = engineCaps.get(k) || 1;
        const pct = ((ns - prevNs) / (dtMs * 1e6 * cap)) * 100;
        if (pct > best) best = pct;
        engineDeltas.set(k, (engineDeltas.get(k) || 0) + (ns - prevNs) / cap);
      }
      rec.prev = totals;
      if (best > 0) procPct.set(p.pid, Math.min(100, best));
    } else {
      rec.prev = totals; // prime the counters; first interval has no delta yet
    }
    rec.prevAt = now;
  }
  if (drmProcCache.size > 4000 && live.size < drmProcCache.size / 2)
    for (const pid of [...drmProcCache.keys()]) if (!live.has(pid)) drmProcCache.delete(pid);

  // system busy per GPU = busiest engine summed across all clients (Windows
  // shows the busiest engine too, not an average of engines)
  if (gpuSystemAt && now - gpuSystemAt >= 200) {
    const dtMs = now - gpuSystemAt;
    pdevBusy.clear();
    for (const [k, dNs] of engineDeltas) {
      const pct = (dNs / (dtMs * 1e6)) * 100;
      const pdev = k.slice(0, k.indexOf('|'));
      if (pct > (pdevBusy.get(pdev) || 0)) pdevBusy.set(pdev, Math.min(100, pct));
    }
    engineDeltas = new Map();
    gpuSystemAt = now;
  } else if (!gpuSystemAt) gpuSystemAt = now;
  return procPct;
}

/* NVIDIA proprietary totals via nvidia-smi (fdinfo only covers nouveau) */
const nvidia = { checked: false, avail: false, at: 0, rows: null, busy: false };
function refreshNvidia(now) {
  if (!nvidia.checked) {
    nvidia.checked = true;
    nvidia.avail = ['nvidia-smi'].some((b) =>
      fs.existsSync('/usr/bin/' + b) || fs.existsSync('/usr/local/bin/' + b));
  }
  if (!nvidia.avail || nvidia.busy || now - nvidia.at < 2500) return;
  nvidia.busy = true;
  execFile('nvidia-smi',
    ['--query-gpu=utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
    { timeout: 3000 }, (err, out) => {
      nvidia.busy = false;
      nvidia.at = Date.now();
      if (err) return;
      nvidia.rows = String(out).trim().split('\n').map((l) => l.split(',').map((s) => parseInt(s, 10)));
    });
}

/* ---------- GPU cards (static identity is cached, busy % re-read each sample) ---------- */
let gpuStaticCache = null;
function gpuCards() {
  if (!gpuStaticCache) {
    const list = [];
    let cards = [];
    try { cards = fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n)); } catch { cards = []; }
    cards.sort((a, b) => (+a.slice(4)) - (+b.slice(4)));
    for (let i = 0; i < cards.length; i++) {
      const base = `/sys/class/drm/${cards[i]}`;
      const vendorId = (read(base + '/device/vendor') || '').trim().toLowerCase();
      let driver = '', pdev = '';
      try { driver = path.basename(fs.readlinkSync(base + '/device/driver')); } catch { /* no driver */ }
      try { pdev = path.basename(fs.readlinkSync(base + '/device')); } catch { /* no device */ }
      const vendor = vendorId === '0x1002' || vendorId === '0x1008' ? 'AMD'
        : vendorId === '0x8086' ? 'Intel'
        : vendorId === '0x10de' ? 'NVIDIA'
        : (driver || 'GPU');
      list.push({
        id: i, name: 'GPU ' + i, vendor, driver, pdev,
        vramTotal: parseInt(read(base + '/device/mem_info_vram_total') || '0', 10) || 0,
        maxMHz: parseInt(read(base + '/gt_max_freq_mhz') || '0', 10) || 0,
        base,
      });
    }
    gpuStaticCache = list;
  }
  refreshNvidia(Date.now());
  let nvidiaIdx = 0;
  return gpuStaticCache.map((g) => {
    let busy = parseInt(read(g.base + '/device/gpu_busy_percent') || '', 10);
    if (!Number.isFinite(busy)) {
      busy = pdevBusy.get(g.pdev);
      // fdinfo-capable driver (amdgpu/i915/radeon/nouveau): no engine activity
      // seen means the card is idle — report 0 rather than 'not available'
      if (busy === undefined && /amdgpu|i915|radeon|nouveau/.test(g.driver)) busy = 0;
      if (busy === undefined) busy = null;
    }
    let vramUsed = parseInt(read(g.base + '/device/mem_info_vram_used') || '0', 10) || 0;
    if (g.vendor === 'NVIDIA' && nvidia.rows && nvidia.rows[nvidiaIdx]) {
      const r = nvidia.rows[nvidiaIdx++]; // util%, mem used MiB, mem total MiB
      if (Number.isFinite(r[0])) busy = r[0];
      if (Number.isFinite(r[1])) vramUsed = r[1] * 1048576;
      if (Number.isFinite(r[2]) && !g.vramTotal) g.vramTotal = r[2] * 1048576;
    }
    return {
      id: g.id, name: g.name, vendor: g.vendor, driver: g.driver,
      percent: busy, vramTotal: g.vramTotal, vramUsed,
      curMHz: parseInt(read(g.base + '/gt_cur_freq_mhz') || '0', 10) || 0,
      maxMHz: g.maxMHz,
    };
  });
}

/* ---------- network adapter labels (Windows calls them Ethernet / Ethernet 2 / Wi-Fi) ---------- */
const netLabelCache = new Map(); // iface -> { label, kind, seq }
function netLabel(iface) {
  const rec = netLabelCache.get(iface);
  if (rec) return rec;
  const kind = /^(wl|wifi|wlp)/i.test(iface) ? 'Wi-Fi'
    : /^(en|eth|em)/i.test(iface) ? 'Ethernet'
    : /^p\d/i.test(iface) ? 'Ethernet'
    : 'Network';
  let seq = 1;
  for (const r of netLabelCache.values()) if (r.kind === kind) seq++;
  const out = { label: seq <= 1 ? kind : `${kind} ${seq}`, kind, seq };
  netLabelCache.set(iface, out);
  return out;
}

function desktopState() {
  const state = {
    procs: [], procByPid: new Map(),
    cpu: null, mem: null, disks: [], nets: [], load: null, uptimeSec: 0,
  };
  const now = Date.now();
  state.ts = now;

  // ---- per-process ----
  let entries = [];
  try { entries = fs.readdirSync('/proc'); } catch { return state; }
  for (const e of entries) {
    if (!/^\d+$/.test(e)) continue;
    const dir = '/proc/' + e;
    const stat = read(dir + '/stat');
    if (!stat) continue; // process died mid-scan
    const rp = stat.lastIndexOf(')');
    if (rp < 0) continue;
    const comm = stat.slice(stat.indexOf('(') + 1, rp);
    const rest = stat.slice(rp + 2).split(' ');
    const state2 = rest[0];
    const ppid = +rest[1] || 0;
    const ttyNr = +rest[4] || 0;
    const utime = +rest[11] || 0, stime = +rest[12] || 0;
    const threads = +rest[17] || 0;
    const starttime = +rest[19] || 0;
    const statm = read(dir + '/statm');
    const rssPages = statm ? +statm.split(' ')[1] || 0 : 0;
    let uid = null, vmsKB = 0;
    const statusTxt = read(dir + '/status');
    if (statusTxt) {
      for (const line of statusTxt.split('\n')) {
        if (line.startsWith('Uid:')) uid = +line.split(/\s+/)[1];
        else if (line.startsWith('VmRSS:')) vmsKB = +line.split(/\s+/)[1];
      }
    }
    const cmdlineRaw = read(dir + '/cmdline') || '';
    const cmdline = cmdlineRaw.replace(/\0/g, ' ').trim();
    const exe = readLink(dir + '/exe');
    const cwd = readLink(dir + '/cwd');
    let rbytes = null, wbytes = null;
    const io = read(dir + '/io');
    if (io) {
      for (const line of io.split('\n')) {
        if (line.startsWith('read_bytes:')) rbytes = +line.split(':')[1];
        else if (line.startsWith('write_bytes:')) wbytes = +line.split(':')[1];
      }
    }
    let name = comm;
    if (exe) name = path.basename(exe);
    else if (cmdline) {
      const t = cmdline.split(' ')[0];
      if (t && !t.startsWith('-')) name = path.basename(t).replace(/:.*$/, '') || comm;
    }
    state.procs.push({
      pid: +e, ppid, name, comm, uid, uidName: uid == null ? '?' : uidToName(uid),
      state: state2, tty: ttyNr, cpuTicks: utime + stime, threads,
      rssKB: vmsKB || rssPages * PAGE_KB, cmdline, exe, cwd,
      kernel: !exe && !cmdline, starttime,
      readBytes: rbytes, writeBytes: wbytes,
      cpuMs: Math.round(((utime + stime) / HZ) * 1000),
    });
  }
  return state;
}

// previous sampling state
let prev = { proc: new Map(), cpu: null, cores: [], disks: new Map(), nets: new Map(), at: 0 };
const appCpuTicks = new Map(); // exe basename -> cumulative ticks (for App history)
const history = { cpu: [], cores: [], mem: [], disk: [], net: [], disks: [], nets: [], gpus: [] };
const HIST_MAX = 180;
function pushHist(arr, v) { arr.push(v); if (arr.length > HIST_MAX) arr.shift(); }

// per-pid cache of "is an interactive app" (has DISPLAY/WAYLAND env or a tty)
const displayCache = new Map(); // pid -> { starttime, isApp }
function procIsApp(p) {
  if (p.kernel) return false;
  if (p.tty && p.tty > 0) return true;
  if (p.uid !== currentUid) return false;
  const c = displayCache.get(p.pid);
  if (c && c.starttime === p.starttime) return c.isApp;
  let isApp = false;
  try {
    const env = fs.readFileSync(`/proc/${p.pid}/environ`, 'utf8').slice(0, 4096);
    isApp = env.includes('DISPLAY=') || env.includes('WAYLAND_DISPLAY=');
  } catch { isApp = false; }
  if (displayCache.size > 2000) displayCache.clear();
  displayCache.set(p.pid, { starttime: p.starttime, isApp });
  return isApp;
}

function sample() {
  const s = desktopState();
  const now = s.ts;
  const dt = prev.at ? (now - prev.at) / 1000 : 0;

  // ---- global CPU ----
  const statTxt = read('/proc/stat') || '';
  const lines = statTxt.split('\n');
  const cores = [];
  let totalCpu = null;
  for (const line of lines) {
    if (/^cpu\d*\s/.test(line)) {
      const f = line.split(/\s+/).slice(1).map(Number);
      const total = f[0] + f[1] + f[2] + f[3] + f[4] + f[5] + f[6] + f[7];
      const idle = f[3] + (f[4] || 0);
      const rec = { total, idle };
      if (line.startsWith('cpu ')) totalCpu = rec; else cores.push(rec);
    } else if (totalCpu) break;
  }
  let cpuPct = 0, corePcts = [];
  if (totalCpu && prev.cpu && dt > 0) {
    const dTotal = totalCpu.total - prev.cpu.total;
    const dIdle = totalCpu.idle - prev.cpu.idle;
    cpuPct = dTotal > 0 ? Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100)) : 0;
    for (let i = 0; i < cores.length; i++) {
      if (prev.cores[i]) {
        const t = cores[i].total - prev.cores[i].total;
        const id = cores[i].idle - prev.cores[i].idle;
        corePcts.push(t > 0 ? Math.max(0, Math.min(100, ((t - id) / t) * 100)) : 0);
      } else corePcts.push(0);
    }
  } else corePcts = cores.map(() => 0);
  prev.cpu = totalCpu; prev.cores = cores;

  // ---- memory ----
  const mi = {};
  const memTxt = read('/proc/meminfo') || '';
  for (const line of memTxt.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) mi[m[1]] = +m[2] * 1024; // bytes
  }
  const memTotal = mi.MemTotal || 0;
  const memAvail = mi.MemAvailable || 0;
  const memUsed = Math.max(0, memTotal - memAvail);
  const cached = (mi.Cached || 0) + (mi.Buffers || 0);
  const swapTotal = mi.SwapTotal || 0;
  const swapUsed = swapTotal - (mi.SwapFree || 0);
  const commitTotal = memTotal - memAvail + swapTotal - (mi.SwapFree || 0);
  const mem = {
    total: memTotal, used: memUsed, available: memAvail, cached,
    swapTotal, swapUsed, commitTotal, commitLimit: (mi.CommitLimit || 0),
    paged: mi.Cached || 0, nonPaged: mi.Mlocked || 0,
    percent: memTotal ? (memUsed / memTotal) * 100 : 0,
  };

  // ---- disks ----
  const disks = [];
  let diskActivity = 0;
  {
    let devs = [];
    try { devs = fs.readdirSync('/sys/block'); } catch { devs = []; }
    for (const d of devs) {
      if (/^(loop|ram|zram|fd|sr)/.test(d)) continue;
      const rem = (read(`/sys/block/${d}/removable`) || '').trim();
      const dsTxt = read('/proc/diskstats');
      if (!dsTxt) break;
      for (const line of dsTxt.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 14 || f[2] !== d) continue;
        const sectorsRead = +f[5], sectorsWritten = +f[9];
        const rec = { sectorsRead, sectorsWritten };
        const p = prev.disks.get(d);
        let rbSec = 0, wbSec = 0;
        if (p && dt > 0) {
          rbSec = Math.max(0, (sectorsRead - p.sectorsRead) * 512 / dt);
          wbSec = Math.max(0, (sectorsWritten - p.sectorsWritten) * 512 / dt);
        }
        prev.disks.set(d, rec);
        const model = (read(`/sys/block/${d}/device/model`) || '').trim();
        const sizeGB = Math.round(+((read(`/sys/block/${d}/size`) || 0) * 512 / 1e9));
        const rotational = (read(`/sys/block/${d}/queue/rotational`) || '').trim();
        const media = rotational === '0' ? 'SSD' : rotational === '1' ? 'HDD' : '';
        let bus = 'SATA';
        if (/^nvme/.test(d)) bus = 'NVMe';
        else if (/^mmcblk/.test(d)) bus = 'MMC';
        else if (/^(vd|xvd|hd)/.test(d)) bus = 'VirtIO';
        else if ((read(`/sys/block/${d}/device/vendor`) || '').trim().toLowerCase().includes('usb')) bus = 'USB';
        disks.push({
          name: d, model: model || d.toUpperCase(), sizeGB, removable: rem === '1',
          media, bus, readBytesPerSec: rbSec, writeBytesPerSec: wbSec,
          percent: Math.min(100, ((rbSec + wbSec) / DISK_BASELINE) * 100),
        });
        break;
      }
    }
    diskActivity = disks.reduce((a, d) => a + d.percent, 0) / (disks.length || 1);
  }

  // ---- network ----
  const nets = [];
  let netTotalPerSec = 0;
  {
    const nd = read('/proc/net/dev') || '';
    for (const line of nd.split('\n').slice(2)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const iface = line.slice(0, idx).trim();
      if (iface === 'lo' || !iface) continue;
      const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
      const rec = { rx: f[0], tx: f[8] };
      const p = prev.nets.get(iface);
      let rxS = 0, txS = 0;
      if (p && dt > 0) {
        rxS = Math.max(0, (rec.rx - p.rx) / dt);
        txS = Math.max(0, (rec.tx - p.tx) / dt);
      }
      prev.nets.set(iface, rec);
      const os2 = require('os');
      const addrs = (os2.networkInterfaces()[iface] || []).filter(a => a.family === 'IPv4').map(a => a.address);
      const label = netLabel(iface);
      nets.push({
        iface, label: label.label, kind: label.kind, rxBytesPerSec: rxS, txBytesPerSec: txS,
        ipv4: addrs.join(', ') || '—', internal: false,
      });
      netTotalPerSec += rxS + txS;
    }
  }
  prev.at = now;

  // ---- per-process cpu % / io %, group app cpu accumulation ----
  const procMap = new Map();
  for (const p of s.procs) {
    procMap.set(p.pid, p);
    const pr = prev.proc.get(p.pid);
    let cpuP = 0;
    if (pr && dt > 0) {
      const dTicks = p.cpuTicks - pr.cpuTicks;
      cpuP = Math.max(0, (dTicks / HZ / dt) * 100 / NCPU);
    }
    p.cpuPercent = cpuP;
    let ioPct = null;
    if (pr && pr.readBytes != null && p.readBytes != null && dt > 0) {
      const dB = Math.max(0, (p.readBytes - pr.readBytes) + (p.writeBytes - pr.writeBytes));
      ioPct = Math.min(100, (dB / dt / DISK_BASELINE) * 100);
    }
    p.diskPercent = ioPct;
    p.isApp = procIsApp(p);
    const key = (p.exe ? path.basename(p.exe) : (p.comm || '')).toLowerCase();
    appCpuTicks.set(key, (appCpuTicks.get(key) || 0) + Math.max(0, (pr ? p.cpuTicks - pr.cpuTicks : 0)));
    p.groupKey = key;
  }
  prev.proc = procMap;    // ---- per-process GPU busy (DRM fdinfo) ----
  const gpuPctByPid = sampleGpuClients(s.procs);
  for (const p of s.procs) p.gpuPercent = gpuPctByPid.get(p.pid) || 0;

  // ---- history ----
  const gpus = gpuCards();
  pushHist(history.cpu, cpuPct);
  while (history.cores.length < corePcts.length) history.cores.push([]);
  for (let i = 0; i < corePcts.length; i++) pushHist(history.cores[i], corePcts[i]);
  pushHist(history.mem, mem.percent);
  pushHist(history.disk, diskActivity);
  pushHist(history.net, Math.min(100, (netTotalPerSec / (2 * 1024 * 1024)) * 100)); // 2 MB/s = 100%
  while (history.disks.length < disks.length) history.disks.push([]);
  for (let i = 0; i < disks.length; i++) pushHist(history.disks[i], disks[i].percent);
  while (history.nets.length < nets.length) history.nets.push([]);
  for (let i = 0; i < nets.length; i++) {
    pushHist(history.nets[i], nets[i].rxBytesPerSec + nets[i].txBytesPerSec); // raw bytes/sec, scaled by the renderer
  }
  while (history.gpus.length < gpus.length) history.gpus.push([]);
  for (let i = 0; i < gpus.length; i++) pushHist(history.gpus[i], gpus[i].percent == null ? 0 : gpus[i].percent);

  const upTxt = read('/proc/uptime');
  const uptimeSec = upTxt ? +upTxt.split(' ')[0] : 0;
  const loadTxt = read('/proc/uptime') && (read('/proc/loadavg') || '');
  const load = loadTxt ? loadTxt.split(' ').slice(0, 3).map(Number) : [0, 0, 0];

  let freqMHz = 0, maxMHz = 0;
  const cpuinfo = read('/proc/cpuinfo') || '';
  for (const line of cpuinfo.split('\n')) {
    if (/^cpu MHz\s*:/.test(line)) { freqMHz = Math.max(freqMHz, +line.split(':')[1]); }
  }

  const topo = cpuTopology();
  if (!freqMHz) freqMHz = topo.baseMHz || topo.maxMHz;
  if (!maxMHz) maxMHz = topo.maxMHz;

  // Windows "Handles" ≈ open file handles; Linux tracks this in one cheap read
  let handles = 0;
  const fnr = read('/proc/sys/fs/file-nr');
  if (fnr) handles = parseInt(fnr.split(/\s+/)[0], 10) || 0;
  let threadTotal = 0;
  for (const p of s.procs) threadTotal += p.threads || 0;

  return {
    ts: now, ncpu: NCPU, myUid: currentUid, cpuPercent: cpuPct, corePcts, freqMHz, cpuModel: topo.model, cpuMaxMHz: maxMHz,
    cpu: {
      model: topo.model, sockets: topo.sockets, cores: topo.cores, logical: NCPU,
      baseMHz: topo.baseMHz || 0, maxMHz: maxMHz || topo.maxMHz,
      virtualisation: topo.virtualisation, cache: topo.cache,
    },
    handles, threadsTotal: threadTotal,
    gpus: gpus,
    mem, disks, nets, netTotalPerSec, uptimeSec, load,
    procs: s.procs,
    history: { cpu: history.cpu, cores: history.cores, mem: history.mem, disk: history.disk, net: history.net, disks: history.disks, nets: history.nets, gpus: history.gpus },
  };
}

// ---------- services ----------
let servicesCache = { at: 0, list: [] };
function listServices(cb) {
  if (Date.now() - servicesCache.at < 5000 && servicesCache.list.length) return cb(null, servicesCache.list);
  execFile('systemctl',
    ['show', '--type=service', '--all', '--no-pager',
      '--property=Id,Description,MainPID,ActiveState,SubState,UnitFileState,FragmentPath'],
    { timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return cb(err, []);
      const out = [];
      for (const block of stdout.split(/\n\n/)) {
        if (!block.trim()) continue;
        const o = {};
        for (const line of block.split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) o[line.slice(0, i)] = line.slice(i + 1);
        }
        if (!o.Id || !o.FragmentPath || o.FragmentPath === '') continue;
        out.push({
          unit: o.Id, name: o.Id.replace(/\.service$/, ''),
          description: o.Description || '', pid: +o.MainPID || 0,
          status: o.ActiveState === 'active' ? 'Running' : (o.ActiveState === 'failed' ? 'Failed' : 'Stopped'),
          sub: o.SubState || '', startup: o.UnitFileState || '',
        });
      }
      servicesCache = { at: Date.now(), list: out };
      cb(null, out);
    });
}
function serviceAction(unit, action, cb) {
  if (!/^[A-Za-z0-9@_.\-]+$/.test(unit) || !['start', 'stop', 'restart'].includes(action)) {
    return cb(new Error('invalid arguments'));
  }
  execFile('systemctl', [action, unit], { timeout: 15000 }, (err, _so, se) => {
    servicesCache.at = 0;
    if (err) return cb(new Error((se || err.message || '').split('\n').slice(0, 2).join(' ')));
    cb(null);
  });
}

// ---------- startup apps (XDG autostart) ----------
function parseDesktop(file) {
  const txt = read(file);
  if (!txt || !txt.includes('[Desktop Entry]')) return null;
  const o = { file };
  let inEntry = false;
  for (const line of txt.split('\n')) {
    if (line.trim() === '[Desktop Entry]') { inEntry = true; continue; }
    if (line.startsWith('[')) { inEntry = false; continue; }
    if (!inEntry) continue;
    const i = line.indexOf('=');
    if (i > 0) o[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (o.NoDisplay === 'true' || o.Hidden === 'true') return null;
  if (!o.Name) return null;
  return o;
}
function listStartup(cb) {
  const dirs = [path.join(os.homedir(), '.config/autostart'), '/etc/xdg/autostart'];
  const seen = new Set();
  const out = [];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      const d = parseDesktop(path.join(dir, f));
      if (!d) continue;
      const disabledByUser = out.some(x => x.base === f && x.userOverride);
      const enabled = d.X_GNOME_Autostart_enabled !== 'false' && !disabledByUser;
      const exec0 = (d.Exec || '').split(' ')[0].replace(/^.*\//, '').replace(/\.desktop$/, '');
      out.push({
        base: f, name: d.Name, publisher: d.Comment ? d.Comment.slice(0, 60) : (d.Exec || ''),
        status: enabled ? 'Enabled' : 'Disabled', exe: exec0,
        userOverride: dir.includes(os.homedir()),
      });
    }
  }
  cb(null, out);
}
function setStartupState(base, enable, cb) {
  if (!/^[A-Za-z0-9._\-]+\.desktop$/.test(base)) return cb(new Error('bad name'));
  const userDir = path.join(os.homedir(), '.config/autostart');
  const userFile = path.join(userDir, base);
  try {
    if (!enable) {
      fs.mkdirSync(userDir, { recursive: true });
      let txt = read(userFile) || read('/etc/xdg/autostart/' + base);
      if (!txt) {
        txt = `[Desktop Entry]\nType=Application\nName=${base}\nHidden=true\n`;
      } else {
        txt = txt.replace(/^X-GNOME-Autostart-enabled=.*$/gm, '').replace(/^Hidden=.*$/gm, '').trimEnd() +
          '\nX-GNOME-Autostart-enabled=false\nHidden=true\n';
      }
      fs.writeFileSync(userFile, txt);
    } else {
      if (fs.existsSync(userFile)) fs.unlinkSync(userFile);
    }
    cb(null);
  } catch (e) { cb(e); }
}

// ---------- app history (cumulative cpu per exe) ----------
function appHistory() {
  const out = [];
  for (const [k, ticks] of appCpuTicks) {
    if (ticks <= 0) continue;
    out.push({ name: k, cpuSeconds: ticks / HZ });
  }
  out.sort((a, b) => b.cpuSeconds - a.cpuSeconds);
  return out.slice(0, 200);
}

// ---------- users ----------
function listUsers(snap) {
  const byUid = new Map();
  for (const p of snap.procs) {
    if (p.uid == null) continue;
    const u = byUid.get(p.uid) || { uid: p.uid, name: uidToName(p.uid), procs: 0, cpuPercent: 0, memKB: 0 };
    u.procs++;
    u.cpuPercent += p.cpuPercent || 0;
    u.memKB += p.rssKB || 0;
    byUid.set(p.uid, u);
  }
  return [...byUid.values()].sort((a, b) => b.cpuPercent - a.cpuPercent);
}

// ---------- icons ----------
let iconCache = null;
function buildIconIndex() {
  if (iconCache) return iconCache;
  iconCache = new Map();
  const dirs = [path.join(os.homedir(), '.local/share/applications'), '/usr/share/applications', '/var/lib/snapd/desktop/applications'];
  const pairs = [];
  for (const dir of dirs) {
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.desktop')); } catch { continue; }
    for (const f of files) {
      const txt = read(path.join(dir, f));
      if (!txt) continue;
      const nm = (txt.match(/^Name=(.*)$/m) || [])[1];
      const ex = (txt.match(/^Exec=(.*)$/m) || [])[1];
      const ic = (txt.match(/^Icon=(.*)$/m) || [])[1];
      if (!ic) continue;
      const exeBase = ex ? ex.split(' ')[0].replace(/^.*\//, '').toLowerCase() : '';
      pairs.push({ exeBase, name: (nm || '').toLowerCase(), icon: ic });
    }
  }
  iconCache.pairs = pairs;
  return iconCache;
}
function resolveIcon(iconSpec) {
  if (!iconSpec) return null;
  if (iconSpec.startsWith('/') && fs.existsSync(iconSpec)) return iconSpec;
  const sizes = ['128x128', '64x64', '48x48', '32x32', 'scalable'];
  const roots = [path.join(os.homedir(), '.local/share/icons'), '/usr/share/icons', '/usr/share/pixmaps'];
  for (const root of roots) {
    for (const sz of sizes) {
      for (const ext of ['png', 'svg']) {
        const p = path.join(root, 'hicolor', sz, 'apps', iconSpec + '.' + ext);
        if (fs.existsSync(p)) return p;
      }
    }
    for (const ext of ['png', 'svg', 'xpm']) {
      const p = path.join(root, iconSpec + '.' + ext);
      if (fs.existsSync(p)) return p;
    }
    // flat dirs (breeze/adwaita)
    try {
      for (const sub of fs.readdirSync(root)) {
        for (const sz of sizes) {
          const p = path.join(root, sub, sz, 'apps', iconSpec + '.png');
          if (fs.existsSync(p)) return p;
        }
      }
    } catch { /* ignore */ }
  }
  return null;
}
function iconForProcess(name) {
  const idx = buildIconIndex();
  const key = (name || '').toLowerCase();
  let hit = idx.pairs.find(p => p.exeBase === key) || idx.pairs.find(p => p.name === key);
  if (hit) {
    const p = resolveIcon(hit.icon);
    if (p) return p;
  }
  // direct guesses
  for (const guess of [key, key.replace(/-bin$/, '')]) {
    const p = resolveIcon(guess);
    if (p) return p;
  }
  return null;
}

// ---------- misc actions ----------
function endTask(pid, signal, cb) {
  pid = +pid;
  if (!Number.isInteger(pid) || pid <= 1) return cb(new Error('invalid pid'));
  try {
    process.kill(pid, signal || 'SIGTERM');
    cb(null);
  } catch (e) { cb(e); }
}

module.exports = {
  sample, listServices, serviceAction, listStartup, setStartupState,
  appHistory, listUsers, iconForProcess, endTask,
  PAGE_KB,
};
