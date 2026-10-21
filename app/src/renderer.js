/* Task Manager replica — renderer. Original implementation; no external code copied. */
'use strict';

const api = window.tm || null; // present inside Electron, absent in plain browser (mock mode)
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/* ---------- helpers ---------- */
const fmtBytes = (b) => {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return (i === 0 ? Math.round(b) : b.toFixed(b >= 100 ? 0 : b >= 10 ? 1 : 2)) + ' ' + u[i];
};
const fmtRate = (bps) => fmtBytes(bps) + '/s';
const fmtGHz = (mhz) => (mhz && mhz > 0 ? (mhz / 1000).toFixed(2) + ' GHz' : '—');
/* Windows writes cache sizes as "384 KB", "1.5 MB", "9.0 MB" */
const fmtCache = (kb) => {
  if (!kb || kb <= 0) return '—';
  if (kb >= 1024) { const mb = kb / 1024; return (mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)) + ' MB'; }
  return Math.round(kb) + ' KB';
};
/* Windows shows uptime as d:hh:mm:ss */
const fmtUptimeWin = (sec) => {
  sec = Math.max(0, Math.floor(sec || 0));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return `${d}:${p(h)}:${p(m)}:${p(s)}`;
};
/* round a byte rate up to a readable axis label */
const niceBytes = (b) => {
  if (!b || b <= 0) return '0';
  const u = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  const v = b >= 100 ? Math.round(b) : b >= 10 ? Math.round(b * 10) / 10 : Math.round(b * 100) / 100;
  return `${v} ${u[i]}`;
};
/* pick a tidy ceiling for an auto-scaling graph */
const axisCeiling = (peak) => {
  if (!peak || peak <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(peak)));
  const n = peak / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
};
const fmtUptime = (sec) => {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return (d ? d + ' day' + (d > 1 ? 's' : '') + ', ' : '') + `${pad(h)}:${pad(m)}:${pad(s)}`;
};
const fmtCpuTime = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* heat levels like the original: gray → white → yellow → orange → red */
function heatClass(pct) {
  if (pct == null || isNaN(pct)) return 'l1';
  if (pct >= 90) return 'l5';
  if (pct >= 60) return 'l4';
  if (pct >= 30) return 'l3';
  if (pct >= 1) return 'l2';
  return 'l1';
}
function memClass(kb) {
  if (!kb) return 'l1';
  const gb = kb / 1048576;
  if (gb >= 2) return 'l3';
  if (gb >= 0.8) return 'l2';
  return 'l1';
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ---------- state ---------- */
const state = {
  snap: null,
  page: 'processes',
  search: '',
  selPid: null,
  selGroup: null,       // startup page selection (desktop file base)
  selSvc: null,         // services page selection (unit)
  collapsed: new Set(), // collapsed group names
  onlyMine: false,
  perfSel: 'cpu',
  iconCache: new Map(),
  services: [],
  startup: [],
  appHist: [],
  settings: JSON.parse(localStorage.getItem('api-settings') || '{"speed":"1000","startpage":"processes","allusers":true}'),
};
function saveSettings() { localStorage.setItem('api-settings', JSON.stringify(state.settings)); }

/* ---------- window controls (Electron only) ---------- */
if (api) {
  $('#btn-min').onclick = () => api.minimize();
  $('#btn-max').onclick = () => api.maximize();
  $('#btn-close').onclick = () => api.close();
} else {
  $$('.tb-btn').forEach((b) => { b.style.display = 'none'; });
}

/* ---------- navigation ---------- */
function gotoPage(p) {
  state.page = p;
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === p));
  $$('.page').forEach((s) => s.classList.toggle('active', s.id === 'page-' + p));
  $('#statusbar').style.display = (p === 'processes' || p === 'details') ? 'flex' : 'none';
  if (p === 'services') loadServices();
  if (p === 'startup') loadStartup();
  if (p === 'apphistory') loadAppHistory();
  render();
}
$$('.nav-item').forEach((n) => { n.onclick = () => gotoPage(n.dataset.page); });

/* ---------- search ---------- */
function openSearch() {
  const wrap = $('.nav-search-wrap');
  if ($('#nav-search-input')) { $('#nav-search-input').focus(); return; }
  gotoPage('processes');
  wrap.innerHTML = '<input id="nav-search-input" type="text" placeholder="Search">';
  const inp = $('#nav-search-input');
  inp.value = state.search;
  inp.oninput = () => { state.search = inp.value.trim().toLowerCase(); render(); };
  inp.onkeydown = (e) => {
    if (e.key === 'Escape' || (e.key === 'Enter' && !state.search)) { state.search = ''; wrap.innerHTML = searchShell(); bindSearch(); }
    if (e.key === 'Enter') render();
  };
  inp.focus();
}
function searchShell() {
  return '<div id="nav-search" title="Search (Ctrl+F)">' +
    '<svg viewBox="0 0 16 16" width="14" height="14"><circle cx="6.5" cy="6.5" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/><line x1="10.5" y1="10.5" x2="15" y2="15" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>' +
    '<span>Search</span></div>';
}
function bindSearch() { const el = $('#nav-search'); if (el) el.onclick = openSearch; }
bindSearch();
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') { e.preventDefault(); openSearch(); }
});

/* ---------- context menu ---------- */
const ctx = $('#ctx-menu');
function showCtx(x, y, items) {
  ctx.innerHTML = items.map((it, i) =>
    `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${esc(it.label)}</button>`).join('');
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  ctx.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  ctx.querySelectorAll('button').forEach((b) => {
    b.onclick = () => { ctx.hidden = true; items[+b.dataset.i].fn(); };
  });
}
document.addEventListener('click', () => { ctx.hidden = true; });
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('.tbl')) ctx.hidden = true; });

