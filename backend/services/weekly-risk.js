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

  const [kpi, trend, escalationStats] = novaReady
    ? await Promise.all([
      pull('kpi-snapshot', () => nova.call(`/api/neuro-bridge/kpi-snapshot${date ? `?date=${date}` : ''}`)),
      pull('kpi-trend', () => nova.call('/api/neuro-bridge/kpi-trend?weeks=6')),
      pull('escalation-stats', () => nova.call('/api/neuro-bridge/escalation-stats?days=30')),
    ])
    : [
      { name: 'kpi-snapshot', ok: false, error: 'NOVA bridge not configured', data: null },
      { name: 'kpi-trend', ok: false, error: 'NOVA bridge not configured', data: null },
      { name: 'escalation-stats', ok: false, error: 'NOVA bridge not configured', data: null },
    ];

  let jiraEscalations = null;
  try {
    jiraEscalations = require('./jira').getUnseenEscalations?.() ?? null;
  } catch { jiraEscalations = null; }

  return {
    week,
    generatedAt: new Date().toISOString(),
    today: todayLocal(),
    sources: [kpi, trend, escalationStats].map(s => ({ name: s.name, ok: s.ok, error: s.error || null })),
    kpi: kpi.data,
    trend: trend.data,
    escalationStats: escalationStats.data,
    jiraEscalations,
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
    if (mgmt.hrGap?.length) {
      findings.push({
        severity: 'warn',
        kind: 'people-hr-gap',
        title: `${mgmt.hrGap.length} conversation/concern not marked as logged in People HR`,
        detail: 'Chris spot-checks People HR. NEURO holding the record is not the same as People HR holding it.',
      });
    }
  }

  const order = { blocked: 0, escalate: 1, warn: 2, info: 3 };
  findings.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));

  // Balance. Not decoration — a report that only ever lists failures gets read
  // as noise by week three, and the green KPIs are evidence of oversight too.
  const positives = rows
    .filter(r => ragBucket(r.RAG) === 'green')
    .map(r => ({ kpi: r.KPI, value: num(r.Count), target: num(r.KPITarget) }));

  return {
    week: snap.week,
    generatedAt: snap.generatedAt,
    snapshotDate: snap?.kpi?.date || null,
    snapshotAgeDays: ageDays,
    rag,
    trend,
    ageing,
    reasons,
    positives,
    findings,
    escalateCount: findings.filter(f => f.severity === 'escalate').length,
    management: mgmt || null,
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

  lines.push('## 3. Overtime');
  lines.push('');
  if (manual.overtime.hours === null) {
    lines.push('> ⚠️ **NOT ENTERED.** NEURO has no overtime source — this must be stated, not assumed. An empty section here would read as nil.');
  } else {
    lines.push(`**${manual.overtime.hours} overtime hours** logged this cycle. Approvals outstanding against the five-step checklist (PIP competency 1): **${manual.overtime.approvalsOutstanding ?? 0}**.`);
    if (manual.overtime.note) { lines.push(''); lines.push(manual.overtime.note); }
  }
  lines.push('');

  lines.push('## 4. Reporting exceptions / data quality');
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

  lines.push('## 5. Management actions & conversations');
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
  lines.push(`_Generated by NEURO at ${a.generatedAt}. Rendered from live data — edit the source, not this note._`);
  lines.push('');

  return lines.join('\n');
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

function publishedAt(week = weekCommencing()) {
  const raw = db.getState(PUBLISH_KEY(week));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = {
  snapshot, assess, render, build, publish, publishedAt, queueSend,
  getManual, setManual, manualBlockers, emptyManual, carryForward,
  weekCommencing, previousWeek, buildTrend, consecutiveBelowTarget, ragBucket,
  COMPLIANCE_TARGET, SLIDE_WEEKS, UNKNOWN_REASON_ESCALATE_SHARE, SNAPSHOT_STALE_DAYS,
};
