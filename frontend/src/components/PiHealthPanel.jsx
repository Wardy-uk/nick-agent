import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiUrl } from '../api';
import './PiHealthPanel.css';

const REFRESH_MS = 10000;

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

// Green until it matters, then amber, then red. Keeps the panel calm when all is well.
function bandFor(pct, warn = 70, crit = 88) {
  if (pct == null) return 'unknown';
  if (pct >= crit) return 'critical';
  if (pct >= warn) return 'warn';
  return 'ok';
}

// A ring gauge — the arc length encodes the value, so it reads at a glance.
function Gauge({ label, value, suffix = '%', pct, band, sub }) {
  const R = 34;
  const C = 2 * Math.PI * R;
  const filled = Math.max(0, Math.min(100, pct ?? 0)) / 100 * C;

  return (
    <div className={`ph-gauge ph-band-${band}`}>
      <svg viewBox="0 0 80 80" className="ph-gauge-svg">
        <circle cx="40" cy="40" r={R} className="ph-gauge-track" />
        <circle
          cx="40" cy="40" r={R}
          className="ph-gauge-fill"
          strokeDasharray={`${filled} ${C - filled}`}
          transform="rotate(-90 40 40)"
        />
      </svg>
      <div className="ph-gauge-center">
        <span className="ph-gauge-value">{value ?? '—'}<i>{suffix}</i></span>
      </div>
      <div className="ph-gauge-meta">
        <span className="ph-gauge-label">{label}</span>
        {sub && <span className="ph-gauge-sub">{sub}</span>}
      </div>
    </div>
  );
}

// Trend line over the retained samples. Purely shape — no axes, it's a glance aid.
function Spark({ points, band = 'ok', max }) {
  const vals = (points || []).filter(v => v != null);
  if (vals.length < 2) return <div className="ph-spark ph-spark-empty" />;

  const hi = max ?? Math.max(...vals, 1);
  const lo = Math.min(...vals, 0);
  const span = hi - lo || 1;
  const W = 100, H = 28;
  const d = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - lo) / span) * H;
    return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className={`ph-spark ph-band-${band}`}>
      <path d={`${d} L${W},${H} L0,${H} Z`} className="ph-spark-area" />
      <path d={d} className="ph-spark-line" />
    </svg>
  );
}

function Bar({ pct, band }) {
  return (
    <div className={`ph-bar ph-band-${band}`}>
      <div className="ph-bar-fill" style={{ width: `${Math.max(2, Math.min(100, pct || 0))}%` }} />
    </div>
  );
}