/* ---------- icons ---------- */
const TILE_COLORS = ['#4cc2ff', '#6ccb5f', '#fce100', '#ffa06b', '#ff99a4', '#c7a0ff', '#56d4c8', '#f78fb3'];
function tileColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TILE_COLORS[h % TILE_COLORS.length];
}
async function iconHtml(p) {
  let url = state.iconCache.get(p.name);
  if (url === undefined) {
    url = null;
    if (api) {
      try {
        const path = await api.icon(p.name);
        if (path) url = 'file://' + encodeURI(path);
      } catch { /* ignore */ }
    }
    state.iconCache.set(p.name, url);
  }
  const letter = esc((p.name || '?')[0] || '?').toUpperCase();
  if (url) return `<span class="proc-icon"><img src="${esc(url)}" alt=""></span>`;
  return `<span class="proc-icon" style="background:${tileColor(p.name)}">${letter}</span>`;
}

/* ---------- Processes page ---------- */
function categorize(procs) {
  const apps = [], bg = [], sys = [];
  for (const p of procs) {
    if (p.kernel) sys.push(p);
    else if (p.isApp) apps.push(p);
    else bg.push(p);
  }
  return [['Apps', apps], ['Background processes', bg], ['System processes', sys]];
}
function byNameGroup(list) {
  const m = new Map();
  for (const p of list) {
    const key = p.name;
    let g = m.get(key);
    if (!g) { g = { name: key, count: 0, cpu: 0, memKB: 0, disk: 0, net: 0, gpu: 0, pids: [], suspended: false, icon: p }; m.set(key, g); }
    g.count++;
    g.cpu += p.cpuPercent || 0;
    g.memKB += p.rssKB || 0;
    g.disk = Math.max(g.disk, p.diskPercent || 0);
    g.pids.push(p.pid);
    if (p.state === 'T' || p.state === 't') g.suspended = true;
  }
  return [...m.values()].sort((a, b) => b.cpu - a.cpu || b.memKB - a.memKB);
}
let procIconPromises = [];
function renderProcesses() {
  const body = $('#proc-body');
  if (!state.snap) return;
  let procs = state.snap.procs;
  if (state.onlyMine) procs = procs.filter((p) => p.uid === state.snap.myUid);
  let html = '';
  let anyVisible = false;
  const matches = (g) => !state.search || g.name.toLowerCase().includes(state.search);
  for (const [label, list] of categorize(procs)) {
    if (!list.length) continue;
    const groups = byNameGroup(list).filter(matches);
    if (!groups.length) continue;
    anyVisible = true;
    const open = !state.collapsed.has(label);
    html += `<tr class="grp ${open ? 'open' : ''}" data-grp="${esc(label)}"><td colspan="7"><span class="grp-chev">▸</span>${esc(label)} (${list.length})</td></tr>`;
    if (!open) continue;
    for (const g of groups) {
      const sel = g.pids.includes(state.selPid) ? 'sel' : '';
      html += `<tr class="proc ${sel}" data-pid="${g.pids[0]}" data-name="${esc(g.name)}">` +
        `<td><div class="proc-name" data-icon="${esc(g.name)}"><span class="proc-icon" style="background:${tileColor(g.name)}">${esc(g.name[0] || '?').toUpperCase()}</span><span class="proc-label">${esc(g.name)}${g.count > 1 ? ` <span class="proc-count">(${g.count})</span>` : ''}</span></div></td>` +
        `<td><span class="status-chip ${g.suspended ? 'suspended' : ''}">${g.suspended ? 'Suspended' : ''}</span></td>` +
        `<td class="num heat ${heatClass(g.cpu)}">${g.cpu.toFixed(g.cpu >= 10 ? 0 : 1)}%</td>` +
        `<td class="num heat ${memClass(g.memKB)}">${g.memKB >= 1048576 ? (g.memKB / 1048576).toFixed(1) + ' GB' : Math.round(g.memKB / 1024) + ' MB'}</td>` +
        `<td class="num heat ${heatClass(g.disk)}">${g.disk > 0 ? g.disk.toFixed(1) + '%' : ''}</td>` +
        `<td class="num"></td><td class="num"></td></tr>`;
    }
  }
  body.innerHTML = html;
  $('#proc-empty').hidden = anyVisible;
  // upgrade icons async
  procIconPromises = [];
  body.querySelectorAll('[data-icon]').forEach((cell) => {
    const name = cell.dataset.icon;
    iconHtml({ name }).then((h) => {
      const holder = cell.querySelector('.proc-icon');
      if (holder) holder.outerHTML = h;
    });
  });
  body.querySelectorAll('tr.grp').forEach((tr) => {
    tr.onclick = () => {
      const g = tr.dataset.grp;
      if (state.collapsed.has(g)) state.collapsed.delete(g); else state.collapsed.add(g);
      render();
    };
  });
  body.querySelectorAll('tr.proc').forEach((tr) => {
    tr.onclick = () => { state.selPid = +tr.dataset.pid; state.selName = tr.dataset.name; $('#btn-end-task').disabled = false; render(); };
    tr.oncontextmenu = (e) => {
      e.preventDefault();
      state.selPid = +tr.dataset.pid; state.selName = tr.dataset.name;
      $('#btn-end-task').disabled = false;
      const pid = +tr.dataset.pid, name = tr.dataset.name;
      showCtx(e.clientX, e.clientY, [
        { label: 'End task', danger: true, fn: () => endTasks([pid], name) },
        { label: 'Copy PID', fn: () => { navigator.clipboard?.writeText(String(pid)); toast('Copied PID ' + pid); } },
      ]);
      render();
    };
  });
}
async function endTasks(pids, name) {
  if (!api) { toast('End task requires the desktop app'); return; }
  for (const pid of pids) {
    const r = await api.kill(pid, false);
    if (!r.ok && !/already exited/i.test(r.error || '')) { toast(`Failed to end ${name}: ${r.error}`, true); return; }
  }
  toast(`Ended ${name || 'process'} (${pids.length} process${pids.length > 1 ? 'es' : ''})`);
}
$('#btn-end-task').onclick = async () => {
  if (state.selPid == null) return;
  const procs = state.snap.procs;
  // end every pid sharing the selected process name (matches grouping behavior)
  const name = (procs.find((p) => p.pid === state.selPid) || {}).name;
  const pids = procs.filter((p) => p.name === name).map((p) => p.pid);
  await endTasks(pids, name);
};

