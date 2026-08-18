'use strict';

/**
 * Weekly Risk & Anomaly Summary — PIP competency 2 (proactive oversight).
 *
 * Nick sends this to Chris by midday every Monday; it is a standing 1:1 agenda
 * item and the evidence for proactive review of team activity with early
 * escalation. The first edition (w/c 11 Aug 2026) was assembled by hand from a
 * NOVA screen, which is fine once and untenable weekly — the failure mode of a
 * hand-built compliance report is that it silently stops being built.
 *
 * Split like pi-health and state-of-play: `snapshot()` reads, `assess()` judges,
 * `render()` writes the note. `assess()` is pure and takes a plain object, so
 * the anomaly rules — which are the actual product here, not the numbers — can
 * be pinned in a test with no NOVA, no vault and no clock.
 *
 * Two things the design refuses to do:
 *
 * 1. **It never invents the numbers it cannot reach.** Every source records
 *    whether it answered, and a section with no data says so rather than
 *    rendering as a healthy zero. A report that reads "0 breaches" because NOVA
 *    was down is worse than no report, because it is a false all-clear sent to
 *    the person assessing the PIP.
 *
 * 2. **It never asserts the manual sections on Nick's behalf.** Overtime,
 *    escalations-to-Chris, actions and data-quality judgements are his to state.
 *    They are stored per week and carried forward, and the report is BLOCKED
 *    from publishing while any required one is unanswered — the same shape as
 *    action-presenter's blockers: refuse and say why, rather than publish
 *    something that quietly reads as "nil" when it means "not asked".
 */

const fs = require('fs');
const path = require('path');

const db = require('../db/database');
const nova = require('./nova-client');
const managementLog = require('./management-log');

/** Compliance KPIs are measured against this unless NOVA says otherwise. */
const COMPLIANCE_TARGET = 95;
/** A reason-code vocabulary is broken past this share of `unknown`. */
const UNKNOWN_REASON_ESCALATE_SHARE = 0.5;
/** Consecutive weeks below target before a slide is an escalation, not a blip. */
const SLIDE_WEEKS = 3;
/** Snapshot older than this many days is reported as stale, not as fact. */
const SNAPSHOT_STALE_DAYS = 3;
/** Lookback for the flow signals. 30 days, so a weekly report has a stable base. */
const FLOW_WINDOW_DAYS = 30;
/** Handback volume rising by more than this share, period on period, is a finding. */
const HANDBACK_RISE_SHARE = 0.25;
/** Queue moves before a single ticket is worth naming in the report. */
const PING_PONG_NAMEABLE = 6;
/** One queue holding more than this share of breaches is a routing story. */
const BREACH_CONCENTRATION = 0.8;

const MANUAL_KEY = week => `weekly_risk_manual_${week}`;
const PUBLISH_KEY = week => `weekly_risk_published_${week}`;

// ── Dates ────────────────────────────────────────────────────────────────────

function todayLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Monday of the week containing `date`. Local, never toISOString(). */
function weekCommencing(date = todayLocal()) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const shift = (dt.getDay() + 6) % 7;   // Mon=0 … Sun=6
  dt.setDate(dt.getDate() - shift);
  return todayLocal(dt);
}

function previousWeek(week) {
  const [y, m, d] = week.split('-').map(Number);
  const dt = new Date(y, m - 1, d - 7);
  return todayLocal(dt);
}

