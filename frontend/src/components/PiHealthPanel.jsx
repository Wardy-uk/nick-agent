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

      {/* ---- FOCUS BAND: the verdict, then only what needs attention ---- */}
      <section className={`ph-focus ph-status-${overallStatus}`}>
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

      {/* ---- BROADBAND: sampled 4x/day by cron, never on page load ---- */}
      {broadband && (
        <section className="ph-card">
          <h2 className="ph-card-title">
            Broadband <span className="ph-card-hint">
              {broadband.ok
                ? `${(broadband.sponsor || '').replace(/_/g, ' ')} ${broadband.server || ''} · tested ${broadband.ageMs != null ? Math.round(broadband.ageMs / 3600000) + 'h ago' : 'recently'}`
                : 'last test failed'}
            </span>
          </h2>

          {broadband.ok ? (
            <>
              <div className="ph-router-grid">
                <div>
                  <span>Download</span>
                  {/* Judged against this line's own history, not a headline number —
                      what matters is a drop from what it normally does. */}
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
                </div>
              )}
            </>
          ) : (
            <div className="ph-smart-missing">
              Last speed test failed — {broadband.error || 'no result'}
            </div>
          )}
        </section>
      )}

      {/* ---- PI 4 (pi-dev): retired from the AI path, still on the network ---- */}
      {pi4 && (
        <section className="ph-card">
          <h2 className="ph-card-title">
            Pi 4 <span className="ph-card-hint">
              {pi4.reachable
                ? `${pi4.model || 'pi-dev'} · ${pi4.stale ? 'STALE' : `checked ${Math.round((pi4.ageMs || 0) / 1000)}s ago`}`
                : 'unreachable'}
            </span>
          </h2>

          {pi4.reachable ? (
            <>
              <div className="ph-router-grid">
                <div>
                  <span>CPU load</span>
                  <b className={pi4.loadPct >= 90 ? 'bad' : pi4.loadPct >= 70 ? 'warn' : 'good'}>
                    {pi4.loadPct}%
                  </b>
                </div>
                <div>
                  <span>Temperature</span>
                  <b className={pi4.tempC >= 80 ? 'bad' : pi4.tempC >= 70 ? 'warn' : 'good'}>{pi4.tempC}°C</b>
                </div>
                <div>
                  <span>Memory</span>
                  <b className={pi4.memUsedPct >= 90 ? 'bad' : pi4.memUsedPct >= 80 ? 'warn' : 'good'}>
                    {pi4.memUsedPct}%
                  </b>
                </div>
                <div>
                  <span>Swap used</span>
                  {/* Swapping on an SD card is slow and wears the card out */}
                  <b className={pi4.swapUsedKb > 0 ? 'warn' : 'good'}>
                    {pi4.swapUsedKb ? `${Math.round(pi4.swapUsedKb / 1024)}MB` : 'none'}
                  </b>
                </div>
                <div><span>Uptime</span><b>{fmtDuration(pi4.uptimeSec)}</b></div>
                <div>
                  <span>Disk</span>
                  <b className={pi4.diskUsedPct >= 90 ? 'bad' : 'good'}>{pi4.diskUsedPct}%</b>
                </div>
              </div>

              {pi4.power && !pi4.power.clean && (
                <div className="ph-router-foot">
                  {pi4.power.now.length > 0 && (
                    <span className="ph-router-flag">NOW: {pi4.power.now.join(', ')}</span>
                  )}
                  {pi4.power.since.length > 0 && (
                    <span className="ph-router-flag">since boot: {pi4.power.since.join(', ')}</span>
                  )}
                </div>
              )}

              {pi4.topCpu && (
                <div className="ph-router-foot">
                  <span>top: {pi4.topCpu.trim().split(/\s+/).map(x => x.replace(':', ' ')).join(' · ')}</span>
                </div>
              )}
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

          <div className="ph-router-foot">
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