/* ---------- Run new task dialog ---------- */
const dlg = $('#dialog-overlay');
$('#btn-run-new').onclick = () => { dlg.hidden = false; $('#dlg-input').value = ''; $('#dlg-input').focus(); };
$('#dlg-cancel').onclick = () => { dlg.hidden = true; };
$('#dlg-ok').onclick = async () => {
  const cmd = $('#dlg-input').value.trim();
  if (!cmd) return;
  if (!api) { toast('Run new task requires the desktop app'); dlg.hidden = true; return; }
  const r = await api.runTask(cmd);
  dlg.hidden = true;
  if (r.ok) toast(`Started: ${cmd}`); else toast('Failed: ' + (r.error || 'unknown'), true);
};
$('#dlg-input').onkeydown = (e) => { if (e.key === 'Enter') $('#dlg-ok').click(); if (e.key === 'Escape') dlg.hidden = true; };
dlg.onclick = (e) => { if (e.target === dlg) dlg.hidden = true; };

/* ---------- Performance page ---------- */
const gpuValue = (g) => {
  if (g.percent != null) return g.percent.toFixed(0) + '%';
  if (g.vramTotal) return `${fmtBytes(g.vramUsed)}/${fmtBytes(g.vramTotal)}`;
  if (g.curMHz) return g.curMHz + ' MHz';
  return '—';
};
const perfDefs = () => {
  const s = state.snap;
  if (!s) return [{ id: 'cpu', name: 'CPU', value: '—' }];
  const out = [];
  out.push({ id: 'cpu', name: 'CPU', value: `${s.cpuPercent.toFixed(0)}%   ${fmtGHz(s.freqMHz)}` });
  const m = s.mem;
  out.push({ id: 'mem', name: 'Memory', value: `${fmtBytes(m.used)}/${fmtBytes(m.total)} (${m.percent.toFixed(0)}%)` });
  (s.disks || []).forEach((d, i) => out.push({
    id: 'disk' + i,
    name: `Disk ${i} (${d.name})`,
    sub: [d.media, d.bus ? `(${d.bus})` : ''].filter(Boolean).join(' '),
    value: `${d.percent.toFixed(0)}%`,
  }));
  (s.nets || []).forEach((n, i) => out.push({
    id: 'net' + i,
    name: n.label || n.iface,
    sub: `S: ${fmtRate(n.txBytesPerSec)}   R: ${fmtRate(n.rxBytesPerSec)}`,
    value: '',
  }));
  (s.gpus || []).forEach((g, i) => out.push({
    id: 'gpu' + i,
    name: g.name || `GPU ${i}`,
    sub: [g.vendor, g.driver ? `(${g.driver})` : ''].filter(Boolean).join(' '),
    value: gpuValue(g),
  }));
  return out;
};
function drawGraph(canvas, series, opts) {
  const ctx2 = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  ctx2.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2.clearRect(0, 0, w, h);
  // grid
  ctx2.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx2.fillStyle = 'rgba(255,255,255,0.35)';
  ctx2.font = '10px sans-serif';
  ctx2.lineWidth = 1;
  const maxV = opts.max || 100;
  const steps = opts.steps || 4;
  for (let i = 0; i <= steps; i++) {
    const y = (h - 22) * i / steps + 0.5;
    ctx2.beginPath(); ctx2.moveTo(0, y); ctx2.lineTo(w, y); ctx2.stroke();
    const lbl = opts.fmtLabel ? opts.fmtLabel(maxV * (steps - i) / steps) : Math.round(maxV * (steps - i) / steps) + '%';
    if (lbl) ctx2.fillText(lbl, 2, y - 3);
  }
  // vertical gridlines (time)
  for (let i = 1; i < 6; i++) {
    const x = w * i / 6 + 0.5;
    ctx2.beginPath(); ctx2.moveTo(x, 0); ctx2.lineTo(x, h - 22); ctx2.stroke();
  }
  for (const s of series) {
    const data = s.data;
    if (!data || !data.length) continue;
    const n = data.length;
    ctx2.beginPath();
    data.forEach((v, i) => {
      const x = (w - 1) * i / Math.max(1, n - 1);
      const y = (h - 22) * (1 - Math.min(1, Math.max(0, v / maxV)));
      if (i === 0) ctx2.moveTo(x, y); else ctx2.lineTo(x, y);
    });
    ctx2.strokeStyle = s.color; ctx2.lineWidth = 1.6; ctx2.stroke();
    // fill
    ctx2.lineTo((w - 1), h - 22); ctx2.lineTo(0, h - 22); ctx2.closePath();
    const grad = ctx2.createLinearGradient(0, 0, 0, h - 22);
    grad.addColorStop(0, s.fill); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx2.fillStyle = grad; ctx2.fill();
  }
}
function perfSeries(id) {
  const s = state.snap;
  const style = { color: '#4cc2ff', fill: 'rgba(76,194,255,0.28)' };
  const flat = () => ({ series: [], max: 100, axisLabel: '100%' });
  if (!s) return flat();
  const H = s.history || {};
  const pct = (data) => ({ series: [{ data: data || [], ...style }], max: 100, axisLabel: '100%' });
  if (id === 'cpu') return pct(H.cpu);
  if (id === 'mem') return pct(H.mem);
  if (id.startsWith('disk')) return pct((H.disks || [])[+id.slice(4)] || H.disk);
  if (id.startsWith('net')) {
    // raw bytes/sec → auto-scaled axis, like the original's Kbps scale
    const data = (H.nets || [])[+id.slice(3)] || [];
    const peak = data.reduce((a, b) => Math.max(a, b), 0);
    const max = axisCeiling(Math.max(peak, 1024));
    return { series: [{ data: data.map((v) => (v / max) * 100), ...style }], max: 100, axisLabel: niceBytes(max) };
  }
  if (id.startsWith('gpu')) return pct((H.gpus || [])[+id.slice(3)]);
  return flat();
}
function renderPerfList() {
  const el = $('#perf-list');
  el.innerHTML = perfDefs().map((d) =>
    `<div class="perf-item ${d.id === state.perfSel ? 'active' : ''}" data-id="${d.id}">` +
    `<div><div class="pi-name">${esc(d.name)}</div>` +
    (d.sub ? `<div class="pi-sub">${esc(d.sub)}</div>` : '') +
    (d.value ? `<div class="pi-val">${esc(d.value)}</div>` : '') +
    `</div>` +
    `<canvas data-spark="${d.id}" width="80" height="34"></canvas></div>`).join('');
  el.querySelectorAll('.perf-item').forEach((it) => { it.onclick = () => { state.perfSel = it.dataset.id; render(); }; });
  el.querySelectorAll('canvas[data-spark]').forEach((c) => {
    const { series } = perfSeries(c.dataset.spark);
    drawGraph(c, series, { max: 100, steps: 2, fmtLabel: () => '' });
  });
}
function renderPerfDetail() {
  const s = state.snap;
  if (!s) return;
  const id = state.perfSel;
  const c = s.cpu || {};
  /* rows: array of rows, each row an array of { l: label, v: value, big: bool } */
  /* right: array of [label, value] pairs in the specification column */
  const set = (t, sub, rows, right, graph) => {
    $('#perf-title').textContent = t;
    $('#perf-sub').textContent = sub || '';
    $('#perf-bigstat').innerHTML = rows.map((row) =>
      `<div class="bs-row">${row.map((st) =>
        `<div class="bs ${st.big ? 'big' : 'med'}"><span>${esc(st.l)}</span><b>${esc(st.v)}</b></div>`).join('')}</div>`).join('');
    $('#perf-stats').innerHTML = (right || []).map((p) =>
      `<div class="ps"><span>${esc(p[0])}</span><b>${esc(p[1])}</b></div>`).join('');
    const g = graph || {};
    $('#perf-graph-label').textContent = g.label || '';
    $('#perf-graph-max').textContent = g.max || '';
    $('#gl-start').textContent = g.start || '';
    $('#gl-end').textContent = g.end || '';
  };
  const timeAxis = (label) => ({ label: label || '% Utilization', max: '100%', start: '60 seconds', end: '0' });

  if (id === 'cpu') {
    set('CPU', c.model || s.cpuModel, [
      [
        { l: 'Utilization', v: s.cpuPercent.toFixed(0) + '%', big: true },
        { l: 'Speed', v: fmtGHz(s.freqMHz), big: true },
      ],
      [
        { l: 'Processes', v: String(s.procs.length) },
        { l: 'Threads', v: String(s.threadsTotal || s.procs.reduce((a, p) => a + (p.threads || 0), 0)) },
        { l: 'Handles', v: s.handles ? s.handles.toLocaleString() : '—' },
      ],
      [
        { l: 'Up time', v: fmtUptimeWin(s.uptimeSec), big: true },
      ],
    ], [
      ['Base speed', c.baseMHz ? fmtGHz(c.baseMHz) : (s.cpuMaxMHz ? fmtGHz(s.cpuMaxMHz) : '—')],
      ['Sockets', String(c.sockets || 1)],
      ['Cores', String(c.cores || s.corePcts.length)],
      ['Logical processors', String(c.logical || s.ncpu)],
      ['Virtualisation', c.virtualisation || '—'],
      ['L1 cache', fmtCache(c.cache && c.cache.l1KB)],
      ['L2 cache', fmtCache(c.cache && c.cache.l2KB)],
      ['L3 cache', fmtCache(c.cache && c.cache.l3KB)],
      ['1m load average', (s.load ? s.load[0] : 0).toFixed(2)],
    ], timeAxis('% Utilization'));
  } else if (id === 'mem') {
    const m = s.mem;
    set('Memory', '', [
      [
        { l: 'In use', v: fmtBytes(m.used), big: true },
        { l: 'Available', v: fmtBytes(m.available), big: true },
      ],
      [
        { l: 'Committed', v: `${fmtBytes(m.commitTotal)} / ${fmtBytes(m.commitLimit)}` },
        { l: 'Cached', v: fmtBytes(m.cached) },
        { l: 'Swap', v: `${fmtBytes(m.swapUsed)} / ${fmtBytes(m.swapTotal)}` },
      ],
    ], [
      ['Physical memory', fmtBytes(m.total)],
      ['Paged pool', fmtBytes(m.paged || 0)],
      ['Non-paged pool', fmtBytes(m.nonPaged || 0)],
      ['Utilization', m.percent.toFixed(0) + '%'],
    ], timeAxis('% in use'));
  } else if (id.startsWith('disk')) {
    const i = +id.slice(4);
    const d = s.disks[i];
    if (!d) return;
    set(`Disk ${i} (${d.name})`, [d.media, d.bus ? `(${d.bus})` : ''].filter(Boolean).join(' '), [
      [
        { l: 'Read', v: fmtRate(d.readBytesPerSec), big: true },
        { l: 'Write', v: fmtRate(d.writeBytesPerSec), big: true },
      ],
      [
        { l: 'Active time', v: d.percent.toFixed(0) + '%' },
      ],
    ], [
      ['Model', d.model || '—'],
      ['Capacity', d.sizeGB ? d.sizeGB + ' GB' : '—'],
      ['Media', [d.media, d.bus].filter(Boolean).join(' ') || '—'],
      ['Type', d.removable ? 'Removable' : 'Fixed disk'],
    ], timeAxis('% active time'));
  } else if (id.startsWith('net')) {
    const n = s.nets[+id.slice(3)];
    if (!n) return;
    set(n.label || n.iface, n.ipv4, [
      [
        { l: 'Receive', v: fmtRate(n.rxBytesPerSec), big: true },
        { l: 'Send', v: fmtRate(n.txBytesPerSec), big: true },
      ],
      [
        { l: 'Throughput', v: fmtRate(n.rxBytesPerSec + n.txBytesPerSec) },
      ],
    ], [
      ['Adapter', n.iface],
      ['IPv4', n.ipv4 || '—'],
      ['Connection', n.kind || '—'],
    ], null);
  } else if (id.startsWith('gpu')) {
    const g = s.gpus[+id.slice(3)];
    if (!g) return;
    set(g.name, [g.vendor, g.driver ? `(${g.driver})` : ''].filter(Boolean).join(' '), [
      [
        { l: 'Utilization', v: g.percent == null ? '—' : g.percent.toFixed(0) + '%', big: true },
        { l: 'Dedicated memory', v: g.vramTotal ? `${fmtBytes(g.vramUsed)}/${fmtBytes(g.vramTotal)}` : '—', big: true },
      ],
    ], [
      ['Vendor', g.vendor || '—'],
      ['Driver', g.driver || '—'],
      ['Dedicated total', g.vramTotal ? fmtBytes(g.vramTotal) : '—'],
      ['Dedicated usage', g.vramTotal ? ((g.vramUsed / g.vramTotal) * 100).toFixed(0) + '%' : '—'],
      ['Current clock', g.curMHz ? g.curMHz + ' MHz' : '—'],
      ['Max clock', g.maxMHz ? g.maxMHz + ' MHz' : '—'],
    ], null);
  }
  const { series, max, axisLabel } = perfSeries(id);
  drawGraph($('#perf-canvas'), series, { max, steps: 4, fmtLabel: () => '' });
  $('#perf-graph-max').textContent = axisLabel || $('#perf-graph-max').textContent;
}