function formatUk(date) {
  if (!date) return '—';
  const [y, m, d] = date.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

// ── Manual input ─────────────────────────────────────────────────────────────

/**
 * The shape Nick fills in. `null` is meaningfully different from `0` or `[]`
 * throughout: it means "not yet answered", and it is what blocks publication.
 * Zero overtime is a claim; no overtime figure is an absence.
 */
function emptyManual() {
  return {
    overtime: { hours: null, approvalsOutstanding: null, note: '' },
    headline: '',
    escalateToChris: null,      // array once answered, [] means "nothing to escalate"
    actions: null,
    dataQuality: null,
    positives: [],
  };
}

function getManual(week) {
  const stored = db.getState(MANUAL_KEY(week));
  if (stored) {
    try { return { ...emptyManual(), ...JSON.parse(stored) }; } catch { /* fall through */ }
  }
  return carryForward(week);
}

/**
 * Seed this week from last week. Carried: the overtime log (a running record —
 * "nil again" is a fact worth restating, and re-typing it weekly is how it stops
 * being restated) and any UNCLOSED action. Not carried: the headline, the
 * escalation list and the data-quality exceptions — those are judgements about
 * this week's numbers, and inheriting them would let last week's escalation
 * re-send itself as though it were new.
 */
function carryForward(week) {
  const base = emptyManual();
  const prev = db.getState(MANUAL_KEY(previousWeek(week)));
  if (!prev) return base;
  try {
    const p = JSON.parse(prev);
    if (p.overtime) base.overtime = { ...p.overtime, note: p.overtime.note || '' };
    if (Array.isArray(p.actions)) {
      const open = p.actions.filter(a => a && !a.done);
      if (open.length) base.actions = open.map(a => ({ ...a, carriedFrom: previousWeek(week) }));
    }
  } catch { /* a corrupt blob must not stop this week's report */ }
  return base;
}

function setManual(week, patch = {}) {
  const current = getManual(week);
  const next = {
    ...current,
    ...patch,
    overtime: { ...current.overtime, ...(patch.overtime || {}) },
  };
  db.setState(MANUAL_KEY(week), JSON.stringify(next));
  return next;
}

/**
 * What is still unanswered. Deliberately restates each gap as the sentence that
 * would otherwise be published as fact, so it is obvious what the silence
 * would have claimed.
 */
function manualBlockers(manual) {
  const out = [];
  if (manual.overtime.hours === null) {
    out.push('Overtime hours not entered — the report would otherwise read as nil overtime, which is a claim, not an absence of data.');
  }
  if (manual.escalateToChris === null) {
    out.push('Escalations to Chris not confirmed — an empty list here means "nothing to escalate", which must be a decision.');
  }
  if (manual.dataQuality === null) {
    out.push('Data-quality exceptions not reviewed — NEURO can spot them but cannot judge whether they are real or a reporting artefact.');
  }
  return out;
}

// ── Task position ────────────────────────────────────────────────────────────

/**
 * Open / overdue / closed-last-week, from the task store.
 *
 * "Closed last week" is the PREVIOUS Monday-to-Sunday, not a rolling 7 days.
 * The report is a weekly artefact with a fixed week boundary, and a rolling
 * window would quietly change what it counted depending on the hour it ran —
 * which is the one thing a figure sent to a manager must not do.
 *
 * `dropped` is counted separately from `done`. Both leave the open list, but
 * only one of them is work completed, and folding them together would let a
 * clear-out read as a productive week.
 */
function taskCounts(week = weekCommencing()) {
  const today = todayLocal();
  const lastWeekStart = previousWeek(week);
  // Sunday of that week — the day before this week began.
  const [y, m, d] = week.split('-').map(Number);
  const lastWeekEnd = todayLocal(new Date(y, m - 1, d - 1));

  const one = (sql, params) => {
    try { return db.get(sql, params)?.c ?? null; } catch { return null; }
  };

  const open = one("SELECT COUNT(*) c FROM tasks WHERE status IN ('open','in-progress')");
  const overdue = one(
    "SELECT COUNT(*) c FROM tasks WHERE status IN ('open','in-progress') AND due_date IS NOT NULL AND due_date < ?",
    [today],
  );
  const closed = one(
    "SELECT COUNT(*) c FROM tasks WHERE status = 'done' AND completed_at IS NOT NULL AND DATE(completed_at) BETWEEN ? AND ?",
    [lastWeekStart, lastWeekEnd],
  );
  const dropped = one(
    "SELECT COUNT(*) c FROM tasks WHERE status = 'dropped' AND completed_at IS NOT NULL AND DATE(completed_at) BETWEEN ? AND ?",
    [lastWeekStart, lastWeekEnd],
  );
  // An open task with no due date cannot be overdue, but it also cannot be
  // chased. Reported so "3 overdue" is not read as "everything else is on time".
  const undated = one(
    "SELECT COUNT(*) c FROM tasks WHERE status IN ('open','in-progress') AND due_date IS NULL",
  );

  return {
    open, overdue, undated,
    closedLastWeek: closed,
    droppedLastWeek: dropped,
    lastWeek: { from: lastWeekStart, to: lastWeekEnd },
    // null anywhere means the query failed, and the report says so rather than
    // rendering a zero it did not measure.
    available: open !== null,
  };
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

async function pull(name, fn) {
  try {
    return { name, ok: true, data: await fn() };
  } catch (err) {
    return { name, ok: false, error: err?.message || String(err), data: null };
  }
}

/**
 * Gather everything. Each source is wrapped so one failure degrades a section
 * rather than losing the report — and every failure is carried through to the
 * rendered note, because a missing section that says nothing is indistinguishable
 * from a healthy one.
 */
async function snapshot({ week = weekCommencing(), date } = {}) {
  const novaReady = nova.isConfigured();

  const [kpi, trend, escalationStats, flow] = novaReady
    ? await Promise.all([
      pull('kpi-snapshot', () => nova.call(`/api/neuro-bridge/kpi-snapshot${date ? `?date=${date}` : ''}`)),
      pull('kpi-trend', () => nova.call('/api/neuro-bridge/kpi-trend?weeks=6')),
      pull('escalation-stats', () => nova.call('/api/neuro-bridge/escalation-stats?days=30')),
      // How tickets MOVE. The Support Review was written from these five facts
      // and every one was computable from NOVA on the day it was written — so
      // they cross every week now, whether or not anyone thinks to ask.
      pull('flow-signals', () => nova.call(`/api/neuro-bridge/flow-signals?days=${FLOW_WINDOW_DAYS}`)),
    ])
    : [
      { name: 'kpi-snapshot', ok: false, error: 'NOVA bridge not configured', data: null },
      { name: 'kpi-trend', ok: false, error: 'NOVA bridge not configured', data: null },
      { name: 'escalation-stats', ok: false, error: 'NOVA bridge not configured', data: null },
      { name: 'flow-signals', ok: false, error: 'NOVA bridge not configured', data: null },
    ];

  // Nick's own task position. Competency 4 is about overdue management actions,
  // but the 12 Aug review also put a number on the personal backlog — 400+ items
  // since 1 June — so "open / overdue / closed last week" is the movement that
  // conversation actually asked for. Read straight from the task store, which
  // is the source of truth for tasks.
  const tasks = taskCounts(week);

  let jiraEscalations = null;
  try {
    jiraEscalations = require('./jira').getUnseenEscalations?.() ?? null;
  } catch { jiraEscalations = null; }

  return {
    week,
    generatedAt: new Date().toISOString(),
    today: todayLocal(),
    sources: [kpi, trend, escalationStats, flow].map(s => ({ name: s.name, ok: s.ok, error: s.error || null })),
    kpi: kpi.data,
    trend: trend.data,
    escalationStats: escalationStats.data,
    flow: flow.data,
    jiraEscalations,
    tasks,
    management: managementLog.status(),
    manual: getManual(week),
  };
}

// ── Judgement ────────────────────────────────────────────────────────────────

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isComplianceKpi(name) {
  return /compliance/i.test(name || '');
}

/**
 * RAG → bucket.
 *
 * `jira_kpi_daily.rag` is **numeric**: 1 green, 2 amber, 3 red. Verified
 * against the live snapshot rather than assumed — every KPI meeting its target
 * came back 1 (CSAT 100 vs 80, Production FRT 100 vs 95) and every one below it
 * came back 3 (Tier 2 FRT 40 vs 95, AI Resolution Rate 0 vs 50).
 *
 * Getting this wrong is silent and total: the first cut only handled letters,
 * so all 111 rows fell to `unrated`, `rated` was 0, and the headline Chris
 * reads first rendered "—" on a week with 63 red KPIs. Letters are still
 * accepted because nothing guarantees the column stays numeric, and a mapping
 * that handles both cannot break on the day it changes.
 */
function ragBucket(rag) {
  if (rag === null || rag === undefined || rag === '') return 'unrated';
  const n = Number(rag);
  if (Number.isFinite(n)) {
    if (n === 1) return 'green';
    if (n === 2) return 'amber';
    if (n === 3) return 'red';
    return 'unrated';
  }
  const v = String(rag).trim().toLowerCase();
  if (v.startsWith('g')) return 'green';
  if (v.startsWith('r')) return 'red';
  if (v.startsWith('a') || v.startsWith('o')) return 'amber';
  return 'unrated';
}

/**
 * Per-KPI week-on-week series from the trend rows. This is Chris's ask from the
 * 12 Aug 1:1 — a single week's snapshot cannot tell "bad" from "getting worse",
 * and the Tier 2 slide was only visible because Nick had hand-carried five
 * weeks of numbers into the first edition.
 */
function buildTrend(trendData) {
  const rows = trendData?.rows || [];
  const byKpi = new Map();
  for (const r of rows) {
    const key = r.KPI;
    if (!key) continue;
    if (!byKpi.has(key)) byKpi.set(key, []);
    byKpi.get(key).push({
      period: String(r.period || '').slice(0, 10),
      value: num(r.avgValue),
      samples: num(r.samples),
      group: r.KPIGroup || null,
    });
  }
  const out = [];
  for (const [kpi, series] of byKpi) {
    series.sort((a, b) => a.period.localeCompare(b.period));
    const latest = series[series.length - 1] || null;
    const prior = series[series.length - 2] || null;
    const delta = latest && prior && latest.value !== null && prior.value !== null
      ? Math.round((latest.value - prior.value) * 10) / 10
      : null;
    out.push({ kpi, group: latest?.group ?? null, series, latest, prior, delta });
  }
  return out.sort((a, b) => a.kpi.localeCompare(b.kpi));
}

/**
 * A compliance KPI below target for SLIDE_WEEKS consecutive weeks, ending now.
 * Counted from the most recent week backwards, so a bad patch that has since
 * recovered does not read as an ongoing slide.
 */
function consecutiveBelowTarget(series, target) {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i -= 1) {
    const v = series[i].value;
    if (v === null || v >= target) break;
    n += 1;
  }
  return n;
}

/**
 * Turn a snapshot into the ranked findings the report is built from. PURE.
 *
 * Ordering is the product, the same as state-of-play: a sustained compliance
 * slide outranks a big-but-known backlog number, and a broken measurement
 * outranks both — because a number you cannot trust makes every other number on
 * the page unfalsifiable.
 */
function assess(snap) {
  const findings = [];
  const rows = snap?.kpi?.rows || [];
  const trend = buildTrend(snap?.trend);
  const failedSources = (snap?.sources || []).filter(s => !s.ok);

  // A source that did not answer is the first thing on the page. Not because it
  // is the worst news, but because it decides how much of the rest to believe.
  for (const s of failedSources) {
    findings.push({
      severity: 'blocked',
      kind: 'source-unavailable',
      title: `${s.name} unavailable`,
      detail: `${s.error}. The sections built on it are absent, not zero.`,
    });
  }

  // Snapshot staleness — the report is generated Monday morning and n8n may not
  // have run. Reporting Friday's numbers as today's is the failure to avoid.
  const ageDays = num(snap?.kpi?.ageDays);
  if (snap?.kpi && ageDays !== null && ageDays > SNAPSHOT_STALE_DAYS) {
    findings.push({
      severity: 'escalate',
      kind: 'stale-snapshot',
      title: `KPI snapshot is ${ageDays} days old`,
      detail: `Latest KPI data is dated ${snap.kpi.date}. The KPI pipeline may have stopped — every figure below is as at that date, not today.`,
    });
  }

  // RAG rollup — the headline Chris reads first.
  const buckets = { green: 0, amber: 0, red: 0, unrated: 0 };
  for (const r of rows) buckets[ragBucket(r.RAG)] += 1;
  const rated = buckets.green + buckets.amber + buckets.red;
  const rag = {
    ...buckets,
    total: rows.length,
    rated,
    greenPct: rated ? Math.round((buckets.green / rated) * 100) : null,
    redPct: rated ? Math.round((buckets.red / rated) * 100) : null,
  };

  // Sustained compliance slides.
  for (const t of trend) {
    if (!isComplianceKpi(t.kpi)) continue;
    const weeks = consecutiveBelowTarget(t.series, COMPLIANCE_TARGET);
    if (weeks < SLIDE_WEEKS) continue;
    const history = t.series.slice(-6).map(s => `${Math.round(s.value)}%`).join(' → ');
    findings.push({
      severity: 'escalate',
      kind: 'compliance-slide',
      title: `${t.kpi} below ${COMPLIANCE_TARGET}% for ${weeks} straight weeks`,
      detail: `${history} (last ${Math.min(t.series.length, 6)} weeks). Needs a root-cause look — capacity vs process vs ticket mix.`,
      kpi: t.kpi,
      weeks,
    });
  }

  // Ageing beyond target. Reported as a ratio, because "249 days against a
  // 31-day target" and "39 against 10" are different sizes of the same problem
  // and the raw day count ranks them wrongly.
  const ageing = rows
    .filter(r => /^age|oldest|actionable/i.test(r.KPIGroup || '') || /oldest/i.test(r.KPI || ''))
    .map(r => {
      const value = num(r.Count);
      const target = num(r.KPITarget);
      return {
        kpi: r.KPI,
        value,
        target,
        ratio: value !== null && target ? Math.round((value / target) * 10) / 10 : null,
      };
    })
    .filter(a => a.ratio !== null && a.ratio > 1)
    .sort((a, b) => b.ratio - a.ratio);

  if (ageing.length) {
    findings.push({
      severity: 'warn',
      kind: 'ageing-backlog',
      title: `${ageing.length} queue${ageing.length === 1 ? '' : 's'} carrying tickets past target age`,
      detail: `Worst: ${ageing.slice(0, 3).map(a => `${a.kpi} ${a.value} vs target ${a.target} (${a.ratio}×)`).join('; ')}. Worth confirming these are a genuine backlog and not a due-date-configuration artefact.`,
      items: ageing,
    });
  }

  // Escalation reason-code capture.
  let reasons = null;
  const stats = snap?.escalationStats;
  if (stats && Array.isArray(stats.by_reason)) {
    const total = stats.by_reason.reduce((s, r) => s + (num(r.count) || 0), 0);
    const unknown = stats.by_reason
      .filter(r => !r.reason_code || String(r.reason_code).toLowerCase() === 'unknown')
      .reduce((s, r) => s + (num(r.count) || 0), 0);
    const share = total ? unknown / total : 0;
    reasons = {
      total,
      unknown,
      share: total ? Math.round(share * 1000) / 10 : null,
      coded: stats.by_reason.filter(r => r.reason_code && String(r.reason_code).toLowerCase() !== 'unknown'),
    };
    if (total > 0 && share > UNKNOWN_REASON_ESCALATE_SHARE) {
      findings.push({
        severity: 'escalate',
        kind: 'reason-capture-broken',
        title: `Escalation reason capture is not working — ${unknown} of ${total} logged as \`unknown\``,
        detail: `${reasons.share}% of escalations in the last 30 days carry no reason code. Escalation reporting cannot be meaningful until coding is fixed.`,
      });
    }
  }

  // Zero-valued KPIs that have a non-zero target — the "AI Resolution Rate 0%"
  // species. A metric reading exactly zero against a real target is more often a
  // stalled pipeline than a team that did none of it.
  const suspiciousZeros = rows.filter(r => {
    const v = num(r.Count);
    const t = num(r.KPITarget);
    return v === 0 && t !== null && t > 0 && /higher is better/i.test(r.KPIDirection || '');
  }).map(r => ({ kpi: r.KPI, target: num(r.KPITarget) }));

  if (suspiciousZeros.length) {
    findings.push({
      severity: 'warn',
      kind: 'zero-against-target',
      title: `${suspiciousZeros.length} KPI${suspiciousZeros.length === 1 ? '' : 's'} reading zero against a live target`,
      detail: `${suspiciousZeros.map(z => `${z.kpi} (target ${z.target})`).join(', ')}. Check whether the pipeline behind each has stalled before reading these as performance.`,
      items: suspiciousZeros,
    });
  }

  // ── Ticket flow ────────────────────────────────────────────────────────────
  //
  // The Support Review's core diagnosis: the problem is not ticket volume, it is
  // that tickets move badly. Ownership is unclear, handbacks carry no guidance,
  // and work stalls between teams. These rules exist so that story is told by
  // NOVA every week rather than by a consultant every year.
  //
  // Each rule reports MOVEMENT where it can. A handback count is a fact about
  // the operating model; a handback count that rose 40% in a fortnight is a
  // fact about this fortnight, and only the second one is news.
  const flow = snap?.flow || null;
  if (flow) {
    const hb = flow.handbacks;
    if (hb?.ok && hb.data) {
      const { total, previous, changePct, routes } = hb.data;
      const rising = previous > 0 && (total - previous) / previous > HANDBACK_RISE_SHARE;
      if (total > 0) {
        findings.push({
          severity: rising ? 'escalate' : 'warn',
          kind: 'handbacks',
          title: rising
            ? `Handbacks up ${changePct}% — ${total} tickets returned between tiers`
            : `${total} tickets handed back between tiers`,
          detail: `${routes.slice(0, 3).map(r => `${r.from_tier} → ${r.to_tier} ${r.count}`).join('; ')}${routes.length > 3 ? `, +${routes.length - 3} more routes` : ''}. Previous ${FLOW_WINDOW_DAYS} days: ${previous}. Each handback is a ticket that was escalated without what the receiving team needed, or returned without saying what was missing.`,
          items: routes,
        });
      }
    }

    const pp = flow.pingPong;
    if (pp?.ok && pp.data?.ticketsAffected > 0) {
      const worst = (pp.data.worst || []).filter(t => t.moves >= PING_PONG_NAMEABLE);
      findings.push({
        // A ticket crossing queues six times has had six chances to be owned and
        // was not owned once. That is worth a manager's attention by itself.
        severity: worst.length ? 'escalate' : 'warn',
        kind: 'ping-pong',
        title: `${pp.data.ticketsAffected} tickets crossed queues ${pp.data.threshold}+ times`,
        detail: worst.length
          ? `Worst: ${worst.slice(0, 3).map(t => `${t.ticket_key} (${t.moves} moves, ${t.returns} returns)`).join('; ')}. Each of these has no single case owner — the review's number-one recommendation.`
          : `None past ${PING_PONG_NAMEABLE} moves. Worth watching rather than escalating.`,
        items: pp.data.worst,
      });
    }

    const bq = flow.breachesByQueue;
    if (bq?.ok && bq.data?.total > 0) {
      const top = bq.data.byTier[0];
      if (top && top.sharePct !== null && top.sharePct / 100 > BREACH_CONCENTRATION) {
        findings.push({
          // Deliberately worded as a routing finding, not a performance one. The
          // review found 90.5% of breaches happening in Customer Care, and the
          // available misreading — "Customer Care is slow" — would send the
          // whole improvement effort into the wrong team. Customer Care is where
          // tickets wait for everyone else.
          severity: 'warn',
          kind: 'breach-concentration',
          title: `${top.sharePct}% of SLA breaches happen while the ticket sits in ${top.tier}`,
          detail: `${top.breaches} of ${bq.data.total} breaches in ${FLOW_WINDOW_DAYS} days. This is a routing and ownership finding, not a ${top.tier} performance finding — it is where tickets wait for other teams. The fix is upstream: acceptance criteria and a named case owner.`,
          items: bq.data.byTier,
        });
      }
    }

    const un = flow.unowned;
    if (un?.ok && un.data?.total > 0) {
      findings.push({
        severity: 'warn',
        kind: 'unowned',
        title: `${un.data.total} open tickets have no assignee`,
        detail: `${un.data.byTier.slice(0, 3).map(t => `${t.tier} ${t.count} (oldest ${t.oldest_days}d)`).join('; ')}. "Single named case owner for every multi-team ticket" is the review's top recommendation; this is the number that says whether it landed.`,
        items: un.data.byTier,
      });
    }

    const st = flow.stalled;
    if (st?.ok && st.data?.total > 0) {
      findings.push({
        severity: 'warn',
        kind: 'stalled',
        title: `${st.data.total} open tickets untouched for ${st.data.staleDays}+ days`,
        detail: `Worst: ${(st.data.worst || []).slice(0, 3).map(t => `${t.issue_key} (${t.days_untouched}d, ${t.tier})`).join('; ')}. Untouched is measured from last update, not creation — an old ticket being worked is a hard problem, an old ticket nobody has touched is a forgotten one.`,
        items: st.data.worst,
      });
    }

    // A sub-signal that failed is reported the same way a whole source is: as an
    // absence. Otherwise "no handbacks flagged" is indistinguishable from "the
    // handback query threw".
    for (const u of flow.unavailable || []) {
      findings.push({
        severity: 'blocked',
        kind: 'flow-signal-unavailable',
        title: `Flow signal \`${u.name}\` unavailable`,
        detail: `${u.error}. That section is absent, not zero.`,
      });
    }
  }

  // Nick's own task position. A finding only when the overdue share is large
  // enough to be the story — a couple of overdue items in a hundred is noise,
  // and a report that flags it every week trains him to skip the section.
  const tasks = snap?.tasks || null;
  if (tasks?.available && tasks.open > 0 && tasks.overdue / tasks.open > 0.25) {
    findings.push({
      severity: 'warn',
      kind: 'task-backlog',
      title: `${tasks.overdue} of ${tasks.open} open tasks are overdue`,
      detail: `${Math.round((tasks.overdue / tasks.open) * 100)}% of the open list is past its due date. ${tasks.closedLastWeek} closed last week${tasks.droppedLastWeek ? `, ${tasks.droppedLastWeek} dropped` : ''}.`,
    });
  }

  // Management log — competency 3/4 carried onto the same page, because the two
  // documents are assessed together and a clean risk report next to an unlogged
  // conversation is not a good week.
  const mgmt = snap?.management;
  if (mgmt) {
    if (mgmt.overdueCount > 0) {
      findings.push({
        severity: mgmt.breachesFiveDay?.length ? 'escalate' : 'warn',
        kind: 'management-overdue',
        title: `${mgmt.overdueCount} overdue management action${mgmt.overdueCount === 1 ? '' : 's'}`,
        detail: mgmt.breachesFiveDay?.length
          ? `${mgmt.breachesFiveDay.length} past the five-working-day standard. Baseline was ${mgmt.baseline.count} at ${formatUk(mgmt.baseline.date)}, target zero by ${formatUk(mgmt.baseline.targetDate)}.`
          : `None yet past the five-working-day standard. Baseline ${mgmt.baseline.count} at ${formatUk(mgmt.baseline.date)}.`,
      });
    }
    if (mgmt.lateLogged?.length) {
      findings.push({
        severity: 'warn',
        kind: 'log-latency',
        title: `${mgmt.lateLogged.length} item${mgmt.lateLogged.length === 1 ? '' : 's'} logged later than two working days`,
        detail: mgmt.lateLogged.slice(0, 3).map(l => `"${l.summary}" (${l.workingDays} working days)`).join('; '),
      });
    }
    // Only a CONFIRMED gap. `hrUnknown` is deliberately not a finding: nothing
    // measured it, and an unmeasured accusation in the report is worse than a
    // silent one, because the person reading it is the one who spot-checks
    // People HR. It surfaces in the panel as a question for Nick instead.
    if (mgmt.hrGap?.length) {
      findings.push({
        severity: 'warn',
        kind: 'people-hr-gap',
        title: `${mgmt.hrGap.length} conversation/concern confirmed NOT logged in People HR`,
        detail: 'Chris spot-checks People HR. NEURO holding the record is not the same as People HR holding it.',
      });
    }
  }

  const order = { blocked: 0, escalate: 1, warn: 2, info: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  // Balance. Not decoration — a report that only ever lists failures gets read
  // as noise by week three, and the green KPIs are evidence of oversight too.
  // Green is necessary but not sufficient. A "higher is better" KPI sitting at
  // ZERO is green only because the target fallback left its target at 0, and
  // "FRT Met (Tier 3) 0" listed under Positives is the opposite of the fact —
  // nothing was met. A zero on a "lower is better" KPI is a real win (no
  // breaches) and stays.
  const positives = rows
    .filter(r => ragBucket(r.RAG) === 'green')
    .map(r => ({
      kpi: r.KPI,
      value: num(r.Count),
      target: num(r.KPITarget),
      lowerIsBetter: /lower is better/i.test(r.KPIDirection || ''),
    }))
    .filter(p => p.value !== 0 || p.lowerIsBetter)
    // A real number beats a zero-against-zero. CSAT 100% and Escalation
    // Accuracy 99% are the balance this section exists to give; eight rows of
    // "0 (target 0)" are what pushed them off the list.
    .sort((a, b) => (b.value || 0) - (a.value || 0));

  return {
    week: snap.week,
    generatedAt: snap.generatedAt,
    snapshotDate: snap?.kpi?.date || null,
    snapshotAgeDays: ageDays,
    rag,
    trend,
    ageing,
    reasons,
    flow,
    positives,
    findings,
    escalateCount: findings.filter(f => f.severity === 'escalate').length,
    management: mgmt || null,
    tasks,
    jiraEscalations: snap.jiraEscalations,
    sources: snap.sources,
    manual: snap.manual,
    blockers: manualBlockers(snap.manual || emptyManual()),
  };
}

// ── Render ───────────────────────────────────────────────────────────────────

function bullet(items, fn) {
  return (items || []).map(fn).join('\n');
}

function complianceTable(trend) {
  const rows = trend.filter(t => isComplianceKpi(t.kpi));
  if (!rows.length) return '_No compliance KPIs in the trend window._';
  const header = '| KPI | This week | Last week | Δ | vs 95% |\n|---|---|---|---|---|';
  const body = rows.map(t => {
    const now = t.latest?.value;
    const was = t.prior?.value;
    const d = t.delta;
    const arrow = d === null ? '—' : d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : '– 0';
    const rag = now === null || now === undefined ? '—' : now >= COMPLIANCE_TARGET ? '🟢' : now >= COMPLIANCE_TARGET - 20 ? '🟠' : '🔴';
    return `| ${t.kpi} | ${now === null || now === undefined ? '—' : Math.round(now)}% | ${was === null || was === undefined ? '—' : Math.round(was)}% | ${arrow} | ${rag} |`;
  }).join('\n');
  return `${header}\n${body}`;
}

/**
 * The ticket-flow section.
 *
 * Every sub-signal renders its own absence. `flow` arriving as null means the
 * whole call failed; a sub-signal with `ok: false` means that one query failed
 * while the rest answered. Both say so. The failure this guards against is the
 * specific one that makes a compliance report dangerous: a section that quietly
 * renders as "nothing to report" when it means "nothing was measured".
 */
function flowSection(flow) {
  if (!flow) return '_Flow signals unavailable — NOVA did not answer. These figures are absent, not zero._';

  const out = [];
  const say = (label, sig, fn) => {
    if (!sig) { out.push(`**${label}:** _not returned by NOVA._`); return; }
    if (!sig.ok) { out.push(`**${label}:** _unavailable — ${sig.error}. Absent, not zero._`); return; }
    out.push(fn(sig.data));
  };

  say('Handbacks', flow.handbacks, d => {
    const dir = d.changePct === null ? '' : d.changePct > 0 ? ` (▲ ${d.changePct}% vs previous period)` : ` (▼ ${d.changePct}% vs previous period)`;
    const routes = (d.routes || []).slice(0, 5)
      .map(r => `| ${r.from_tier} → ${r.to_tier} | ${r.count} |`).join('\n');
    return `**Handbacks:** **${d.total}** tickets returned between tiers${dir}.\n\n`
      + (routes ? `| Route | Count |\n|---|---|\n${routes}\n` : '_No handback routes recorded._\n');
  });

  say('Ping-pong', flow.pingPong, d => {
    const worst = (d.worst || []).slice(0, 5)
      .map(t => `| ${t.ticket_key} | ${t.moves} | ${t.returns} |`).join('\n');
    return `**Ping-pong:** **${d.ticketsAffected}** tickets crossed queues ${d.threshold}+ times.\n\n`
      + (worst ? `| Ticket | Queue moves | Returns |\n|---|---|---|\n${worst}\n` : '_None over threshold._\n');
  });

  say('SLA breaches by queue', flow.breachesByQueue, d => {
    const rows = (d.byTier || []).slice(0, 6)
      .map(t => `| ${t.tier} | ${t.breaches} | ${t.sharePct === null ? '—' : `${t.sharePct}%`} |`).join('\n');
    // The caveat is not decoration. The cache being behind makes every figure
    // above an undercount, and an undercount presented as a total is the same
    // failure as a failed query presented as a zero.
    const stale = d.coverage?.lastSync
      ? `\n_Ticket cache last synced ${String(d.coverage.lastSync).slice(0, 10)} (${d.coverage.cachedTickets} tickets). If the sync is behind, these are undercounts._`
      : '\n_Ticket cache freshness unknown — treat these as a floor, not a total._';
    return `**SLA breaches by queue at time of breach:** **${d.total}** in the window.\n\n`
      + (rows ? `| Queue | Breaches | Share |\n|---|---|---|\n${rows}\n${stale}` : '_No breaches recorded._');
  });

  say('Unowned', flow.unowned, d => {
    const rows = (d.byTier || []).slice(0, 5)
      .map(t => `| ${t.tier} | ${t.count} | ${t.oldest_days}d |`).join('\n');
    return `**Open tickets with no assignee:** **${d.total}**.\n\n`
      + (rows ? `| Queue | Unowned | Oldest |\n|---|---|---|\n${rows}\n` : '_None._\n');
  });

  say('Stalled', flow.stalled, d => {
    const rows = (d.worst || []).slice(0, 5)
      .map(t => `| ${t.issue_key} | ${t.tier} | ${t.assignee || '—'} | ${t.days_untouched}d |`).join('\n');
    return `**Open and untouched ${d.staleDays}+ days:** **${d.total}**.\n\n`
      + (rows ? `| Ticket | Queue | Owner | Untouched |\n|---|---|---|---|\n${rows}\n` : '_None._\n');
  });

  return out.join('\n');
}

/**
 * The note Chris reads. Structure follows the format agreed at the 12 Aug 1:1 —
 * weekly numbers, escalations, data sources — with the week-on-week trend he
 * asked for added as its own section rather than folded into the prose, because
 * a trend buried in a sentence is one nobody reads twice.
 */
function render(a) {
  const week = a.week;
  const failed = (a.sources || []).filter(s => !s.ok);
  const escalate = a.findings.filter(f => f.severity === 'escalate');
  const warn = a.findings.filter(f => f.severity === 'warn');
  const manual = a.manual || emptyManual();

  const lines = [];

  lines.push('---');
  lines.push('type: risk-summary');
  lines.push('owner: Nick Ward');
  lines.push('manager: Chris Middleton');
  lines.push('purpose: PIP competency 2 (proactive oversight) — standing 1:1 agenda item');
  lines.push(`week_commencing: ${week}`);
  lines.push(`data_source: NOVA jira_kpi_daily as at ${a.snapshotDate || 'unavailable'}`);
  lines.push('generated_by: NEURO weekly-risk');
  lines.push('tags: [HR, PIP, SLA, risk, weekly]');
  lines.push(`updated: ${todayLocal()}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Weekly Risk & Anomaly Summary — w/c ${formatUk(week)}`);
  lines.push('');
  lines.push(`> Standing agenda item per PIP competency 2 (proactive review of team activity + early escalation). Data: NOVA \`jira_kpi_daily\` as at **${a.snapshotDate ? formatUk(a.snapshotDate) : 'unavailable'}**${a.snapshotAgeDays > 0 ? ` (${a.snapshotAgeDays} day${a.snapshotAgeDays === 1 ? '' : 's'} old)` : ''}. Anomalies to escalate to Chris within 2 working days are flagged **⚠️ ESCALATE**. Generated by NEURO; manual sections marked. Linked from [[Nick Ward - PIP Reference & Progress]].`);
  lines.push('');

  if (failed.length) {
    lines.push('## ⚠️ Data not available this week');
    lines.push('');
    lines.push(bullet(failed, s => `- **${s.name}** — ${s.error}. Sections built on it are **absent, not zero**.`));
    lines.push('');
  }

  lines.push('## Headline');
  lines.push('');
  if (manual.headline) {
    lines.push(manual.headline);
  } else if (a.rag.rated) {
    const worst = escalate[0];
    lines.push(`**${a.rag.greenPct}%** of rated KPIs green (target 80%), **${a.rag.redPct}%** red (target ≤10%), across **${a.rag.rated}** rated KPIs${a.rag.unrated ? ` (${a.rag.unrated} unrated)` : ''}.${worst ? ` The material concern this week is **${worst.title}**.` : ''}${escalate.length > 1 ? ` ${escalate.length} items are flagged for escalation.` : ''}`);
  } else {
    lines.push('_No KPI data available this week — see above._');
  }
  lines.push('');

  lines.push('## 1. Week-on-week trend');
  lines.push('');
  lines.push('_Added at Chris\'s request, 12 Aug 2026 — a single week cannot distinguish "bad" from "getting worse"._');
  lines.push('');
  lines.push(complianceTable(a.trend));
  lines.push('');

  lines.push('## 2. SLA / SLO due-date handling');
  lines.push('');
  if (a.ageing.length) {
    lines.push('**Oldest actionable ticket vs target:**');
    lines.push('');
    lines.push('| Queue | Days | Target | Over by |\n|---|---|---|---|');
    lines.push(a.ageing.map(x => `| ${x.kpi} | ${x.value} | ${x.target} | ${x.ratio}× |`).join('\n'));
  } else {
    lines.push('_No ageing KPIs available._');
  }
  lines.push('');

  // Section 3 as of w/c 17 Aug 2026 — the sections below shifted down by one.
  // It leads rather than trails because the Support Review's single most
  // important recommendation is ticket ownership, and a section at the bottom of
  // a six-section report is one nobody reaches.
  lines.push('## 3. Ticket flow & ownership');
  lines.push('');
  lines.push(`_How tickets move, over the last ${FLOW_WINDOW_DAYS} days. Added w/c 17 Aug 2026 in response to the Support Review — these are the measures the review was written from._`);
  lines.push('');
  lines.push(flowSection(a.flow));
  lines.push('');

  lines.push('## 4. Overtime');
  lines.push('');
  if (manual.overtime.hours === null) {
    lines.push('> ⚠️ **NOT ENTERED.** NEURO has no overtime source — this must be stated, not assumed. An empty section here would read as nil.');
  } else {
    lines.push(`**${manual.overtime.hours} overtime hours** logged this cycle. Approvals outstanding against the five-step checklist (PIP competency 1): **${manual.overtime.approvalsOutstanding ?? 0}**.`);
    if (manual.overtime.note) { lines.push(''); lines.push(manual.overtime.note); }
  }
  lines.push('');

  lines.push('## 5. Reporting exceptions / data quality');
  lines.push('');
  if (a.reasons) {
    lines.push(`- **Escalation reason capture:** ${a.reasons.unknown} of ${a.reasons.total} escalations in 30 days logged as \`unknown\` (**${a.reasons.share}%**).${a.reasons.coded.length ? ` Correctly coded: ${a.reasons.coded.map(c => `\`${c.reason_code}\` ${c.count}`).join(', ')}.` : ''}`);
  }
  if (warn.length) {
    lines.push(bullet(warn, f => `- **${f.title}** — ${f.detail}`));
  }
  if (Array.isArray(manual.dataQuality) && manual.dataQuality.length) {
    lines.push(bullet(manual.dataQuality, x => `- ${x}`));
  } else if (manual.dataQuality === null) {
    lines.push('- > ⚠️ **Manual review not done.** NEURO flags candidates; whether each is real or a reporting artefact is a judgement.');
  }
  lines.push('');

  lines.push('## 6. My task position');
  lines.push('');
  if (a.tasks?.available) {
    const t = a.tasks;
    lines.push('| Measure | Count |');
    lines.push('|---|---|');
    lines.push([
      `| Open tasks | **${t.open}** |`,
      `| Overdue | **${t.overdue}**${t.open ? ` (${Math.round((t.overdue / t.open) * 100)}%)` : ''} |`,
      `| No due date | ${t.undated} |`,
      `| Closed w/c ${formatUk(t.lastWeek.from)} | **${t.closedLastWeek}** |`,
      t.droppedLastWeek ? `| Dropped w/c ${formatUk(t.lastWeek.from)} | ${t.droppedLastWeek} |` : null,
    ].filter(Boolean).join('\n'));
    lines.push('');
    lines.push(`_Closed counts the previous full week (${formatUk(t.lastWeek.from)} to ${formatUk(t.lastWeek.to)}), not a rolling seven days. Dropped is counted separately from done — both leave the list, only one is work finished._`);
  } else {
    lines.push('_Task counts unavailable._');
  }
  lines.push('');

  lines.push('## 7. Management actions & conversations');
  lines.push('');
  if (a.management) {
    const m = a.management;
    lines.push(`Open items **${m.totals.open}** · overdue **${m.overdueCount}** · past the five-working-day standard **${m.breachesFiveDay.length}**.`);
    lines.push('');
    lines.push(`**Competency 4 baseline (as at ${formatUk(m.baseline.date)}): ${m.baseline.count}** — of which **${m.baseline.stillOpen}** still open. Target 0 by ${formatUk(m.baseline.targetDate)}.`);
    if (m.overdue.length) {
      lines.push('');
      lines.push('| Item | Owner | Due | Working days over |\n|---|---|---|---|');
      lines.push(m.overdue.slice(0, 10).map(o => `| ${o.summary} | ${o.owner || '—'} | ${o.dueDate} | ${o.workingDaysOverdue} |`).join('\n'));
    }
  } else {
    lines.push('_Management log unavailable._');
  }
  lines.push('');

  if (a.positives.length) {
    lines.push('## Positives (for balance)');
    lines.push('');
    lines.push(bullet(a.positives.slice(0, 8), p => `- **${p.kpi}** ${p.value}${p.target !== null ? ` (target ${p.target})` : ''}`));
    lines.push('');
  }

  lines.push(`## To escalate to Chris (within 2 working days)`);
  lines.push('');
  if (manual.escalateToChris === null) {
    lines.push('> ⚠️ **NOT CONFIRMED.** NEURO proposes the following; an empty list must be a decision, not a silence.');
    lines.push('');
    lines.push(escalate.length
      ? escalate.map((f, i) => `${i + 1}. ${f.title} — ${f.detail}`).join('\n')
      : '_NEURO found nothing meeting the escalation bar this week._');
  } else if (manual.escalateToChris.length) {
    lines.push(manual.escalateToChris.map((x, i) => `${i + 1}. ${x}`).join('\n'));
  } else {
    lines.push('**Nothing to escalate this week** — reviewed and confirmed.');
  }
  lines.push('');

  lines.push('## Actions this week');
  lines.push('');
  const actions = Array.isArray(manual.actions) ? manual.actions : [];
  if (actions.length) {
    lines.push(actions.map(x => `- [${x.done ? 'x' : ' '}] ${x.text}${x.carriedFrom ? ` _(carried from w/c ${formatUk(x.carriedFrom)})_` : ''}`).join('\n'));
  } else {
    lines.push('_None recorded._');
  }
  lines.push('');

  lines.push('---');
  lines.push('');
  lines.push('## Data sources');
  lines.push('');
  lines.push(bullet(a.sources, s => `- \`${s.name}\` — ${s.ok ? '✅ answered' : `❌ ${s.error}`}`));
  lines.push(`- \`management_log\` — NEURO, ${a.management ? `${a.management.totals.rows} rows` : 'unavailable'}`);
  lines.push('');
  // A raw ISO timestamp is fine in a log and wrong in a document going to a
  // manager; it reads as something half-finished.
  const stamp = new Date(a.generatedAt).toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  lines.push(`_Generated by NEURO, ${stamp}. Rendered from live data — edit the source, not this note._`);
  lines.push('');

  return lines.join('\n');
}

// ── Email rendering ──────────────────────────────────────────────────────────

/**
 * The report as HTML, for email.
 *
 * Converts the markdown `render()` already produces rather than being a second
 * renderer. That matters more than the few lines it costs: two renderers of the
 * same report drift, and the one Chris reads would be the one nobody checked.
 *
 * It is a small converter for a subset I control, not a general markdown
 * parser — headings, tables, blockquote, lists, checkboxes, rules and inline
 * emphasis is the whole vocabulary `render()` emits.
 *
 * Every style is INLINE. Outlook strips <style> blocks, which is exactly how a
 * table ends up rendering as pipe soup.
 */

const TD = 'padding:6px 10px;border:1px solid #dfe3e8;font-size:13px;vertical-align:top';
const TH = `${TD};background:#f4f6f8;font-weight:600;text-align:left`;

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Inline emphasis. Runs AFTER escaping, so the markers cannot inject markup.
 *
 * Both italic forms are handled. `render()` emits the UNDERSCORE form for its
 * asides — `_None recorded._`, `_Added at Chris's request_` — and handling only
 * `*this*` left stray underscores down the whole document.
 *
 * The underscore rule is boundary-anchored on purpose: `jira_kpi_daily`,
 * `management_log` and `kpi-snapshot` all appear in this report, and a naive
 * `_..._` would italicise the middle of every identifier in it.
 */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code style="background:#f4f6f8;padding:1px 4px;border-radius:3px;font-size:12px">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    // Opens at a start/space/bracket, closes before a space or punctuation —
    // so an underscore with a word character on both sides is never a marker.
    .replace(/(^|[\s(\[])_([^_\n]+?)_(?=$|[\s.,;:)\]!?])/g, '$1<em>$2</em>')
    .replace(/\[\[([^\]]+)\]\]/g, '<em>$1</em>');   // vault links mean nothing in a mail client
}

