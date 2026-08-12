'use strict';

// Pi health collector — reads live system state from the machine NEURO runs on.
// Everything degrades gracefully: on Windows (dev) or when a tool is missing,
// the section comes back null rather than throwing. The panel renders what it gets.

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const IS_LINUX = process.platform === 'linux';

// Travelstar Z5K500 rated load/unload cycles — see .claude/memory + pi5-external-hdd
const LOAD_CYCLE_RATING = 600000;

// SMART spins up the disk and takes ~1s, so it gets its own longer cache
const SMART_TTL_MS = 5 * 60 * 1000;
const PM2_TTL_MS = 15 * 1000;

const cache = new Map();

function run(cmd, args, timeout = 5000) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && !stdout) return resolve({ ok: false, out: '', err: err.message });
      resolve({ ok: true, out: String(stdout || ''), err: String(stderr || '') });
    });
  });
}

async function cached(key, ttl, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.val;
  const val = await fn();
  cache.set(key, { at: Date.now(), val });
  return val;
}

function readFile(path) {
  try { return fs.readFileSync(path, 'utf8'); } catch { return null; }
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------- host + cpu

function getHost() {
  const model = readFile('/proc/device-tree/model');
  return {
    hostname: os.hostname(),
    // device-tree strings are NUL-terminated
    model: model ? model.replace(/\0/g, '').trim() : null,
    platform: process.platform,
    kernel: os.release(),
    uptimeSec: Math.round(os.uptime()),
    bootedAt: new Date(Date.now() - os.uptime() * 1000).toISOString(),
    nodeVersion: process.version
  };
}

async function getCpu() {
  const cores = os.cpus().length || 1;
  const [load1, load5, load15] = os.loadavg();

  // thermal_zone0 is the SoC sensor on a Pi; millidegrees C
  let tempC = null;
  const raw = readFile('/sys/class/thermal/thermal_zone0/temp');
  if (raw) tempC = Math.round((num(raw) / 1000) * 10) / 10;
  if (tempC === null && IS_LINUX) {
    const r = await run('vcgencmd', ['measure_temp'], 3000);
    const m = r.out.match(/temp=([\d.]+)/);
    if (m) tempC = num(m[1]);
  }

  let freqMHz = null;
  const f = readFile('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
  if (f) freqMHz = Math.round(num(f) / 1000);

  return {
    cores,
    load1, load5, load15,
    // load relative to core count — 1.0 per core is "fully busy"
    loadPct: Math.min(100, Math.round((load1 / cores) * 100)),
    tempC,
    freqMHz
  };
}

// Raspberry Pi throttle bitmask. Low bits = happening now, high bits = happened since boot.
const THROTTLE_BITS = [
  [0,  'now',   'Under-voltage'],
  [1,  'now',   'ARM frequency capped'],
  [2,  'now',   'Currently throttled'],
  [3,  'now',   'Soft temperature limit'],
  [16, 'since', 'Under-voltage occurred'],
  [17, 'since', 'ARM frequency capping occurred'],
  [18, 'since', 'Throttling occurred'],
  [19, 'since', 'Soft temperature limit occurred']
];

async function getPower() {
  if (!IS_LINUX) return null;
  const r = await run('vcgencmd', ['get_throttled'], 3000);
  const m = r.out.match(/throttled=0x([0-9a-fA-F]+)/);
  if (!m) return null;

  const mask = parseInt(m[1], 16);
  const now = [];
  const since = [];
  for (const [bit, when, label] of THROTTLE_BITS) {
    if (mask & (1 << bit)) (when === 'now' ? now : since).push(label);
  }
  return { raw: `0x${m[1]}`, mask, now, since, clean: mask === 0 };
}

// ------------------------------------------------------------------- memory

function getMemory() {
  // /proc/meminfo's MemAvailable is the honest number — os.freemem() ignores
  // reclaimable page cache and makes a healthy Pi look nearly full.
  const info = readFile('/proc/meminfo');
  if (!info) {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, available: free, used: total - free, usedPct: Math.round(((total - free) / total) * 100), swapTotal: 0, swapUsed: 0, swapPct: 0 };
  }
  const kv = {};
  for (const line of info.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+) kB/);
    if (m) kv[m[1]] = parseInt(m[2], 10) * 1024;
  }
  const total = kv.MemTotal || os.totalmem();
  const available = kv.MemAvailable ?? kv.MemFree ?? 0;
  const used = total - available;
  const swapTotal = kv.SwapTotal || 0;
  const swapUsed = swapTotal - (kv.SwapFree || 0);
  return {
    total, available, used,
    usedPct: total ? Math.round((used / total) * 100) : 0,
    cached: kv.Cached || 0,
    swapTotal, swapUsed,
    swapPct: swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0
  };
}