/* ---------- App history ---------- */
async function loadAppHistory() {
  if (!api) { state.appHist = mockAppHist(); renderAppHistory(); return; }
  const r = await api.appHistory();
  if (r.ok) { state.appHist = r.list; renderAppHistory(); }
}
function renderAppHistory() {
  const body = $('#hist-body');
  if (!state.snap) return;
  const curCpu = new Map();
  for (const p of state.snap.procs) {
    const k = p.groupKey || p.name.toLowerCase();
    curCpu.set(k, (curCpu.get(k) || 0) + (p.cpuPercent || 0));
  }
  body.innerHTML = state.appHist.slice(0, 80).map((h) => {
    const avg = h.cpuSeconds / Math.max(1, state.snap.uptimeSec) * 100;
    return `<tr><td>${esc(h.name)}</td><td>${fmtCpuTime(h.cpuSeconds)}</td>` +
      `<td class="num heat ${heatClass(avg)}">${avg.toFixed(2)}%</td></tr>`;
  }).join('') || '<tr><td colspan="3" class="empty-note">No history collected yet — keep Task Manager running.</td></tr>';
}

/* ---------- Startup apps ---------- */
async function loadStartup() {
  if (!api) { state.startup = mockStartup(); renderStartup(); return; }
  const r = await api.startup();
  if (r.ok) { state.startup = r.list; renderStartup(); }
}
function renderStartup() {
  const body = $('#startup-body');
  body.innerHTML = state.startup.map((s) => {
    const sel = state.selSvc === s.base ? 'sel' : '';
    const impact = s.status === 'Enabled' ? 'Medium' : 'None';
    return `<tr class="proc ${sel}" data-base="${esc(s.base)}"><td>${esc(s.name)}</td>` +
      `<td>${esc((s.publisher || '').slice(0, 48))}</td>` +
      `<td><span class="status-chip">${esc(s.status)}</span></td><td>${impact}</td></tr>`;
  }).join('');
  $('#startup-empty').hidden = state.startup.length > 0;
  body.querySelectorAll('tr').forEach((tr) => {
    tr.onclick = () => { state.selSvc = tr.dataset.base; $('#btn-startup-enable').disabled = false; $('#btn-startup-disable').disabled = false; renderStartup(); };
  });
}
async function setStartup(enable) {
  if (!api || !state.selSvc) return;
  const r = await api.startupSet(state.selSvc, enable);
  if (!r.ok) toast('Failed: ' + r.error, true);
  else { toast(enable ? 'Enabled' : 'Disabled'); loadStartup(); }
}
$('#btn-startup-enable').onclick = () => setStartup(true);
$('#btn-startup-disable').onclick = () => setStartup(false);