function splitRow(line) {
  return line.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
}

function markdownToEmailHtml(md) {
  // Frontmatter is vault metadata. It is the first thing in the note and the
  // first thing in the mail, and it means nothing to a reader in Outlook.
  const body = String(md).replace(/^---\n[\s\S]*?\n---\n/, '');
  const lines = body.split('\n');
  const out = [];
  let list = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    // Table: a pipe row followed by a separator row.
    if (line.startsWith('|') && /^\|[\s\-:|]+\|$/.test(lines[i + 1] || '')) {
      closeList();
      const head = splitRow(line);
      i += 1;
      const rows = [];
      while (i + 1 < lines.length && lines[i + 1].startsWith('|')) {
        i += 1;
        rows.push(splitRow(lines[i]));
      }
      out.push(
        `<table style="border-collapse:collapse;width:100%;margin:10px 0">`
        + `<thead><tr>${head.map(h => `<th style="${TH}">${inline(h)}</th>`).join('')}</tr></thead>`
        + `<tbody>${rows.map(r => `<tr>${r.map(c => `<td style="${TD}">${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody>`
        + `</table>`,
      );
      continue;
    }

    if (/^#{1,4}\s/.test(line)) {
      closeList();
      const level = line.match(/^#+/)[0].length;
      const text = inline(line.replace(/^#+\s*/, ''));
      const size = { 1: 20, 2: 16, 3: 14, 4: 13 }[level] || 13;
      const top = level === 1 ? 0 : 22;
      out.push(`<h${level} style="font-size:${size}px;margin:${top}px 0 8px;color:#1b1f23">${text}</h${level}>`);
      continue;
    }

    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push('<hr style="border:none;border-top:1px solid #e1e4e8;margin:22px 0">');
      continue;
    }

    if (line.startsWith('> ')) {
      closeList();
      out.push(`<blockquote style="margin:10px 0;padding:10px 14px;background:#f6f8fa;border-left:3px solid #d0d7de;font-size:13px;color:#444">${inline(line.slice(2))}</blockquote>`);
      continue;
    }

    const check = line.match(/^- \[([ x])\]\s*(.*)$/);
    if (check) {
      if (list !== 'ul') { closeList(); out.push('<ul style="margin:8px 0;padding-left:20px">'); list = 'ul'; }
      out.push(`<li style="font-size:13px;margin:3px 0">${check[1] === 'x' ? '&#9745;' : '&#9744;'} ${inline(check[2])}</li>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      if (list !== 'ul') { closeList(); out.push('<ul style="margin:8px 0;padding-left:20px">'); list = 'ul'; }
      out.push(`<li style="font-size:13px;margin:3px 0">${inline(line.replace(/^[-*]\s+/, ''))}</li>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      if (list !== 'ol') { closeList(); out.push('<ol style="margin:8px 0;padding-left:22px">'); list = 'ol'; }
      out.push(`<li style="font-size:13px;margin:3px 0">${inline(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }

    if (!line.trim()) { closeList(); continue; }

    closeList();
    out.push(`<p style="font-size:13px;line-height:1.6;margin:8px 0;color:#24292f">${inline(line)}</p>`);
  }
  closeList();

  return out.join('\n');
}

/** Wrap the converted body in an email shell. `banner` is raw HTML or null. */
function toEmailHtml(md, banner = null) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#ffffff">
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:820px;margin:0 auto;padding:22px;color:#24292f">
${banner || ''}
${markdownToEmailHtml(md)}
</div></body></html>`;
}

// ── Build + publish ──────────────────────────────────────────────────────────

async function build(opts = {}) {
  const snap = await snapshot(opts);
  const assessed = assess(snap);
  return { ...assessed, markdown: render(assessed) };
}

/**
 * Write the note into the vault. Refuses while a manual section is unanswered —
 * the same shape as an action-presenter blocker: say why, rather than publish
 * something whose silence reads as a fact.
 */
async function publish({ week = weekCommencing(), force = false } = {}) {
  const report = await build({ week });
  if (report.blockers.length && !force) {
    return { ok: false, blockers: report.blockers, report };
  }
  const vault = process.env.OBSIDIAN_VAULT_PATH || '';
  if (!vault) return { ok: false, blockers: ['OBSIDIAN_VAULT_PATH is not set — nowhere to publish.'], report };

  // One note per week, kept beside the original rather than overwriting it. The
  // 11 Aug edition is the agreed format and the PIP's first piece of evidence;
  // a generator that overwrites its own template loses the thing it was
  // modelled on the first time it runs.
  const rel = path.join('Projects', 'PIP', 'Weekly Risk Summaries', `Weekly Risk & Anomaly Summary — w-c ${week}.md`);
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, report.markdown, 'utf-8');
  try { require('./vault-hooks').onVaultWrite(abs, 'weekly-risk'); } catch { /* indexing is not worth failing a publish for */ }

  db.setState(PUBLISH_KEY(week), JSON.stringify({ path: rel, publishedAt: new Date().toISOString() }));
  return { ok: true, path: rel, report };
}

/**
 * Queue the send to Chris. **This sends nothing.**
 *
 * Third gate on the same report, and each one refuses for a different reason.
 * `publish()` refuses while a manual section is unanswered — that is about the
 * report being finished. This refuses while it cannot say WHO it is going to —
 * that is about it leaving the building. The actual send happens only when Nick
 * approves the `send_weekly_risk_report` action, which is the same two-gate
 * shape as draft_reply → reply_email: the words and the recipient are settled
 * and shown, then a separate approval releases them.
 *
 * The recipient is resolved HERE and stored on the payload, not re-resolved at
 * approval time, so the card shows the exact address the send will use.
 * "Chris" resolves ambiguously in this vault — there are two of them in
 * `People/` and Chris Middleton carries no `email:` — so an unresolved address
 * is a blocker rather than a guess. A weekly PIP report delivered to the wrong
 * Chris is not a recoverable mistake.
 */
async function queueSend({ week = weekCommencing(), to = null, force = false } = {}) {
  const report = await build({ week });
  if (report.blockers.length && !force) {
    return { ok: false, blockers: report.blockers, report };
  }

  let recipient = null;
  if (to && to.email) {
    recipient = { name: to.name || null, email: to.email, source: 'manual' };
  } else {
    try {
      const resolved = await require('./contact-directory').resolveName('Chris Middleton');
      if (resolved?.status === 'resolved' && resolved.email) {
        recipient = { name: resolved.name || 'Chris Middleton', email: resolved.email, source: resolved.source || 'directory' };
      }
    } catch { /* an unreachable directory is an unresolved address, not a crash */ }
  }

  const blockers = [];
  if (!recipient) {
    blockers.push('No address for Chris Middleton — his People note carries no `email:` and "Chris" is ambiguous in this vault (Chris Middleton and Chris Smith). Set one, or pass an explicit address.');
  }
  if (blockers.length) return { ok: false, blockers, report };

  const subject = `Weekly Risk & Anomaly Summary — w/c ${formatUk(week)}`;

  // One pending send per week. Without this, every press of the button queued
  // another identical outbound email to Nick's manager — and the approval queue
  // shows them as separate cards, so approving "the send" twice sends the report
  // twice. Deduping on the WEEK rather than on the body is deliberate: a rebuilt
  // report has different numbers but is still the same send, and two cards
  // differing only in a percentage is worse than one.
  const existing = db.getPendingSaraActionsByType
    ? db.getPendingSaraActionsByType('send_weekly_risk_report', 50)
    : [];
  for (const action of existing || []) {
    // getPendingSaraActionsByType ALREADY parses payload into an object. The
    // first cut called JSON.parse on it again, threw, and a defensive
    // `catch { continue }` swallowed the throw — so the dedupe skipped every
    // row and silently never fired. Accept either shape; never swallow.
    const payload = typeof action.payload === 'string'
      ? JSON.parse(action.payload)
      : action.payload;
    if (payload?.week !== week) continue;
    // Refresh the words and the address so the card is not stale, then hand
    // back the SAME action rather than minting a second one.
    try {
      db.updateSaraActionPayload(action.id, {
        ...payload, to: [recipient], subject, body: report.markdown,
        escalateCount: report.escalateCount, snapshotDate: report.snapshotDate,
        vaultPath: publishedAt(week)?.path || null,
      });
    } catch { /* a refresh failure is not a reason to duplicate the send */ }
    return { ok: true, actionId: action.id, recipient, subject, report, alreadyQueued: true };
  }

  const id = require('./suggestion-engine').queueAction(
    'send_weekly_risk_report',
    {
      week,
      to: [recipient],
      subject,
      body: report.markdown,
      escalateCount: report.escalateCount,
      snapshotDate: report.snapshotDate,
      vaultPath: publishedAt(week)?.path || null,
    },
    `Weekly risk report for w/c ${week}, due to Chris by midday`,
  );

  return { ok: true, actionId: id, recipient, subject, report };
}

/**
 * Send Nick a copy of the report, to see how it lands in an inbox.
 *
 * **Takes no recipient.** The destination is `email-sender.OWN_ADDRESS`, a
 * constant, and there is no parameter that can change it — which is precisely
 * why this does not go through the approval gate. That gate exists because
 * `queueSend` can reach Nick's manager; a call that can only ever reach Nick
 * has nothing for it to protect, and making him approve his own test twice a
 * morning is friction that would just get bypassed.
 *
 * It deliberately IGNORES the blockers. The whole point is to look at an
 * unfinished report — but the mail says so, in a banner naming each unanswered
 * section, so a half-built copy sitting in the inbox can never be mistaken for
 * the one that went to Chris. The subject carries [TEST] for the same reason:
 * the failure worth designing against is forwarding the wrong one on.
 *
 * The body goes through the same `sendMail` path and the same plain-text
 * content type as the real send. A test rendered differently to the thing it is
 * testing is not a test.
 */
async function testSend({ week = weekCommencing() } = {}) {
  const report = await build({ week });
  const emailSender = require('./email-sender');

  const banner = `<div style="background:#fff4e5;border:1px solid #f0b429;border-radius:6px;padding:14px 16px;margin-bottom:20px">
<div style="font-weight:700;font-size:14px;color:#8a5a00">TEST COPY — this did not go to Chris</div>
<div style="font-size:13px;color:#6b4a00;margin-top:6px">Week commencing ${formatUk(week)}. Sent to you only, from the Weekly Risk panel.</div>
${report.blockers.length
    ? `<div style="font-size:13px;color:#8a1c1c;margin-top:10px"><strong>This report is not finished — ${report.blockers.length} section${report.blockers.length === 1 ? '' : 's'} unanswered:</strong><ul style="margin:6px 0 0;padding-left:20px">${report.blockers.map(b => `<li style="margin:3px 0">${esc(b)}</li>`).join('')}</ul></div>`
    : '<div style="font-size:13px;color:#1a7f37;margin-top:10px">All sections complete — this is exactly what Chris would receive.</div>'}
</div>`;

  const result = await emailSender.sendMail({
    to: [{ name: 'Nick Ward', email: emailSender.OWN_ADDRESS }],
    subject: `[TEST] Weekly Risk & Anomaly Summary — w/c ${formatUk(week)}`,
    body: toEmailHtml(report.markdown, banner),
    html: true,
  });

  if (!result.sent) {
    const reasons = {
      auth: 'Not signed in to Microsoft — reconnect 365.',
      scope: 'Mail.Send not granted — re-consent to Microsoft.',
      empty_body: 'The report body was empty.',
    };
    return { ok: false, error: reasons[result.reason] || `Send failed (${result.reason})` };
  }

  return {
    ok: true,
    to: emailSender.OWN_ADDRESS,
    unfinished: report.blockers.length,
  };
}

function publishedAt(week = weekCommencing()) {
  const raw = db.getState(PUBLISH_KEY(week));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = {
  snapshot, assess, render, build, publish, publishedAt, queueSend, testSend,
  getManual, setManual, manualBlockers, emptyManual, carryForward,
  weekCommencing, previousWeek, buildTrend, consecutiveBelowTarget, ragBucket,
  toEmailHtml, markdownToEmailHtml,
  COMPLIANCE_TARGET, SLIDE_WEEKS, UNKNOWN_REASON_ESCALATE_SHARE, SNAPSHOT_STALE_DAYS,
};