// -------------------------------------------------------------------- disks

async function getDisks() {
  if (!IS_LINUX) return [];
  const r = await run('df', ['-PB1'], 5000);
  if (!r.ok) return [];

  const disks = [];
  for (const line of r.out.split('\n').slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6) continue;
    const [device, size, used, avail, , mount] = p;
    // real block devices only — skips tmpfs, overlay, udev
    if (!device.startsWith('/dev/')) continue;
    const sizeB = parseInt(size, 10);
    if (!sizeB) continue;
    disks.push({
      device, mount,
      size: sizeB,
      used: parseInt(used, 10),
      avail: parseInt(avail, 10),
      usedPct: Math.round((parseInt(used, 10) / sizeB) * 100)
    });
  }
  return disks.sort((a, b) => b.size - a.size);
}

// -------------------------------------------------------------------- SMART

// Map /mnt/data -> /dev/sda1 -> /dev/sda. Avoids hardcoding a device that
// could shift on re-enumeration.
function diskToSmartDevice(disks) {
  const data = disks.find(d => d.mount === '/mnt/data') ||
               disks.find(d => /\/dev\/sd[a-z]/.test(d.device));
  if (!data) return null;
  return data.device.replace(/p?\d+$/, '');
}

function parseSmartAttr(out, id) {
  const re = new RegExp(`^\\s*${id}\\s+\\S+.*?\\s(\\d+)\\s*$`, 'm');
  const m = out.match(re);
  return m ? parseInt(m[1], 10) : null;
}