/* ---------- Users ---------- */
function renderUsers() {
  if (!state.snap) return;
  const byUid = new Map();
  for (const p of state.snap.procs) {
    if (p.uid == null) continue;
    let u = byUid.get(p.uid);
    if (!u) { u = { name: p.uidName, cpu: 0, memKB: 0, n: 0 }; byUid.set(p.uid, u); }
    u.cpu += p.cpuPercent || 0; u.memKB += p.rssKB || 0; u.n++;
  }
  const list = [...byUid.values()].sort((a, b) => b.cpu - a.cpu);
  $('#users-body').innerHTML = list.map((u) =>
    `<tr><td>${esc(u.name)}</td><td><span class="status-chip">Running</span></td>` +
    `<td class="num heat ${heatClass(u.cpu)}">${u.cpu.toFixed(1)}%</td>` +
    `<td class="num heat ${memClass(u.memKB)}">${fmtBytes(u.memKB * 1024)}</td>` +
    `<td class="num">${u.n}</td></tr>`).join('');
}

/* ---------- Details ---------- */
function renderDetails() {
  if (!state.snap) return;
  let procs = [...state.snap.procs].sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0));
  if (state.search) procs = procs.filter((p) => p.name.toLowerCase().includes(state.search) || String(p.pid).includes(state.search));
  const body = $('#details-body');
  body.innerHTML = procs.map((p) => {
    const sel = p.pid === state.selPid ? 'sel' : '';
    return `<tr class="proc ${sel}" data-pid="${p.pid}">` +
      `<td>${esc(p.name)}</td><td class="num">${p.pid}</td>` +
      `<td><span class="status-chip ${p.state === 'T' ? 'suspended' : ''}">${p.state === 'T' ? 'Suspended' : (p.state === 'Z' ? 'Zombie' : 'Running')}</span></td>` +
      `<td>${esc(p.uidName)}</td>` +
      `<td class="num heat ${heatClass(p.cpuPercent)}">${(p.cpuPercent || 0).toFixed(1)}%</td>` +
      `<td class="num heat ${memClass(p.rssKB)}">${fmtBytes(p.rssKB * 1024)}</td>` +
      `<td title="${esc(p.cmdline || '')}">${esc((p.cmdline || p.comm || '').slice(0, 70))}</td></tr>`;
  }).join('');
  body.querySelectorAll('tr').forEach((tr) => {
    const pid = +tr.dataset.pid;
    tr.onclick = () => { state.selPid = pid; $('#btn-details-end').disabled = false; renderDetails(); };
    tr.oncontextmenu = (e) => {
      e.preventDefault();
      const p = state.snap.procs.find((x) => x.pid === pid);
      showCtx(e.clientX, e.clientY, [
        { label: 'End task', danger: true, fn: () => endTasks([pid], p ? p.name : '') },
        { label: 'Copy PID', fn: () => { navigator.clipboard?.writeText(String(pid)); toast('Copied PID ' + pid); } },
      ]);
    };
  });
}
$('#btn-details-end').onclick = async () => {
  if (state.selPid == null) return;
  const p = state.snap.procs.find((x) => x.pid === state.selPid);
  await endTasks([state.selPid], p ? p.name : '');
};

