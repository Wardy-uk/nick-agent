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

// zram is COMPRESSED RAM, not a disk. A zram pool at 100% is the mechanism
// working as designed — it costs no writes to an SD card and no seeks on an
// HDD — so it must never be judged by the same rule as a swapfile. What it
// does cost is RAM, and that is what gets measured here.
function readZramCost(devices) {
  let orig = 0, ram = 0, known = false;
  for (const dev of devices) {
    const name = dev.replace(/^\/dev\//, '');
    if (!/^zram\d+$/.test(name)) continue;
    // mm_stat is the only source on current kernels; the individual files are
    // the older layout and are absent on the Pi 5.
    const mm = readFile(`/sys/block/${name}/mm_stat`);
    const f = mm ? mm.trim().split(/\s+/).map(Number) : [];
    if (f.length >= 3 && f.slice(0, 3).every(Number.isFinite)) {
      orig += f[0]; ram += f[2]; known = true; continue;
    }
    const o = num(readFile(`/sys/block/${name}/orig_data_size`));
    const u = num(readFile(`/sys/block/${name}/mem_used_total`));
    if (o != null && u != null) { orig += o; ram += u; known = true; }
  }
  return known ? { zramOrigBytes: orig, zramRamBytes: ram } : { zramOrigBytes: null, zramRamBytes: null };
}

// backing is 'zram' | 'disk' | 'mixed' | 'none' | null. null means we could not
// read /proc/swaps — NOT that it is harmless; the assessment keeps warning.
function getSwapBacking() {
  const raw = readFile('/proc/swaps');
  if (!raw) return { backing: null, devices: [], zramOrigBytes: null, zramRamBytes: null };
  const devices = raw.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter(Boolean);
  if (!devices.length) return { backing: 'none', devices: [], zramOrigBytes: null, zramRamBytes: null };
  const zram = devices.filter((d) => /^\/dev\/zram\d+$/.test(d));
  const backing = zram.length === devices.length ? 'zram' : zram.length ? 'mixed' : 'disk';
  return { backing, devices, ...readZramCost(zram) };
}

function getMemory() {
  // /proc/meminfo's MemAvailable is the honest number — os.freemem() ignores
  // reclaimable page cache and makes a healthy Pi look nearly full.
  const info = readFile('/proc/meminfo');
  if (!info) {
    const total = os.totalmem();
    const free = os.freemem();
    return { total, available: free, used: total - free, usedPct: Math.round(((total - free) / total) * 100), swapTotal: 0, swapUsed: 0, swapPct: 0, swapBacking: 'none', swapDevices: [], zramOrigBytes: null, zramRamBytes: null };
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
  const { backing, devices, zramOrigBytes, zramRamBytes } = getSwapBacking();
  return {
    total, available, used,
    usedPct: total ? Math.round((used / total) * 100) : 0,
    cached: kv.Cached || 0,
    swapTotal, swapUsed,
    swapPct: swapTotal ? Math.round((swapUsed / swapTotal) * 100) : 0,
    swapBacking: backing, swapDevices: devices, zramOrigBytes, zramRamBytes
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
          // PM2 counts these separately: a restart that happened INSIDE min_uptime,
          // i.e. the process fell over rather than being asked to stop. A deliberate
          // `pm2 restart` never increments it, which is the whole distinction #64
          // needs. Absent on older PM2 → 0 → silent, which is the safe direction.
          unstableRestarts: p.pm2_env?.unstable_restarts ?? 0,
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

// ------------------------------------------------------------------- router

// The ASUS RT-AC68U the Pi hangs off. NEURO does not talk to the router itself —
// router-watch.sh (cron, every 2 min) polls it and drops a status file here.
// Keeping the SSH out of the backend means a wedged router cannot stall a page
// load, and pi-health stays a read-only local collector.
const ROUTER_STATUS = '/mnt/data/logs/router-status.json';
const ROUTER_STALE_MS = 10 * 60 * 1000;

async function getRouter() {
  if (!IS_LINUX) return null;

  let status = null;
  try {
    const raw = readFile(ROUTER_STATUS);
    if (raw) status = JSON.parse(raw);
  } catch { /* treated as missing below */ }
  if (!status) return null;

  const checkedMs = Date.parse(status.checkedAt);
  const ageMs = Number.isFinite(checkedMs) ? Date.now() - checkedMs : null;

  // Every time the router reboots or drops the link, the Pi's kernel logs it.
  // That makes the Pi an independent witness to the router's stability — it is
  // how the Mon/Thu 04:00 reboot pattern was found in the first place.
  let linkDrops24h = null;
  let lastLinkDrop = null;
  const r = await run('sudo', ['-n', 'dmesg', '-T'], 8000);
  if (r.ok && r.out) {
    const downs = r.out.split('\n').filter(l => /eth0: Link is Down/.test(l));
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let recent = 0;
    for (const line of downs) {
      const m = line.match(/^\[(.+?)\]/);
      const t = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(t) && t >= cutoff) recent++;
    }
    linkDrops24h = recent;
    if (downs.length) {
      const m = downs[downs.length - 1].match(/^\[(.+?)\]/);
      lastLinkDrop = m ? new Date(m[1]).toISOString() : null;
    }
    // Total across the whole boot, for context on how chronic this is.
    status.linkDropsTotal = downs.length;
  }

  return { ...status, ageMs, stale: ageMs != null && ageMs > ROUTER_STALE_MS, linkDrops24h, lastLinkDrop };
}

// ------------------------------------------------------------------- pi 4

// Written by pi4-watch.sh (cron) rather than SSH'd on demand — same reason as
// the router: a box that has gone slow must not be able to stall a panel load,
// and this one demonstrably does go slow.
const PI4_STATUS = '/mnt/data/logs/pi4-status.json';

function getPi4() {
  if (!IS_LINUX) return null;
  let d = null;
  try {
    const raw = readFile(PI4_STATUS);
    if (raw) d = JSON.parse(raw);
  } catch { /* treated as absent */ }
  if (!d) return null;

  const checkedMs = Date.parse(d.checkedAt);
  const ageMs = Number.isFinite(checkedMs) ? Date.now() - checkedMs : null;

  // Decode with the same bit table the Pi 5 uses, so both boxes report
  // throttling in the same words.
  let power = null;
  if (d.throttledRaw) {
    const mask = parseInt(String(d.throttledRaw).replace(/^0x/, ''), 16);
    if (Number.isFinite(mask)) {
      const now = [];
      const since = [];
      for (const [bit, when, label] of THROTTLE_BITS) {
        if (mask & (1 << bit)) (when === 'now' ? now : since).push(label);
      }
      power = { raw: d.throttledRaw, mask, now, since, clean: mask === 0 };
    }
  }

  return { ...d, ageMs, stale: ageMs != null && ageMs > 15 * 60 * 1000, power };
}

// --------------------------------------------------------------- broadband

// Written by speedtest-log.sh (cron, 4x/day). Reading the file rather than
// running a test on demand: a speed test pulls real data down the line, so it
// must never be triggered by someone opening a dashboard.
const BROADBAND_LATEST = '/mnt/data/logs/broadband-latest.json';
const BROADBAND_CSV = '/mnt/data/logs/broadband.csv';

function getBroadband() {
  if (!IS_LINUX) return null;

  let latest = null;
  try {
    const raw = readFile(BROADBAND_LATEST);
    if (raw) latest = JSON.parse(raw);
  } catch { /* fall through to null */ }
  if (!latest) return null;

  // Trend matters more than any single reading — one sample on a home line is
  // noise, the useful signal is the week evening speeds halve.
  const history = [];
  const csv = readFile(BROADBAND_CSV);
  if (csv) {
    const lines = csv.trim().split('\n').slice(1);
    for (const line of lines.slice(-40)) {
      const [t, down, up, ping, , , jitter, gb] = line.split(',');
      if (!down) continue; // failed sample, kept in the file so the gap is visible
      history.push({
        t,
        down: parseFloat(down),
        up: parseFloat(up),
        ping: parseFloat(ping),
        jitter: jitter ? parseFloat(jitter) : null,
        gb: gb ? parseFloat(gb) : null,
      });
    }
  }

  // A full gigabit test moves ~1.3GB, so the running total is worth showing —
  // it is the one cost of this feature that is not obvious.
  const gbToday = history
    .filter(h => h.t && h.t.slice(0, 10) === new Date().toISOString().slice(0, 10))
    .reduce((a, h) => a + (h.gb || 0), 0);

  const downs = history.map(h => h.down).filter(Number.isFinite);
  const avg = downs.length ? Math.round(downs.reduce((a, b) => a + b, 0) / downs.length) : null;
  const checkedMs = Date.parse(latest.checkedAt);

  return {
    ...latest,
    ageMs: Number.isFinite(checkedMs) ? Date.now() - checkedMs : null,
    samples: history.length,
    gbToday: Math.round(gbToday * 10) / 10,
    avgDownMbps: avg,
    // Judged against this line's own history, not a headline figure — what
    // matters is a drop from what it normally does.
    downVsAvgPct: avg && latest.downMbps ? Math.round((latest.downMbps / avg) * 100) : null,
    history,
  };
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
  if (s.memory?.swapPct >= 25) {
    const m = s.memory;
    if (m.swapBacking === 'zram') {
      // The pool's RAM cost is already inside MemAvailable, so the two memory
      // rules above catch real pressure. This fires only when zram itself is
      // the thing eating the machine — a full pool on its own is not news.
      if (m.zramRamBytes != null && m.total && m.zramRamBytes / m.total >= 0.2) {
        add('warn', `zram using ${fmtBytes(m.zramRamBytes)} of RAM`, `${fmtBytes(m.swapUsed)} swapped out, compressed into ${fmtBytes(m.zramRamBytes)}`);
      }
    } else if (m.swapBacking === 'mixed') {
      add('warn', `Swap ${m.swapPct}% used`, `Partly on disk (${m.swapDevices.join(', ')}) — swapping hurts on an SD card / HDD`);
    } else if (m.swapBacking === null) {
      add('warn', `Swap ${m.swapPct}% used`, 'Could not read /proc/swaps — if this is a swapfile, swapping hurts on an SD card / HDD');
    } else {
      add('warn', `Swap ${m.swapPct}% used`, 'Swapping hurts on an SD card / HDD');
    }
  }

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
    // #64 — this used to warn on TOTAL restarts, so with two or three Claude
    // sessions deploying it sat on the panel all week saying "restarted 58×"
    // about its own deploys. An alert that is always on is one you stop reading,
    // which is the failure this codebase keeps having to fix (#81, #17).
    //
    // A deploy is not a fault; crash-looping is. PM2 already separates them —
    // `unstable_restarts` only counts restarts inside min_uptime, and was 0 on
    // the live Pi at 58 total. So the deliberate restarts go quiet and a genuine
    // loop still shouts.
    else if (p.unstableRestarts >= 3) {
      add('critical', `${p.name} is crash-looping`, `${p.unstableRestarts} unstable restart(s) — it is failing to stay up, check the logs`);
    }
  }

  // Router. The Pi lives behind a 13-year-old RT-AC68U that wedges; these are
  // the states worth interrupting someone for.
  const rt = s.router;
  if (rt) {
    if (rt.stale) {
      add('warn', 'Router monitor not reporting', `last check ${Math.round((rt.ageMs || 0) / 60000)}m ago \u2014 is router-watch.sh still running?`);
    } else {
      if (!rt.routerUp) add('critical', 'Router unreachable', 'the Pi cannot ping the router \u2014 it may have wedged');
      else if (!rt.netUp) add('critical', 'No internet through the router', 'router answers but traffic is not flowing');
      if (rt.tempC != null && rt.tempC >= 85) add('critical', `Router ${rt.tempC}\u00b0C`, 'this model becomes unstable above ~80\u00b0C');
      else if (rt.tempC != null && rt.tempC >= 82) add('warn', `Router ${rt.tempC}\u00b0C`, 'running hot for an RT-AC68U');
      if (rt.rebootsToday > 0) add('warn', `Router rebooted ${rt.rebootsToday}\u00d7 today`, 'router-watch had to recover it');
      if (rt.linkDrops24h >= 3) add('warn', `${rt.linkDrops24h} router link drops in 24h`, 'the link between Pi and router keeps flapping');
    }
  }

  const bb = s.broadband;
  if (bb && bb.ok) {
    // Only meaningful once there is a baseline to compare against.
    if (bb.samples >= 4 && bb.downVsAvgPct != null && bb.downVsAvgPct < 50) {
      add('warn', `Broadband at ${bb.downVsAvgPct}% of normal`, `${bb.downMbps} Mbps against a ${bb.avgDownMbps} Mbps average`);
    }
    if (bb.ageMs != null && bb.ageMs > 26 * 3600 * 1000) {
      add('warn', 'Broadband speed not sampled recently', `last test ${Math.round(bb.ageMs / 3600000)}h ago`);
    }
  } else if (bb && bb.ok === false) {
    add('warn', 'Last broadband test failed', bb.error || 'speedtest did not complete');
  }

  const p4 = s.pi4;
  if (p4 && !p4.stale && p4.reachable) {
    // Under-voltage is the one that matters: it degrades the whole box and
    // eventually corrupts storage. Everything else here is informational now
    // that the Pi 4 no longer serves NEURO.
    if (p4.power && p4.power.now.length) {
      add('critical', `Pi 4: ${p4.power.now.join(', ')} NOW`, 'check the power supply');
    } else if (p4.power && p4.power.since.includes('Under-voltage occurred')) {
      add('warn', 'Pi 4 has under-volted since boot', 'inadequate PSU — it caps CPU frequency and can corrupt the SD card');
    }
    if (p4.memUsedPct >= 90) add('warn', `Pi 4 memory ${p4.memUsedPct}%`, `${Math.round((p4.memAvailableKb || 0) / 1024)}MB available`);
    if (p4.tempC >= 80) add('warn', `Pi 4 at ${p4.tempC}\u00b0C`, 'running hot');
  } else if (p4 && (p4.stale || !p4.reachable)) {
    add('warn', 'Pi 4 not reporting', p4.stale ? `last checked ${Math.round((p4.ageMs || 0) / 60000)}m ago` : 'unreachable over SSH');
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

async function collect({ skipHistory = false } = {}) {
  startSampler();

  const host = getHost();
  const memory = getMemory();
  const [cpu, power, disks, pm2, top, services, router] = await Promise.all([
    getCpu(), getPower(), getDisks(), getPm2(), getTopProcesses(), getServices(), getRouter()
  ]);
  // SMART needs the disk list to work out which device to probe
  const smart = await getSmart(disks);

  const broadband = getBroadband();
  const pi4 = getPi4();
  const snapshot = { host, cpu, power, memory, disks, smart, pm2, top, services, router, broadband, pi4 };
  pushHistory(snapshot);

  const { status, issues } = assess(snapshot);

  // History now comes from SQL, not the in-memory ring buffer — the buffer
  // emptied on every restart, so the Trend card kept resetting to a handful of
  // samples. skipHistory avoids recursion when metrics-store calls collect()
  // purely to take a sample.
  let persisted = [];
  if (!skipHistory) {
    try { persisted = require('./metrics-store').getHistory('pi5', 24); }
    catch { /* fall back to the in-memory buffer below */ }
  }

  return {
    ok: true,
    collectedAt: new Date().toISOString(),
    supported: IS_LINUX,
    status,
    issues,
    ...snapshot,
    // Prefer the durable series; fall back to the in-memory buffer if the
    // table is empty (first run after deploy, before the importer has fired).
    history: persisted.length
      ? persisted.slice(-120).map(h => ({ t: Date.parse(h.t), loadPct: h.load_pct ?? null, tempC: h.temp_c ?? null, memPct: h.mem_used_pct ?? null }))
      : history.slice(-60)
  };
}

// assess is exported so the ranking can be pinned without a Pi under it.
module.exports = { collect, assess, fmtBytes, fmtDuration };