async function getSmart(disks) {
  if (!IS_LINUX) return null;
  const device = diskToSmartDevice(disks);
  if (!device) return null;

  return cached(`smart:${device}`, SMART_TTL_MS, async () => {
    // -d sat is required to reach a SATA disk behind a USB bridge
    const r = await run('sudo', ['-n', 'smartctl', '-i', '-H', '-A', '-l', 'error', '-l', 'selftest', '-g', 'apm', '-d', 'sat', device], 20000);
    if (!r.out || /command not found|Permission denied/i.test(r.out + r.err)) {
      return { device, available: false, reason: 'smartctl unavailable (needs smartmontools + passwordless sudo)' };
    }
    const out = r.out;

    const grab = re => { const m = out.match(re); return m ? m[1].trim() : null; };
    const loadCycles = parseSmartAttr(out, 193);
    // "# 1  Short offline  Completed without error  00%  5823  -"
    // Columns are space-padded and the row ends with the LBA field, not the hours.
    const selftest = out.match(/^#\s*1\s+(\S.*?)\s{2,}(\S.*?)\s{2,}\d+%\s+(\d+)\s+\S+\s*$/m);

    return {
      device,
      available: true,
      model: grab(/Device Model:\s+(.+)/),
      family: grab(/Model Family:\s+(.+)/),
      serial: grab(/Serial Number:\s+(.+)/),
      capacityStr: grab(/User Capacity:\s+(.+?)\s*\[/),
      rotationRate: grab(/Rotation Rate:\s+(.+)/),
      healthPassed: /overall-health self-assessment test result: PASSED/i.test(out),
      powerOnHours: parseSmartAttr(out, 9),
      powerCycles: parseSmartAttr(out, 12),
      tempC: (() => { const m = out.match(/^194\s.*?\s(\d+)\s*(?:\(|$)/m); return m ? parseInt(m[1], 10) : null; })(),
      reallocated: parseSmartAttr(out, 5),
      pending: parseSmartAttr(out, 197),
      uncorrectable: parseSmartAttr(out, 198),
      crcErrors: parseSmartAttr(out, 199),
      startStop: parseSmartAttr(out, 4),
      powerOffRetract: parseSmartAttr(out, 192),
      loadCycles,
      loadCycleRating: LOAD_CYCLE_RATING,
      loadCyclePct: loadCycles !== null ? Math.round((loadCycles / LOAD_CYCLE_RATING) * 100) : null,
      apm: (() => { const m = out.match(/APM level is:\s+(\d+)/); return m ? parseInt(m[1], 10) : null; })(),
      errorCount: /No Errors Logged/i.test(out) ? 0 : (num((out.match(/ATA Error Count:\s+(\d+)/) || [])[1]) ?? null),
      lastSelfTest: selftest
        ? { type: selftest[1].trim(), result: selftest[2].trim(), atHours: parseInt(selftest[3], 10) }
        : null
    };
  });
}

// --------------------------------------------------------------- processes

async function getPm2() {
  if (!IS_LINUX) return [];
  return cached('pm2', PM2_TTL_MS, async () => {
    // pm2 often isn't on the PATH of a spawned shell even though it launched us
    const candidates = ['pm2', '/usr/local/bin/pm2', '/usr/bin/pm2'];
    for (const bin of candidates) {
      const r = await run(bin, ['jlist'], 8000);
      if (!r.ok || !r.out.trim().startsWith('[')) continue;
      try {
        return JSON.parse(r.out).map(p => ({
          name: p.name,
          status: p.pm2_env?.status || 'unknown',
          restarts: p.pm2_env?.restart_time ?? 0,
          uptimeMs: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
          cpu: p.monit?.cpu ?? null,
          memory: p.monit?.memory ?? null,
          pid: p.pid || null
        }));
      } catch { /* try next candidate */ }
    }
    return [];
  });
}

async function getTopProcesses(limit = 6) {
  if (!IS_LINUX) return [];
  const r = await run('ps', ['-eo', 'pcpu,pmem,rss,comm,args', '--sort=-pcpu', '--no-headers'], 5000);
  if (!r.ok) return [];
  return r.out.split('\n').slice(0, limit).filter(Boolean).map(line => {
    const p = line.trim().split(/\s+/);
    return {
      cpu: num(p[0]),
      mem: num(p[1]),
      rss: parseInt(p[2], 10) * 1024,
      name: p[3],
      // trim the full command so a long node invocation doesn't blow out the row
      cmd: p.slice(4).join(' ').slice(0, 90)
    };
  });
}

const WATCHED_SERVICES = [
  'pm2-nickw', 'syncthing@nickw', 'ollama', 'docker',
  'nginx', 'tailscaled', 'ssh', 'hdd-apm'
];

async function getServices() {
  if (!IS_LINUX) return [];
  const r = await run('systemctl', ['is-active', ...WATCHED_SERVICES], 5000);
  // is-active exits non-zero if ANY unit is inactive, but still prints one line per unit
  const lines = r.out.trim().split('\n');
  return WATCHED_SERVICES.map((name, i) => ({
    name,
    state: (lines[i] || 'unknown').trim()
  })).filter(s => s.state !== 'inactive' || true);
}

// ------------------------------------------------------------------ history

// In-memory ring buffer so the panel can draw a trend without a DB table.
const HISTORY_MAX = 120;
const history = [];
let samplerStarted = false;

function pushHistory(snap) {
  history.push({
    t: Date.now(),
    loadPct: snap.cpu?.loadPct ?? null,
    tempC: snap.cpu?.tempC ?? null,
    memPct: snap.memory?.usedPct ?? null
  });
  while (history.length > HISTORY_MAX) history.shift();
}

// Started lazily on first request so importing this module has no side effects.
function startSampler() {
  if (samplerStarted || !IS_LINUX) return;
  samplerStarted = true;
  setInterval(async () => {
    try {
      pushHistory({ cpu: await getCpu(), memory: getMemory() });
    } catch { /* sampling is best-effort */ }
  }, 60000).unref();
}

// ------------------------------------------------------------------- verdict

// Turns raw numbers into the short list of things actually worth looking at.
function assess(s) {
  const issues = [];
  const add = (level, title, detail) => issues.push({ level, title, detail });

  if (s.power && !s.power.clean) {
    if (s.power.now.length) add('critical', 'Power/thermal throttling NOW', s.power.now.join(', '));
    else if (s.power.since.length) add('warn', 'Throttled since boot', `${s.power.since.join(', ')} — check the PSU`);
  }

  if (s.cpu?.tempC != null) {
    if (s.cpu.tempC >= 80) add('critical', `CPU ${s.cpu.tempC}°C`, 'Above 80°C — the Pi will start throttling');
    else if (s.cpu.tempC >= 70) add('warn', `CPU ${s.cpu.tempC}°C`, 'Running warm');
  }

  if (s.cpu?.loadPct >= 90) add('warn', `Load ${s.cpu.loadPct}%`, `${s.cpu.load1.toFixed(2)} across ${s.cpu.cores} cores`);

  if (s.memory?.usedPct >= 90) add('critical', `Memory ${s.memory.usedPct}%`, 'Under 10% available');
  else if (s.memory?.usedPct >= 80) add('warn', `Memory ${s.memory.usedPct}%`, 'Getting tight');
  if (s.memory?.swapPct >= 25) add('warn', `Swap ${s.memory.swapPct}% used`, 'Swapping hurts on an SD card / HDD');

  for (const d of s.disks || []) {
    if (d.usedPct >= 90) add('critical', `${d.mount} ${d.usedPct}% full`, `${fmtBytes(d.avail)} left`);
    else if (d.usedPct >= 80) add('warn', `${d.mount} ${d.usedPct}% full`, `${fmtBytes(d.avail)} left`);
  }

  const sm = s.smart;
  if (sm?.available) {
    if (!sm.healthPassed) add('critical', 'SMART health FAILED', `${sm.device} is reporting failure — back up now`);
    if (sm.reallocated) add('critical', `${sm.reallocated} reallocated sectors`, 'The disk is remapping bad sectors');
    if (sm.pending) add('critical', `${sm.pending} pending sectors`, 'Sectors waiting to be remapped');
    if (sm.crcErrors) add('warn', `${sm.crcErrors} USB/SATA CRC errors`, 'Suspect the cable or bridge');
    if (sm.errorCount) add('warn', `${sm.errorCount} errors in the SMART log`, `${sm.device} has logged read/write failures`);
    if (sm.loadCyclePct >= 80) add('warn', `Head parking at ${sm.loadCyclePct}% of rating`, `${sm.loadCycles?.toLocaleString()} of ${LOAD_CYCLE_RATING.toLocaleString()} cycles`);
    // APM 1-127 permits aggressive head parking — the fault we fixed on 2026-08-12
    if (sm.apm !== null && sm.apm > 0 && sm.apm < 128) {
      add('warn', `APM level ${sm.apm} — aggressive head parking`, 'Set APM 254 (hdd-apm.service should do this on boot)');
    }
  }

  for (const p of s.pm2 || []) {
    if (p.status !== 'online') add('critical', `${p.name} is ${p.status}`, 'Process is not running');
    else if (p.restarts >= 5 && p.uptimeMs != null && p.uptimeMs < 6 * 60 * 60 * 1000) {
      add('warn', `${p.name} restarted ${p.restarts}×`, `Up only ${fmtDuration(p.uptimeMs / 1000)} — check the logs`);
    }
  }

  for (const svc of s.services || []) {
    if (svc.state === 'failed') add('critical', `${svc.name} failed`, 'systemd unit is in a failed state');
  }

  const status = issues.some(i => i.level === 'critical') ? 'critical'
    : issues.some(i => i.level === 'warn') ? 'warn'
    : 'healthy';

  return { status, issues };
}

function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

function fmtDuration(sec) {
  if (sec == null) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

// -------------------------------------------------------------------- public

async function collect() {
  startSampler();

  const host = getHost();
  const memory = getMemory();
  const [cpu, power, disks, pm2, top, services] = await Promise.all([
    getCpu(), getPower(), getDisks(), getPm2(), getTopProcesses(), getServices()
  ]);
  // SMART needs the disk list to work out which device to probe
  const smart = await getSmart(disks);

  const snapshot = { host, cpu, power, memory, disks, smart, pm2, top, services };
  pushHistory(snapshot);

  const { status, issues } = assess(snapshot);

  return {
    ok: true,
    collectedAt: new Date().toISOString(),
    supported: IS_LINUX,
    status,
    issues,
    ...snapshot,
    history: history.slice(-60)
  };
}

module.exports = { collect, fmtBytes, fmtDuration };