/* ---------- Services ---------- */
async function loadServices() {
  $('#services-empty').hidden = false;
  $('#services-empty').textContent = 'Loading services…';
  if (!api) { state.services = mockServices(); renderServices(); return; }
  const r = await api.services();
  if (r.ok) { state.services = r.list; renderServices(); }
  else { $('#services-empty').textContent = 'Could not load services: ' + r.error; }
}
function renderServices() {
  const body = $('#services-body');
  let list = state.services;
  if (state.search) list = list.filter((s) => s.name.toLowerCase().includes(state.search) || (s.description || '').toLowerCase().includes(state.search));
  body.innerHTML = list.map((s) => {
    const sel = state.selSvc === s.unit ? 'sel' : '';
    return `<tr class="proc ${sel}" data-unit="${esc(s.unit)}">` +
      `<td>${esc(s.name)}</td><td class="num">${s.pid || ''}</td>` +
      `<td title="${esc(s.description)}">${esc((s.description || '').slice(0, 60))}</td>` +
      `<td><span class="status-chip">${esc(s.status)}</span></td><td>${esc(s.startup)}</td></tr>`;
  }).join('');
  $('#services-empty').hidden = list.length > 0;
  if (!list.length && state.services.length) $('#services-empty').textContent = 'No services match your search.';
  body.querySelectorAll('tr').forEach((tr) => {
    tr.onclick = () => {
      state.selSvc = tr.dataset.unit;
      ['#btn-svc-start', '#btn-svc-stop', '#btn-svc-restart'].forEach((b) => { $(b).disabled = false; });
      renderServices();
    };
  });
}
async function svcAction(action) {
  if (!api || !state.selSvc) return;
  toast(`${action[0].toUpperCase() + action.slice(1)} ${state.selSvc}…`);
  const r = await api.serviceAction(state.selSvc, action);
  if (!r.ok) toast(`${action} failed: ${r.error}`, true);
  else toast(`${action} OK`);
  loadServices();
}
$('#btn-svc-start').onclick = () => svcAction('start');
$('#btn-svc-stop').onclick = () => svcAction('stop');
$('#btn-svc-restart').onclick = () => svcAction('restart');

