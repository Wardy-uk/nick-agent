import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiUrl } from '../api';
import { assessWorker } from '../../../shared/worker-health.cjs';
import './PiHealthPanel.css';

const REFRESH_MS = 10000;

function fmtBytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)}${u[i]}`;
}

// USD, and it says so on the card. NOVA formats the same kind of figure with a
// "£" over unconverted dollars, which is how a cost display quietly becomes
// ~27% wrong; a pound number needs an FX source with a date on it.
function fmtUsd(n) {
  // Null is "we could not price this", not zero. Never render it as $0.00.
  if (n == null) return '—';
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n) {
  if (n == null) return '—';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tok`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tok`;
  return `${n} tok`;
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

// Throttle state, rendered the same way for both Pis. Two separate facts that
// people conflate: what is happening NOW, and what has happened since boot.
// The second is the one that catches an inadequate PSU, because the symptom
// (frequency capping) disappears the moment you look.
function PowerChips({ power, label = 'power' }) {
  if (!power) return <span className="ph-chip">{label}: unknown</span>;
  if (power.clean) return <span className="ph-chip ph-chip-ok">no throttling</span>;
  return (
    <>
      {power.now.map(f => (
        <span key={f} className="ph-chip ph-chip-bad">NOW: {f}</span>
      ))}
      {power.since.map(f => (
        <span key={f} className="ph-chip ph-chip-warn">{f}</span>
      ))}
    </>
  );
}

function Bar({ pct, band }) {
  return (
    <div className={`ph-bar ph-band-${band}`}>
      <div className="ph-bar-fill" style={{ width: `${Math.max(2, Math.min(100, pct || 0))}%` }} />
    </div>
  );
}

// Rolls the AI stack up into the same {level, issues} shape the host checks use,
// so the focus band can rank an unreachable worker next to a hot CPU.
function assessAi(ai, ollamaReachable) {
  if (!ai) return null;
  const health = ai.health || {};
  const byProvider = health.byProvider || {};
  const issues = [];

  if (ollamaReachable === false) issues.push({ level: 'critical', title: 'Ollama unreachable', detail: ai.ollama?.url || 'local model server is down' });
  else if ((ai.ollama?.queueDepth || 0) > 2) issues.push({ level: 'warn', title: `Ollama queue ${ai.ollama.queueDepth}`, detail: 'requests are backing up' });

  // A worker that has been dead for weeks reading as healthy is the blind spot
  // this panel exists to close — but so is a worker that is up and merely too
  // slow reading as "never checked". assessWorker owns that distinction.
  const worker = assessWorker(ai.pi4Worker);
  if (worker.level !== 'ok') {
    issues.push({ level: worker.level, title: worker.title, detail: worker.detail });
  }

  if (ai.openrouter?.throttled) {
    issues.push({ level: 'warn', title: 'OpenRouter throttled', detail: `${ai.openrouter.callsToday}/${ai.openrouter.dailyCallLimit} calls, ${ai.openrouter.tokensToday}/${ai.openrouter.dailyTokenLimit} tokens today` });
  }

  for (const [provider, err] of Object.entries(health.errors || {})) {
    if (err.errorClass === 'auth') issues.push({ level: 'critical', title: `${provider}: authentication failed`, detail: err.message });
    else if (err.errorClass === 'rate_limit') issues.push({ level: 'warn', title: `${provider}: rate limited`, detail: err.message });
    else if (err.errorClass === 'unreachable') issues.push({ level: 'warn', title: `${provider}: unreachable`, detail: err.message });
  }

  // Configured, enabled, and yet serving nothing — the silent-degradation case.
  if (ai.anthropic?.configured && ai.anthropic?.enabled && health.calls > 5 && !byProvider.anthropic) {
    issues.push({ level: 'warn', title: 'Anthropic serving 0 of the last calls', detail: 'configured and enabled but never selected — answers are coming from elsewhere' });
  }
  if (health.calls > 5 && health.fallbackRate >= 30) {
    issues.push({ level: 'warn', title: `${health.fallbackRate}% of calls fell back`, detail: ai.openrouter?.lastFallbackReason || 'intended provider is not serving' });
  }
  if (health.calls > 5 && health.failureRate >= 20) {
    issues.push({ level: 'critical', title: `${health.failureRate}% of AI calls failed`, detail: `${health.failures} of ${health.calls} in the window` });
  }

  const level = issues.some(i => i.level === 'critical') ? 'critical' : issues.length ? 'warn' : 'ok';
  return { level, issues, health, byProvider };
}

/**
 * Every sense SARA has, and whether it is actually working.
 *
 * This panel used to be the Pi's vitals alone. It is NEURO Health now because
 * the machine being healthy has never been the interesting question — three
 * separate blindnesses were found on 31 Aug 2026 and every one of them was
 * INVISIBLE: the phone feed had returned null for five weeks, `health-signals`
 * was computing trends nothing read, and dietary logging had stopped in March.
 *
 * A dead sensor and a quiet one look identical from every other screen. That is
 * what this section exists to make impossible.
 *
 * ⚠ FIVE states, not two, and `off` must never look like `stale`. Not having a
 * desktop agent installed is a decision; having one that stopped talking is a
 * problem. Rendering them alike is how a real fault hides behind a deliberate
 * gap — which is precisely how the phone stayed broken for five weeks.
 */
const SIGNAL_STATE = {
  live:  { band: 'ok',      label: 'live' },
  stale: { band: 'bad',     label: 'stopped' },
  never: { band: 'warn',    label: 'never reported' },
  error: { band: 'bad',     label: 'check failed' },
  off:   { band: 'neutral', label: 'not set up' },
};

function fmtAge(minutes) {
  if (minutes == null) return null;
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function SignalsSection() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(apiUrl('/api/signals'));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (alive) { setData(json); setError(null); }
      } catch (e) {
        if (alive) setError(e.message);
      }
    };
    load();
    const t = setInterval(load, 60000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (error) {
    return (
      <section className="ph-card ph-signals">
        <h2 className="ph-card-title">Her senses</h2>
        {/* An unreadable check is NOT a clean bill of health, and must not read
            like one — the whole point of the section. */}
        <p className="ph-signals-err">Couldn&rsquo;t read this — {error}. That is not the same as everything being fine.</p>
      </section>
    );
  }
  if (!data) return null;

  const faults = (data.signals || []).filter(s => ['stale', 'error'].includes(s.state)).length;
  const live = (data.signals || []).filter(s => s.state === 'live').length;

  return (
    <section className="ph-card ph-signals">
      <div className="ph-signals-head">
        <h2 className="ph-card-title">Her senses</h2>
        <span className={`ph-signals-sum ph-band-${faults ? 'bad' : 'ok'}`}>
          {faults ? `${faults} not reporting` : `${live} live`}
        </span>
      </div>

      <ul className="ph-signals-list">
        {(data.signals || []).map(sig => {
          const meta = SIGNAL_STATE[sig.state] || SIGNAL_STATE.error;
          return (
            <li key={sig.id} className={`ph-signal ph-sig-${meta.band}`}>
              <span className="ph-signal-dot" aria-hidden="true" />
              <div className="ph-signal-body">
                <div className="ph-signal-top">
                  <span className="ph-signal-name">{sig.label}</span>
                  <span className="ph-signal-state">{meta.label}</span>
                  {sig.ageMinutes != null && (
                    <span className="ph-signal-age">{fmtAge(sig.ageMinutes)}</span>
                  )}
                </div>
                {/* What she LOSES when this is dark, in plain words. A status
                    row naming only the source teaches nothing about why it
                    matters. */}
                <p className="ph-signal-what">{sig.what}</p>
                {(sig.why || sig.detail) && (
                  <p className="ph-signal-why">{sig.why || sig.detail}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export default function PiHealthPanel() {
  const [data, setData] = useState(null);
  const [ai, setAi] = useState(null);
  const [ollamaReachable, setOllamaReachable] = useState(null);
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

    // AI health rides on /api/status, which already returns aiRouting.getStatus().
    // Kept as a separate, non-fatal fetch: the host panel must still render if
    // the AI stack is the thing that is broken.
    try {
      const s = await (await fetch(apiUrl('/api/status'))).json();
      setAi(s.ai || null);
      setOllamaReachable(s.ollamaReachable ?? null);
    } catch { /* leave the AI section out rather than failing the panel */ }

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

  const { host, cpu, memory, disks = [], smart, power, pm2 = [], top = [], services = [], issues: hostIssues = [], history = [], router, broadband, pi4 } = data;

  // AI problems belong in the same ranked list as host problems — a dead worker
  // matters more than a warm CPU, and splitting them buries one of the two.
  const aiState = assessAi(ai, ollamaReachable);
  const workerVerdict = assessWorker(ai?.pi4Worker);
  const issues = [...hostIssues, ...(aiState?.issues || [])]
    .sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
  const overallStatus = aiState?.level === 'critical' ? 'critical'
    : (data.status === 'healthy' && aiState?.level === 'warn') ? 'warn'
    : data.status;

  const memBand = bandFor(memory?.usedPct, 80, 90);
  const cpuBand = bandFor(cpu?.loadPct, 75, 90);
  const tempBand = bandFor(cpu?.tempC, 70, 80);
  const rootDisk = disks.find(d => d.mount === '/') || disks[0];
  const diskBand = bandFor(rootDisk?.usedPct, 80, 90);

  const statusCopy = {
    healthy: 'All systems nominal',
    warn: 'Needs a look',
    critical: 'Action required'
  }[overallStatus] || 'Unknown';

  return (
    <div className="ph-panel">

      {/* Her senses FIRST. The Pi being warm has never been the interesting
          question — whether she can still see anything is. */}
      <SignalsSection />

      {/* ---- FOCUS BAND: the verdict, then only what needs attention ---- */}
      <section className={`ph-focus ph-status-${overallStatus}`}>
        <div className="ph-focus-main">
          <div className="ph-focus-verdict">
            <span className="ph-pulse" />
            <div>
              <h1 className="ph-focus-title">{statusCopy}</h1>
              <p className="ph-focus-sub">
                {host?.model || host?.hostname} · up {fmtDuration(host?.uptimeSec)}
                <PowerChips power={power} />
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

      {/* ---- PI 4 (pi-dev): same gauges as the Pi 5, so the two compare ---- */}
      {pi4 && (
        <section className="ph-card">
          <h2 className="ph-card-title">
            Pi 4
            <span className="ph-card-hint">
              {pi4.reachable
                ? `${pi4.model || 'pi-dev'} · up ${fmtDuration(pi4.uptimeSec)} · ${pi4.stale ? 'STALE' : `checked ${Math.round((pi4.ageMs || 0) / 1000)}s ago`}`
                : 'unreachable'}
            </span>
          </h2>

          {pi4.reachable ? (
            <>
              <p className="ph-focus-sub" style={{ marginTop: 0, marginBottom: 12 }}>
                <PowerChips power={pi4.power} />
              </p>

              {/* Same four gauges as the Pi 5, in the same order, so a glance
                  compares like with like. */}
              <div className="ph-gauges">
                <Gauge
                  label="CPU load" value={pi4.loadPct} pct={pi4.loadPct}
                  band={bandFor(pi4.loadPct, 75, 90)}
                  sub={`${pi4.load1} / ${pi4.cores} cores`}
                />
                <Gauge
                  label="Temp" value={pi4.tempC} suffix="°" pct={pi4.tempC}
                  band={bandFor(pi4.tempC, 70, 80)}
                  sub={pi4.freqMHz ? `${pi4.freqMHz} MHz` : 'SoC'}
                />
                <Gauge
                  label="Memory" value={pi4.memUsedPct} pct={pi4.memUsedPct}
                  band={bandFor(pi4.memUsedPct, 80, 90)}
                  sub={`${fmtBytes((pi4.memAvailableKb || 0) * 1024)} free`}
                />
                <Gauge
                  label="SD card" value={pi4.diskUsedPct} pct={pi4.diskUsedPct}
                  band={bandFor(pi4.diskUsedPct, 80, 90)}
                  sub={`${fmtBytes(pi4.diskAvailBytes)} free`}
                />
              </div>

              <div className="ph-router-foot">
                {/* Swapping on an SD card is both slow and destructive */}
                {pi4.swapUsedKb > 0 && (
                  <span className="ph-router-flag">
                    swapping {Math.round(pi4.swapUsedKb / 1024)}MB of {Math.round((pi4.swapTotalKb || 0) / 1024)}MB
                  </span>
                )}
                {pi4.topCpu && (
                  <span>top: {pi4.topCpu.trim().split(/\s+/).map(x => x.replace(':', ' ')).join(' · ')}</span>
                )}
              </div>
            </>
          ) : (
            <div className="ph-smart-missing">pi-dev is not reachable over SSH from the Pi 5.</div>
          )}
        </section>
      )}

      {/* ---- ROUTER: the box everything else depends on ---- */}
      {router && (
        <section className="ph-card">
          <h2 className="ph-card-title">
            Router <span className="ph-card-hint">
              ASUS RT-AC68U{router.stale ? ' · monitor stale' : router.ageMs != null ? ` · checked ${Math.round(router.ageMs / 1000)}s ago` : ''}
            </span>
          </h2>

          <div className="ph-router-grid">
            <div>
              <span>Reachable</span>
              <b className={router.routerUp ? 'good' : 'bad'}>{router.routerUp ? 'yes' : 'NO'}</b>
            </div>
            <div>
              <span>Internet</span>
              <b className={router.netUp ? 'good' : 'bad'}>{router.netUp ? 'flowing' : 'DOWN'}</b>
            </div>
            <div>
              <span>Temperature</span>
              {/* This box gets unstable near 80°C, so the threshold is lower than the Pi's */}
              <b className={router.tempC >= 82 ? 'bad' : router.tempC >= 78 ? 'warn' : 'good'}>
                {router.tempC != null ? `${router.tempC}°C` : '—'}
              </b>
            </div>
            <div>
              <span>Free memory</span>
              <b>{router.memFreeKb != null ? fmtBytes(router.memFreeKb * 1024) : '—'}</b>
            </div>
            <div>
              {/* The number that matters now the scheduled reboot is off: how long
                  it survives on its own. Every previous outage reset this. */}
              <span>Uptime</span>
              <b>{router.uptimeSec != null ? fmtDuration(router.uptimeSec) : '—'}</b>
            </div>
            <div>
              <span>Link drops 24h</span>
              <b className={router.linkDrops24h >= 3 ? 'bad' : router.linkDrops24h > 0 ? 'warn' : 'good'}>
                {router.linkDrops24h ?? '—'}
              </b>
            </div>
          </div>

          {/* Broadband belongs here: it is the same question as "is the router
              working", just measured end to end rather than at the LAN port.
              Sampled 4x/day by cron — never triggered by opening this page. */}
          {broadband && (
            <>
              <div className="ph-sub-title">Broadband</div>
              {broadband.ok ? (
                <>
                  <div className="ph-router-grid">
                    <div>
                      <span>Download</span>
                      {/* Judged against this line's own average, not a headline figure */}
                      <b className={broadband.downVsAvgPct != null && broadband.downVsAvgPct < 50 ? 'bad'
                        : broadband.downVsAvgPct != null && broadband.downVsAvgPct < 75 ? 'warn' : 'good'}>
                        {broadband.downMbps} Mbps
                      </b>
                    </div>
                    <div><span>Upload</span><b>{broadband.upMbps} Mbps</b></div>
                    <div>
                      <span>Ping</span>
                      <b className={broadband.pingMs > 100 ? 'warn' : 'good'}>{broadband.pingMs} ms</b>
                    </div>
                    <div>
                      <span>Average down</span>
                      <b>{broadband.avgDownMbps != null ? `${broadband.avgDownMbps} Mbps` : '—'}</b>
                    </div>
                    <div>
                      <span>vs average</span>
                      <b className={broadband.downVsAvgPct != null && broadband.downVsAvgPct < 50 ? 'bad' : 'good'}>
                        {broadband.downVsAvgPct != null ? `${broadband.downVsAvgPct}%` : '—'}
                      </b>
                    </div>
                    <div>
                      {/* Jitter breaks calls where raw speed does not — a 900Mbps
                          line with 30ms jitter still stutters on Teams. */}
                      <span>Jitter</span>
                      <b className={broadband.jitterMs > 20 ? 'bad' : broadband.jitterMs > 10 ? 'warn' : 'good'}>
                        {broadband.jitterMs != null ? `${broadband.jitterMs} ms` : '—'}
                      </b>
                    </div>
                    <div>
                      {/* Measuring a gigabit line costs ~1.3GB a test — not obvious,
                          so show the running total rather than hide it. */}
                      <span>Data used today</span>
                      <b>{broadband.gbToday != null ? `${broadband.gbToday} GB` : '—'}</b>
                    </div>
                    <div><span>Samples</span><b>{broadband.samples}</b></div>
                  </div>

                  {broadband.history?.length > 1 && (
                    <div className="ph-trend-grid" style={{ marginTop: 14 }}>
                      <div className="ph-trend">
                        <div className="ph-trend-head"><span>Download</span><b>{broadband.downMbps} Mbps</b></div>
                        <Spark points={broadband.history.map(h => h.down)} band="ok" />
                      </div>
                      <div className="ph-trend">
                        <div className="ph-trend-head"><span>Upload</span><b>{broadband.upMbps} Mbps</b></div>
                        <Spark points={broadband.history.map(h => h.up)} band="ok" />
                      </div>
                      <div className="ph-trend">
                        <div className="ph-trend-head"><span>Ping</span><b>{broadband.pingMs} ms</b></div>
                        <Spark points={broadband.history.map(h => h.ping)} band="warn" />
                      </div>
                      {broadband.history.some(h => h.jitter != null) && (
                        <div className="ph-trend">
                          <div className="ph-trend-head"><span>Jitter</span><b>{broadband.jitterMs} ms</b></div>
                          <Spark points={broadband.history.map(h => h.jitter)} band="warn" />
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="ph-smart-missing">
                  Last speed test failed — {broadband.error || 'no result'}
                </div>
              )}
            </>
          )}

          <div className="ph-router-foot">
            {broadband?.ok && broadband.ageMs != null && (
              <span>speed tested {Math.round(broadband.ageMs / 3600000)}h ago via {(broadband.sponsor || '').replace(/_/g, ' ')}</span>
            )}
            {router.rebootsToday > 0 && (
              <span className="ph-router-flag">recovered {router.rebootsToday}× today by router-watch</span>
            )}
            {router.consecutiveFailures > 0 && (
              <span className="ph-router-flag">{router.consecutiveFailures} consecutive failed checks</span>
            )}
            {router.lastLinkDrop && (
              <span>last link drop {new Date(router.lastLinkDrop).toLocaleString()}</span>
            )}
            {router.linkDropsTotal != null && (
              <span>· {router.linkDropsTotal} since the Pi booted</span>
            )}
          </div>
        </section>
      )}

      {/* ---- AI STACK: what is actually serving, not what is configured ---- */}
      {aiState && (
        <section className="ph-card">
          <h2 className="ph-card-title">
            AI stack
            <span className="ph-card-hint">
              {aiState.health.calls
                ? `last ${aiState.health.calls} calls · ${aiState.health.fallbackRate}% fell back`
                : 'no calls recorded yet'}
            </span>
          </h2>

          {/* Provider mix — the honest answer to "who is answering my questions" */}
          {aiState.health.calls > 0 && (
            <div className="ph-mix">
              {Object.entries(aiState.byProvider)
                .sort((a, b) => b[1].calls - a[1].calls)
                .map(([name, p]) => (
                  <div key={name} className="ph-mix-row">
                    <span className={`ph-mix-name ${name === 'none' ? 'bad' : ''}`}>{name}</span>
                    <div className="ph-mix-bar">
                      <div
                        className={`ph-mix-fill ${name === 'none' ? 'bad' : ''}`}
                        style={{ width: `${Math.max(2, p.share)}%` }}
                      />
                    </div>
                    <span className="ph-mix-share">{p.share}%</span>
                    <span className="ph-mix-lat">
                      {p.p50 != null ? `p50 ${p.p50 < 1000 ? `${p.p50}ms` : `${(p.p50 / 1000).toFixed(1)}s`}` : '—'}
                      {p.p95 != null && p.p95 !== p.p50 ? ` · p95 ${p.p95 < 1000 ? `${p.p95}ms` : `${(p.p95 / 1000).toFixed(1)}s`}` : ''}
                    </span>
                    {p.failed > 0 && <span className="ph-mix-fail">{p.failed} failed</span>}
                  </div>
                ))}
            </div>
          )}

          <div className="ph-sub-title">Providers</div>
          <div className="ph-providers">
            {[
              { key: 'ollama', label: 'Ollama (local)', up: ollamaReachable !== false, detail: `${ai.ollama?.model || '—'}${ai.ollama?.queueDepth ? ` · queue ${ai.ollama.queueDepth}` : ''}${ai.ollama?.inUse ? ' · busy' : ''}` },
              // Same verdict as the focus band above and the Topbar dot — they
              // disagreed while each derived it from lastHealthy on its own.
              { key: 'pi4Worker', label: 'Pi 4 worker', up: workerVerdict.up, detail: workerVerdict.detail },
              { key: 'anthropic', label: 'Anthropic', up: ai.anthropic?.configured ? (ai.anthropic?.enabled ? true : null) : null, detail: ai.anthropic?.configured ? `${ai.anthropic.model}${ai.anthropic.enabled ? '' : ' · disabled'}` : 'not configured' },
              { key: 'openai', label: 'OpenAI', up: ai.openai?.configured ? true : null, detail: ai.openai?.configured ? ai.openai.model : 'not configured' },
              { key: 'openrouter', label: 'OpenRouter', up: ai.openrouter?.configured && ai.openrouter?.enabled ? !ai.openrouter.throttled : null, detail: ai.openrouter?.configured ? `${ai.openrouter.callsToday}/${ai.openrouter.dailyCallLimit} calls · ${ai.openrouter.tokensToday}/${ai.openrouter.dailyTokenLimit} tokens${ai.openrouter.throttled ? ' · THROTTLED' : ''}` : 'not configured' },
            ].map(p => {
              const err = aiState.health.errors?.[p.key];
              return (
                <div key={p.key} className="ph-provider">
                  <span className={`ph-proc-dot ${p.up === null ? '' : p.up ? 'ok' : 'bad'}`} />
                  <span className="ph-provider-name">{p.label}</span>
                  <span className="ph-provider-detail">{p.detail}</span>
                  {err && <span className={`ph-provider-err ${err.errorClass}`}>{err.errorClass}</span>}
                </div>
              );
            })}
          </div>

          {/* ---- SPEND: the counters above are a cap check, not a bill ---- */}
          {ai.cost && (
            <>
              <div className="ph-sub-title">
                Spend
                <span className="ph-cost-basis">
                  {ai.cost.currency} · prices checked {ai.cost.pricesCheckedOn}
                </span>
              </div>
              {ai.cost.error ? (
                // A ledger that could not be read is not a free day.
                <div className="ph-cost-unknown">Cost ledger unreadable — {ai.cost.error}</div>
              ) : (
                <>
                  <div className="ph-cost-row">
                    {[
                      { label: 'Today', v: ai.cost.today },
                      { label: '7 days', v: ai.cost.last7 },
                      { label: '30 days', v: ai.cost.last30 },
                    ].map(({ label, v }) => (
                      <div key={label} className="ph-cost-cell">
                        <span className="ph-cost-label">{label}</span>
                        <span className="ph-cost-value">{fmtUsd(v.costUsd)}</span>
                        <span className="ph-cost-sub">
                          {v.calls} call{v.calls === 1 ? '' : 's'} · {fmtTokens(v.tokens)}
                        </span>
                        {/* Never folded into the total — an unpriced call is
                            missing from the figure, not free. */}
                        {v.unpriced > 0 && (
                          <span className="ph-cost-unpriced">
                            +{v.unpriced} unpriced
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                  {ai.cost.byTask?.length > 0 && (
                    <div className="ph-cost-tasks">
                      {ai.cost.byTask.map(t => (
                        <div key={t.task} className="ph-cost-task">
                          <span className="ph-cost-task-name">{t.task}</span>
                          <span className="ph-cost-task-calls">{t.calls}×</span>
                          <span className="ph-cost-task-value">{fmtUsd(t.costUsd)}</span>
                          {t.unpriced > 0 && <span className="ph-cost-unpriced">{t.unpriced} unpriced</span>}
                        </div>
                      ))}
                    </div>
                  )}
                  {ai.cost.last30.calls === 0 && (
                    <div className="ph-cost-unknown">
                      Nothing recorded yet — the ledger starts from the first cloud call after 26 Aug.
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {aiState.health.recent?.length > 0 && (
            <>
              <div className="ph-sub-title">Recent calls</div>
              <div className="ph-recent">
                {aiState.health.recent.slice(0, 8).map((r, i) => (
                  <div key={i} className={`ph-recent-row ${r.ok ? '' : 'bad'}`}>
                    <span className="ph-recent-task">{r.taskType}</span>
                    <span className="ph-recent-provider">{r.provider}{r.fallback && r.ok ? ' ↩' : ''}</span>
                    <span className="ph-recent-ms">{r.ms < 1000 ? `${r.ms}ms` : `${(r.ms / 1000).toFixed(1)}s`}</span>
                    <span className="ph-recent-when">{new Date(r.at).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            </>
          )}
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