export default function PiHealthPanel() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);
  const timer = useRef(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/pi-health'));
      const json = await res.json();
      if (json.ok === false) throw new Error(json.error || 'Collector failed');
      setData(json);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!live) return;
    timer.current = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer.current);
  }, [live, load]);

  if (loading) return <div className="ph-panel"><div className="ph-loading">Reading system state…</div></div>;

  if (error && !data) {
    return (
      <div className="ph-panel">
        <div className="ph-error">
          <strong>Can't reach the collector.</strong>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  const { host, cpu, memory, disks = [], smart, power, pm2 = [], top = [], services = [], issues = [], history = [] } = data;

  const memBand = bandFor(memory?.usedPct, 80, 90);
  const cpuBand = bandFor(cpu?.loadPct, 75, 90);
  const tempBand = bandFor(cpu?.tempC, 70, 80);
  const rootDisk = disks.find(d => d.mount === '/') || disks[0];
  const diskBand = bandFor(rootDisk?.usedPct, 80, 90);

  const statusCopy = {
    healthy: 'All systems nominal',
    warn: 'Needs a look',
    critical: 'Action required'
  }[data.status] || 'Unknown';

  return (
    <div className="ph-panel">

      {/* ---- FOCUS BAND: the verdict, then only what needs attention ---- */}
      <section className={`ph-focus ph-status-${data.status}`}>
        <div className="ph-focus-main">
          <div className="ph-focus-verdict">
            <span className="ph-pulse" />
            <div>
              <h1 className="ph-focus-title">{statusCopy}</h1>
              <p className="ph-focus-sub">
                {host?.model || host?.hostname} · up {fmtDuration(host?.uptimeSec)}
                {power?.clean && <span className="ph-chip ph-chip-ok">no throttling</span>}
                {power && !power.clean && <span className="ph-chip ph-chip-warn">{power.raw}</span>}
              </p>
            </div>
          </div>

          <div className="ph-focus-actions">
            <button
              className={`ph-live ${live ? 'on' : ''}`}
              onClick={() => setLive(v => !v)}
              title={live ? 'Pause auto-refresh' : 'Resume auto-refresh'}
            >
              {live ? '● LIVE' : '❙❙ PAUSED'}
            </button>
            <button className="ph-refresh" onClick={load}>Refresh</button>
          </div>
        </div>

        <div className="ph-gauges">
          <Gauge label="CPU load" value={cpu?.loadPct} pct={cpu?.loadPct} band={cpuBand}
                 sub={`${cpu?.load1?.toFixed(2)} / ${cpu?.cores} cores`} />
          <Gauge label="Temp" value={cpu?.tempC} suffix="°" pct={cpu?.tempC} band={tempBand}
                 sub={cpu?.freqMHz ? `${cpu.freqMHz} MHz` : 'SoC'} />
          <Gauge label="Memory" value={memory?.usedPct} pct={memory?.usedPct} band={memBand}
                 sub={`${fmtBytes(memory?.available)} free`} />
          <Gauge label={rootDisk?.mount === '/' ? 'SD card' : rootDisk?.mount} value={rootDisk?.usedPct}
                 pct={rootDisk?.usedPct} band={diskBand} sub={`${fmtBytes(rootDisk?.avail)} free`} />
        </div>

        {issues.length > 0 ? (
          <ul className="ph-issues">
            {issues.map((it, i) => (
              <li key={i} className={`ph-issue ph-issue-${it.level}`}>
                <span className="ph-issue-dot" />
                <span className="ph-issue-title">{it.title}</span>
                <span className="ph-issue-detail">{it.detail}</span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="ph-allclear">
            Nothing needs your attention. Checked load, temperature, throttling, memory, swap,
            every mounted disk, SMART, PM2 processes and systemd units.
          </div>
        )}
      </section>

      {/* ---- TREND ---- */}
      {history.length > 2 && (
        <section className="ph-card ph-trends">
          <h2 className="ph-card-title">Trend <span className="ph-card-hint">last {history.length} samples</span></h2>
          <div className="ph-trend-grid">
            <div className="ph-trend">
              <div className="ph-trend-head"><span>CPU load</span><b>{cpu?.loadPct}%</b></div>
              <Spark points={history.map(h => h.loadPct)} band={cpuBand} max={100} />
            </div>
            <div className="ph-trend">
              <div className="ph-trend-head"><span>Temperature</span><b>{cpu?.tempC}°C</b></div>
              <Spark points={history.map(h => h.tempC)} band={tempBand} max={90} />
            </div>
            <div className="ph-trend">
              <div className="ph-trend-head"><span>Memory</span><b>{memory?.usedPct}%</b></div>
              <Spark points={history.map(h => h.memPct)} band={memBand} max={100} />
            </div>
          </div>
        </section>
      )}

      <div className="ph-columns">

        {/* ---- STORAGE + SMART ---- */}
        <section className="ph-card">
          <h2 className="ph-card-title">Storage</h2>
          {disks.map(d => (
            <div key={d.mount} className="ph-disk">
              <div className="ph-disk-head">
                <span className="ph-disk-mount">{d.mount}</span>
                <span className="ph-disk-nums">{fmtBytes(d.used)} / {fmtBytes(d.size)} · {d.usedPct}%</span>
              </div>
              <Bar pct={d.usedPct} band={bandFor(d.usedPct, 80, 90)} />
              <div className="ph-disk-sub">{d.device} · {fmtBytes(d.avail)} free</div>
            </div>
          ))}

          {smart?.available && (
            <div className="ph-smart">
              <div className="ph-smart-head">
                <span className={`ph-smart-badge ${smart.healthPassed ? 'ok' : 'bad'}`}>
                  SMART {smart.healthPassed ? 'PASSED' : 'FAILED'}
                </span>
                <span className="ph-smart-model">{smart.model}</span>
              </div>

              <div className="ph-smart-grid">
                <div><span>Powered on</span><b>{smart.powerOnHours?.toLocaleString()} h</b></div>
                <div><span>Disk temp</span><b>{smart.tempC ?? '—'}°C</b></div>
                <div><span>Reallocated</span><b className={smart.reallocated ? 'bad' : 'good'}>{smart.reallocated ?? '—'}</b></div>
                <div><span>Pending</span><b className={smart.pending ? 'bad' : 'good'}>{smart.pending ?? '—'}</b></div>
                <div><span>CRC errors</span><b className={smart.crcErrors ? 'bad' : 'good'}>{smart.crcErrors ?? '—'}</b></div>
                <div><span>APM</span><b className={smart.apm > 0 && smart.apm < 128 ? 'bad' : 'good'}>{smart.apm ?? '—'}</b></div>
              </div>

              {smart.loadCyclePct != null && (
                <div className="ph-wear">
                  <div className="ph-wear-head">
                    <span>Head parking wear</span>
                    <b>{smart.loadCycles.toLocaleString()} / {smart.loadCycleRating.toLocaleString()} ({smart.loadCyclePct}%)</b>
                  </div>
                  <Bar pct={smart.loadCyclePct} band={bandFor(smart.loadCyclePct, 70, 90)} />
                </div>
              )}

              {smart.lastSelfTest && (
                <div className="ph-smart-foot">
                  Last self-test: <b>{smart.lastSelfTest.result}</b> @ {smart.lastSelfTest.atHours.toLocaleString()}h
                </div>
              )}
            </div>
          )}

          {smart && !smart.available && (
            <div className="ph-smart-missing">SMART unavailable — {smart.reason}</div>
          )}
        </section>

        {/* ---- PROCESSES ---- */}
        <section className="ph-card">
          <h2 className="ph-card-title">Processes</h2>

          {pm2.length > 0 && (
            <div className="ph-pm2">
              {pm2.map(p => (
                <div key={p.name} className={`ph-proc ${p.status !== 'online' ? 'bad' : ''}`}>
                  <span className={`ph-proc-dot ${p.status === 'online' ? 'ok' : 'bad'}`} />
                  <span className="ph-proc-name">{p.name}</span>
                  <span className="ph-proc-stat">{fmtDuration(p.uptimeMs / 1000)}</span>
                  <span className={`ph-proc-stat ${p.restarts >= 5 ? 'warn' : ''}`}>↺ {p.restarts}</span>
                  <span className="ph-proc-stat">{fmtBytes(p.memory)}</span>
                </div>
              ))}
            </div>
          )}

          <div className="ph-sub-title">Top by CPU</div>
          <div className="ph-top">
            {top.map((p, i) => (
              <div key={i} className="ph-topline">
                <span className="ph-top-cpu">{p.cpu?.toFixed(1)}%</span>
                <span className="ph-top-name" title={p.cmd}>{p.name}</span>
                <span className="ph-top-rss">{fmtBytes(p.rss)}</span>
              </div>
            ))}
          </div>

          {services.length > 0 && (
            <>
              <div className="ph-sub-title">Services</div>
              <div className="ph-services">
                {services.map(s => (
                  <span key={s.name} className={`ph-svc ph-svc-${s.state}`}>{s.name}</span>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      <div className="ph-foot">
        {host?.kernel} · node {host?.nodeVersion} · collected {new Date(data.collectedAt).toLocaleTimeString()}
        {error && <span className="ph-foot-err"> · last refresh failed: {error}</span>}
      </div>
    </div>
  );
}