/* ---------- Settings ---------- */
$('#set-speed').onchange = (e) => {
  state.settings.speed = e.target.value; saveSettings();
  if (api) api.setPaused(e.target.value === 'paused');
};
$('#set-startpage').onchange = (e) => { state.settings.startpage = e.target.value; saveSettings(); };
$('#set-allusers').onchange = (e) => { state.settings.allusers = e.target.checked; saveSettings(); state.onlyMine = !e.target.checked; render(); };
$('#set-background').onchange = async (e) => {
  const on = e.target.checked;
  if (api) { const s = await api.setSettings({ backgroundOnClose: on }); $('#set-background').checked = s.backgroundOnClose; }
  toast(on ? 'Closing the window now hides Task Manager instead' : 'Closing the window now quits Task Manager');
};

/* ---------- Status bar ---------- */
function renderStatus() {
  const s = state.snap;
  if (!s) return;
  $('#st-procs').textContent = 'Processes ' + s.procs.length;
  $('#st-cpu').textContent = 'CPU ' + s.cpuPercent.toFixed(0) + '%';
  $('#st-mem').textContent = 'Memory ' + s.mem.percent.toFixed(0) + '%';
  $('#st-disk').textContent = 'Disk ' + (s.disks.length ? (s.disks.reduce((a, d) => a + d.percent, 0) / s.disks.length).toFixed(0) : '0') + '%';
  $('#st-net').textContent = 'Network ' + s.history.net.at(-1).toFixed(0) + '%';
}

/* ---------- master render ---------- */
function render() {
  if (state.page === 'processes') renderProcesses();
  else if (state.page === 'performance') { renderPerfList(); renderPerfDetail(); }
  else if (state.page === 'apphistory') renderAppHistory();
  else if (state.page === 'startup') renderStartup();
  else if (state.page === 'users') renderUsers();
  else if (state.page === 'details') renderDetails();
  else if (state.page === 'services') renderServices();
  renderStatus();
}

