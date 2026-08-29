import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './HealthCard.css';

// #42 — the stress score, rendered at last.
//
// The backend has returned a score since 14 Aug and nothing read it, which is
// the same species as #3, #28 and #36: a working backend looks finished.
//
// Self-contained on purpose. InsightsPanel returns early when its own activity
// fetch comes back empty, and health has nothing to do with that — hanging this
// off the same request would mean a quiet morning for the activity feed hides
// the health data too.
//
// The governing rule here is that the card must never look more certain than
// stress-score is. That service deliberately returns `calibrating` with a NULL
// score below 7 days / 20 samples, and `stale` when the newest HRV reading is
// over 6h old. Both get their own state; neither renders a number.

const BAND_CLASS = {
  low: 'hc-band--low',
  moderate: 'hc-band--mod',
  elevated: 'hc-band--high',
  high: 'hc-band--high',
};

function ageLabel(hours) {
  if (hours === null || hours === undefined) return 'unknown';
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const READY_CLASS = { low: 'hc-band--high', normal: 'hc-band--mod', high: 'hc-band--low' };

export default function HealthCard() {
  const [stress, setStress] = useState(null);
  const [series, setSeries] = useState(null);
  const [sleep, setSleep] = useState(null);
  const [ready, setReady] = useState(null);
  const [signals, setSignals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [s, m, sl, rd, sg] = await Promise.all([
        fetch(apiUrl('/api/health/stress')).then(r => r.json()),
        fetch(apiUrl('/api/health/metrics?days=30')).then(r => r.json()),
        fetch(apiUrl('/api/health/sleep?days=7')).then(r => r.json()),
        fetch(apiUrl('/api/health/readiness')).then(r => r.json()),
        fetch(apiUrl('/api/health/signals')).then(r => r.json()),
      ]);
      setStress(s);
      setSeries(m);
      setSleep(sl);
      setReady(rd);
      setSignals(sg);
      setFailed(false);
    } catch {
      // "Couldn't ask" must stay distinguishable from "there's nothing there" —
      // an empty card would read as a healthy quiet day.
      setFailed(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading) return <div className="hc"><div className="hc-quiet">Reading health data…</div></div>;
  if (failed) return <div className="hc"><div className="hc-quiet hc-quiet--err">Couldn’t reach the health API.</div></div>;

  const metrics = series?.metrics || [];
  const shown = showAll ? metrics : metrics.slice(0, 8);
  const nights = sleep?.nights || [];

  return (
    <div className="hc">
      <div className="hc-head">
        <h3 className="hc-title">Health</h3>
        <button className="hc-refresh" onClick={fetchAll}>Refresh</button>
      </div>

      {/* ── Readiness ──────────────────────────────────────────────
          Leads the card because it is the only line here that needed two years
          of Nick to produce. "HRV 14ms" is a number; "below your normal range"
          is the thing worth reading, and the server composed that sentence so
          the planner, chat and this cannot phrase it three ways.

          The three states must stay distinct: a score, "still calibrating", and
          "nothing readable today". Collapsing the last two into a blank space is
          how a broken feed comes to look like a healthy morning. */}
      <div className="hc-ready">
        {ready?.known ? (
          <>
            <div className={`hc-ready-score ${READY_CLASS[ready.state] || ''}`}>{ready.score}</div>
            <div className="hc-ready-side">
              <div className="hc-ready-label">
                {ready.state === 'low' ? 'Running low' : ready.state === 'high' ? 'Well recovered' : 'About normal'}
                {ready.partial && (
                  <span className="hc-ready-partial" title={`Only ${ready.inputsRead} of 3 inputs could be read`}>
                    · partial
                  </span>
                )}
              </div>
              <div className="hc-ready-sub">{ready.sentence}</div>
              <div className="hc-ready-parts">
                {(ready.contributors || []).map(c => (
                  <span key={c.input} className="hc-ready-part" title={c.note}>
                    {c.input === 'hrv' ? `HRV ${c.value}ms` : c.input === 'rhr' ? `RHR ${c.value}bpm` : `${c.value}h sleep`}
                    <em>{c.baseline != null ? ` vs ${c.baseline}` : ''}</em>
                  </span>
                ))}
              </div>
            </div>
          </>
        ) : (
          // The service's own reason, never a paraphrase — it is the difference
          // between "not enough history yet" and "the watch told us nothing".
          <div className="hc-quiet">Readiness: {ready?.reason || 'not available'}.</div>
        )}
      </div>

      {/* ── What has changed ───────────────────────────────────────
          Trends, not today's numbers. Pull-only by design — nothing here
          notifies, because nudge volume is the budget that argues against
          everything else. */}
      {(signals?.findings?.length > 0 || signals?.unknowns?.length > 0) && (
        <div className="hc-signals">
          <div className="hc-sub">What’s changed</div>
          {(signals.findings || []).map(f => (
            <div className={`hc-signal hc-signal--${f.level}`} key={f.id}>
              <div className="hc-signal-title">{f.title}</div>
              <div className="hc-signal-detail">{f.detail}</div>
              {/* Never hidden. This is the one place a reading is most likely to
                  be over-read into a diagnosis nobody made. */}
              {f.caveat && <div className="hc-signal-caveat">{f.caveat}</div>}
            </div>
          ))}
          {(signals.unknowns || []).length > 0 && (
            <div className="hc-signal-unknown">
              Couldn’t check: {signals.unknowns.map(u => u.input).join(', ')} — so this isn’t an all-clear.
            </div>
          )}
        </div>
      )}

      {/* ── Stress ─────────────────────────────────────────────── */}
      <div className="hc-stress">
        {stress?.status === 'calibrating' && (
          <div className="hc-cal">
            <div className="hc-cal-label">Calibrating</div>
            {/* The service's own sentence, not a paraphrase — it states exactly
                how much baseline is still missing. */}
            <div className="hc-cal-detail">{stress.detail || 'Building a baseline.'}</div>
            <div className="hc-cal-bar">
              <span style={{ width: `${Math.min(100, Math.round(((stress.baselineDays || 0) / 7) * 100))}%` }} />
            </div>
          </div>
        )}

        {stress?.status === 'stale' && (
          <div className="hc-cal">
            <div className="hc-cal-label">No recent reading</div>
            <div className="hc-cal-detail">
              {stress.detail || 'Nothing recent enough to score. The phone syncs when iOS lets it.'}
            </div>
          </div>
        )}

        {typeof stress?.score === 'number' && (
          <>
            <div className={`hc-score ${BAND_CLASS[String(stress.band || '').toLowerCase()] || ''}`}>
              <span className="hc-score-num">{stress.score}</span>
              <span className="hc-score-of">/100</span>
            </div>
            <div className="hc-score-side">
              <div className="hc-score-label">{stress.label || stress.band || 'Stress'}</div>
              <div className="hc-score-sub">
                HRV {stress.hrv}ms{stress.hrvAt ? ` · ${stress.hrvAt.slice(11, 16)}` : ''}
              </div>
            </div>
          </>
        )}

        {!stress?.status && typeof stress?.score !== 'number' && (
          <div className="hc-quiet">No stress data yet.</div>
        )}
      </div>

      {/* Caveats are the service saying "this number has a wobble in it" —
          Apple Health cannot tell exercise from stress, so an elevated HR after
          a run reads the same as a bad meeting. Never hidden. */}
      {(stress?.caveats || []).map((c, i) => (
        <div key={i} className="hc-caveat">⚠ {c}</div>
      ))}

      {/* ── Sleep ──────────────────────────────────────────────── */}
      {nights.length > 0 && (
        <div className="hc-sleep">
          <div className="hc-sub">Sleep</div>
          {nights.slice(0, 5).map((n) => (
            <div className="hc-night" key={n.night}>
              <span className="hc-night-date">{n.night.slice(5)}</span>
              {/* An unstaged night draws one flat bar rather than three
                  coloured ones — the breakdown genuinely is not known, and a
                  bar built from a single whole-night figure would invent a
                  shape. #42's rule: never look more certain than the service. */}
              <span className="hc-night-bar">
                {n.asleepSource === 'staged'
                  ? ['deep', 'rem', 'core'].map((st) => (
                    n.stages?.[st] ? (
                      <span
                        key={st}
                        className={`hc-seg hc-seg--${st}`}
                        style={{ flexGrow: n.stages[st] }}
                        title={`${st} ${n.stages[st]}h`}
                      />
                    ) : null
                  ))
                  : <span className="hc-seg hc-seg--unstaged" style={{ flexGrow: 1 }} title="whole-night total only — no stage breakdown recorded" />}
              </span>
              <span className="hc-night-total">
                {n.asleepHours}h
                {n.asleepSource === 'unspecified' && <span className="hc-night-flag" title="whole-night total only — no stage breakdown recorded">*</span>}
              </span>
              <span className="hc-night-eff">{n.efficiency === null ? '—' : `${n.efficiency}%`}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── What is actually arriving ──────────────────────────── */}
      <div className="hc-feed">
        <div className="hc-sub">
          Data arriving
          <span className="hc-sub-note">
            {series?.metricCount || 0} metrics · {(series?.totalSamples || 0).toLocaleString()} samples / {series?.windowDays || 30}d
            {series?.allTime?.samples > 0 && (
              <> · {series.allTime.samples.toLocaleString()} all-time</>
            )}
          </span>
        </div>

        {/* An empty window over a full table is what a backfill in progress
            looks like — the app syncs forward chronologically, so it can hold
            160k rows and still have nothing from the last 30 days. Saying
            "nothing in the window" there would read as a broken feed. */}
        {metrics.length === 0 && (series?.allTime?.samples > 0) && (
          <div className="hc-quiet">
            Nothing in the last {series.windowDays} days, but{' '}
            <strong>{series.allTime.samples.toLocaleString()}</strong> samples are on file
            across {series.allTime.metricCount} metrics, newest{' '}
            {String(series.allTime.newestAt || '').slice(0, 10)}. The first sync backfills
            forward from {String(series.allTime.oldestAt || '').slice(0, 10)}, so this fills
            in as it catches up.
          </div>
        )}

        {metrics.length === 0 && !(series?.allTime?.samples > 0) && (
          <div className="hc-quiet">
            Nothing yet. iOS decides when the phone syncs, so a gap isn’t
            necessarily a fault — but nothing at all usually means the app was force-quit.
          </div>
        )}

        {shown.map((m) => (
          <div className="hc-metric" key={m.metric}>
            <span className="hc-metric-name">{m.metric}</span>
            <span className="hc-metric-n">{m.samples.toLocaleString()}</span>
            {/* Freshness, not volume, is what says the feed has stopped. */}
            <span className={`hc-metric-age${m.ageHours > 48 ? ' hc-metric-age--old' : ''}`}>
              {ageLabel(m.ageHours)}
            </span>
          </div>
        ))}

        {metrics.length > 8 && (
          <button className="hc-more" onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Show fewer' : `Show all ${metrics.length}`}
          </button>
        )}
      </div>
    </div>
  );
}