/* ---------- mock data (plain-browser preview mode) ---------- */
function mockSnapshot() {
  const rnd = (a, b) => a + Math.random() * (b - a);
  const names = [
    ['firefox', 'user', false, 960], ['code', 'user', false, 720], ['gnome-shell', 'user', true, 380],
    ['Xwayland', 'user', true, 140], ['node', 'user', false, 260], ['slack', 'user', false, 640],
    ['pipewire', 'user', true, 60], ['wireplumber', 'user', true, 40], ['systemd', 'root', true, 12],
    ['systemd-journald', 'root', true, 22], ['systemd-udevd', 'root', true, 18], ['NetworkManager', 'root', true, 26],
    ['dbus-daemon', 'root', true, 14], ['pulseaudio', 'user', true, 48], ['kworker/u32:3', 'root', true, 0],
    ['kworker/1:2-events', 'root', true, 0], ['kthreadd', 'root', true, 0], ['bash', 'user', false, 3],
    ['gnome-terminal-', 'user', false, 90], ['tracker-miner-fs-3', 'user', true, 30],
    ['evolution-alarm', 'user', true, 35], ['snapd', 'root', true, 55], ['cupsd', 'root', true, 10],
    ['gjs', 'user', true, 25], ['xdg-desktop-portal', 'user', true, 20], ['abrt-dump-journal', 'root', true, 5],
  ];
  let pid = 1200;
  const procs = names.map(([n, u, sys, memMB], i) => ({
    pid: pid + i * 7, ppid: 1, name: n, comm: n, uid: u === 'root' ? 0 : 1000, uidName: u,
    state: 'S', tty: sys ? 0 : 7, cpuTicks: 0, threads: Math.round(rnd(1, 14)),
    rssKB: memMB * 1024 * rnd(0.8, 1.2), cmdline: n + ' --force-profile=default', exe: '/usr/bin/' + n,
    kernel: n.startsWith('k'), starttime: 0, readBytes: 0, writeBytes: 0,
    cpuPercent: sys && n.startsWith('k') ? 0 : rnd(0, i < 3 ? 24 : 4), diskPercent: rnd(0, 1.5),
    isApp: !sys, groupKey: n,
  }));
  const cores = Array.from({ length: 8 }, () => rnd(2, 55));
  const cpuPct = cores.reduce((a, b) => a + b) / cores.length;
  const hist = mockHist;
  const push = (arr, v) => { arr.push(v); if (arr.length > 180) arr.shift(); };
  push(hist.cpu, cpuPct); push(hist.mem, rnd(48, 66)); push(hist.disk, rnd(0, 12)); push(hist.net, rnd(0, 25));
  cores.forEach((c, i) => push(hist.cores[i] || (hist.cores[i] = []), c));
  (hist.disks[0] || (hist.disks[0] = [])).push(rnd(0, 9));
  (hist.disks[1] || (hist.disks[1] = [])).push(rnd(0, 40));
  (hist.nets[0] || (hist.nets[0] = [])).push(rnd(0, 7e5));
  (hist.nets[1] || (hist.nets[1] = [])).push(rnd(0, 7e5));
  (hist.gpus[0] || (hist.gpus[0] = [])).push(rnd(0, 88));
  (hist.gpus[1] || (hist.gpus[1] = [])).push(0);
  return {
    ts: Date.now(), ncpu: 8, myUid: 1000, cpuPercent: cpuPct, corePcts: cores,
    freqMHz: rnd(3500, 4100), cpuModel: 'MockBeast Processor 8-Core @ 3.60GHz', cpuMaxMHz: 3600,
    cpu: {
      model: 'MockBeast Processor 8-Core @ 3.60GHz', sockets: 1, cores: 8, logical: 8,
      baseMHz: 3600, maxMHz: 4200, virtualisation: 'Enabled',
      cache: { l1KB: 384, l2KB: 2048, l3KB: 9216 },
    },
    handles: 98061, threadsTotal: 3141,
    mem: { total: 16e9, used: 10.2e9, available: 5.7e9, cached: 1.9e9, swapTotal: 2e9, swapUsed: 1.2e8, commitTotal: 5.4e9, commitLimit: 1e10, percent: 64 },
    disks: [
      { name: 'sda', model: 'TOSHIBA MQ01ABD1', sizeGB: 1000, removable: false, media: 'HDD', bus: 'SATA', readBytesPerSec: rnd(0, 3e6), writeBytesPerSec: rnd(0, 1.2e6), percent: rnd(0, 9) },
      { name: 'sdb', model: 'Netac SSD 120GB', sizeGB: 120, removable: false, media: 'SSD', bus: 'SATA', readBytesPerSec: rnd(0, 8e6), writeBytesPerSec: rnd(0, 4e6), percent: rnd(0, 40) },
    ],
    nets: [
      { iface: 'enp2s0', label: 'Ethernet', kind: 'Ethernet', rxBytesPerSec: rnd(0, 5e5), txBytesPerSec: rnd(0, 2e5), ipv4: '—' },
      { iface: 'wlp3s0', label: 'Wi-Fi', kind: 'Wi-Fi', rxBytesPerSec: rnd(0, 5e5), txBytesPerSec: rnd(0, 2e5), ipv4: '203.0.113.42' }, // RFC 5737 documentation range — always fake
    ],
    gpus: [
      { id: 0, name: 'GPU 0', vendor: 'AMD', driver: 'amdgpu', percent: Math.round(rnd(0, 88)), vramTotal: 4e9, vramUsed: rnd(0.2e9, 3.4e9), curMHz: 300, maxMHz: 1800 },
      { id: 1, name: 'GPU 1', vendor: 'Intel', driver: 'i915', percent: null, vramTotal: 0, vramUsed: 0, curMHz: 350, maxMHz: 1100 },
    ],
    netTotalPerSec: rnd(0, 7e5), uptimeSec: 7 * 3600 + 512, load: [1.42, 1.18, 0.95],
    procs, history: hist,
  };
}
const mockHist = { cpu: [], cores: [], mem: [], disk: [], net: [], disks: [[], []], nets: [[], []], gpus: [[], []] };
function mockAppHist() {
  return [
    { name: 'firefox', cpuSeconds: 5230 }, { name: 'code', cpuSeconds: 4120 }, { name: 'gnome-shell', cpuSeconds: 2890 },
    { name: 'node', cpuSeconds: 1440 }, { name: 'slack', cpuSeconds: 980 }, { name: 'systemd', cpuSeconds: 320 },
    { name: 'Xwayland', cpuSeconds: 210 }, { name: 'pipewire', cpuSeconds: 130 },
  ];
}
function mockStartup() {
  return [
    { base: 'firefox.desktop', name: 'Firefox', publisher: 'Mozilla', status: 'Enabled' },
    { base: 'slack.desktop', name: 'Slack', publisher: 'Slack Technologies', status: 'Enabled' },
    { base: 'spotify.desktop', name: 'Spotify', publisher: 'Spotify AB', status: 'Disabled' },
    { base: 'discord.desktop', name: 'Discord', publisher: 'Discord Inc.', status: 'Enabled' },
  ];
}
function mockServices() {
  const base = [
    ['ssh', 'OpenBSD Secure Shell server', 'Running', 'enabled'],
    ['cups', 'CUPS Scheduler', 'Running', 'enabled'],
    ['bluetooth', 'Bluetooth service', 'Running', 'enabled'],
    ['avahi-daemon', 'mDNS/DNS-SD Stack', 'Running', 'enabled'],
    ['snapd', 'Snap Daemon', 'Running', 'enabled'],
    ['unattended-upgrades', 'Unattended Upgrades', 'Stopped', 'enabled'],
    [' ModemManager', 'Modem Manager', 'Stopped', 'disabled'],
  ];
  return base.map(([n, d, st, su], i) => ({ unit: n.trim() + '.service', name: n.trim(), description: d, pid: st === 'Running' ? 800 + i * 13 : 0, status: st, sub: '', startup: su }));
}

/* ---------- boot ---------- */
async function boot() {
  // settings UI init
  $('#set-speed').value = state.settings.speed;
  $('#set-startpage').value = state.settings.startpage;
  $('#set-allusers').checked = state.settings.allusers;
  state.onlyMine = !state.settings.allusers;

  if (api) {
    if (state.settings.speed === 'paused') api.setPaused(true);
    try {
      const st = await api.getSettings();
      $('#set-background').checked = st.backgroundOnClose !== false;
      if (st.hotkey) $('#set-hotkey').textContent = st.hotkey;
    } catch { /* older main */ }
    const init = await api.initial();
    state.snap = init.snap;
    api.onSnapshot((snap) => {
      state.snap = snap;
      if (state.settings.speed === '2000') { if ((snap.ts / 1000 | 0) % 2) return; } // low refresh
      render();
    });
  } else {
    // browser preview: mock feed
    for (let i = 0; i < 30; i++) state.snap = mockSnapshot(); // prime history
    setInterval(() => { state.snap = mockSnapshot(); render(); }, 1000);
  }

  gotoPage(state.settings.startpage || 'processes');
  setInterval(() => { if (state.page === 'services' && api) loadServices(); }, 20000);
}
boot();
