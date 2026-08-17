'use strict';

/**
 * Pins the judgement, not the numbers.
 *
 * `assess()` decides what gets flagged to Chris and in what order, and the
 * failure modes worth guarding are the quiet ones: a source that did not answer
 * rendering as a healthy zero, a manual section left blank reading as "nil",
 * and a compliance slide that has already recovered still reading as ongoing.
 */

const test = require('node:test');
const assert = require('node:assert');

const weeklyRisk = require('./weekly-risk');

function kpiRow(KPI, Count, over = {}) {
  return { KPI, KPIGroup: 'Compliance', Count, KPITarget: 95, KPIDirection: 'higher is better', RAG: 'Red', ...over };
}

function baseSnapshot(over = {}) {
  return {
    week: '2026-08-17',
    generatedAt: '2026-08-17T07:30:00.000Z',
    sources: [
      { name: 'kpi-snapshot', ok: true, error: null },
      { name: 'kpi-trend', ok: true, error: null },
      { name: 'escalation-stats', ok: true, error: null },
    ],
    kpi: { date: '2026-08-17', ageDays: 0, rows: [] },
    trend: { weeks: 6, rows: [] },
    escalationStats: null,
    jiraEscalations: null,
    management: null,
    manual: weeklyRisk.emptyManual(),
    ...over,
  };
}

// ── The load-bearing honesty rules ───────────────────────────────────────────

test('a source that did not answer is reported, and ranked above every finding', () => {
  const snap = baseSnapshot({
    sources: [
      { name: 'kpi-snapshot', ok: false, error: 'NOVA bridge not configured' },
      { name: 'kpi-trend', ok: true, error: null },
      { name: 'escalation-stats', ok: true, error: null },
    ],
  });
  const a = weeklyRisk.assess(snap);
  assert.equal(a.findings[0].severity, 'blocked');
  assert.equal(a.findings[0].kind, 'source-unavailable');
  assert.match(a.findings[0].detail, /absent, not zero/);
});

test('no KPI data yields null percentages, never 0% — 0% green reads as a crisis', () => {
  const a = weeklyRisk.assess(baseSnapshot());
  assert.equal(a.rag.greenPct, null);
  assert.equal(a.rag.redPct, null);
  assert.equal(a.rag.rated, 0);
});

test('an unanswered manual section blocks publication and names what the silence would claim', () => {
  const a = weeklyRisk.assess(baseSnapshot());
  assert.equal(a.blockers.length, 3);
  assert.ok(a.blockers.some(b => /nil overtime/.test(b)));
  assert.ok(a.blockers.some(b => /nothing to escalate/.test(b)));
});

test('an answered-as-zero manual section does NOT block — nil is a claim once stated', () => {
  const manual = weeklyRisk.emptyManual();
  manual.overtime.hours = 0;
  manual.escalateToChris = [];
  manual.dataQuality = [];
  const a = weeklyRisk.assess(baseSnapshot({ manual }));
  assert.deepEqual(a.blockers, []);
});

// ── Trend and slides (Chris's 12 Aug ask) ────────────────────────────────────

test('a sustained slide escalates; a recovered one does not', () => {
  const falling = [88, 54, 45, 45, 24, 47].map((v, i) => ({ period: `2026-07-0${i + 1}`, value: v }));
  assert.equal(weeklyRisk.consecutiveBelowTarget(falling, 95), 6);

  const recovered = [40, 50, 60, 97].map((v, i) => ({ period: `2026-07-0${i + 1}`, value: v }));
  assert.equal(
    weeklyRisk.consecutiveBelowTarget(recovered, 95), 0,
    'counting from the latest week backwards is what stops a fixed problem reading as ongoing',
  );
});

test('week-on-week delta is computed per KPI from the trend rows', () => {
  const snap = baseSnapshot({
    trend: {
      rows: [
        { period: '2026-08-03', KPI: 'Resolution Compliance % (Tier 2)', avgValue: 24, samples: 5 },
        { period: '2026-08-10', KPI: 'Resolution Compliance % (Tier 2)', avgValue: 47, samples: 5 },
      ],
    },
  });
  const a = weeklyRisk.assess(snap);
  const t = a.trend.find(x => x.kpi.includes('Tier 2'));
  assert.equal(t.delta, 23);
  assert.equal(t.latest.value, 47);
  assert.equal(t.prior.value, 24);
});

test('a compliance KPI below target for 3+ consecutive weeks is an escalation', () => {
  const rows = [30, 40, 45].map((v, i) => ({
    period: `2026-08-0${i + 1}`, KPI: 'Resolution Compliance % (Tier 2)', avgValue: v, samples: 5,
  }));
  const a = weeklyRisk.assess(baseSnapshot({ trend: { rows } }));
  const f = a.findings.find(x => x.kind === 'compliance-slide');
  assert.ok(f, 'expected a compliance-slide finding');
  assert.equal(f.severity, 'escalate');
  assert.equal(f.weeks, 3);
});

// ── Anomaly rules ────────────────────────────────────────────────────────────

test('a broken reason-code vocabulary escalates on share, not on raw count', () => {
  const snap = baseSnapshot({
    escalationStats: {
      by_reason: [
        { reason_code: 'unknown', count: 1285 },
        { reason_code: 'nova_stranded', count: 52 },
      ],
    },
  });
  const a = weeklyRisk.assess(snap);
  const f = a.findings.find(x => x.kind === 'reason-capture-broken');
  assert.ok(f);
  assert.equal(f.severity, 'escalate');
  assert.equal(a.reasons.unknown, 1285);
  assert.equal(a.reasons.total, 1337);
  assert.equal(a.reasons.share, 96.1);
});

test('a mostly-coded vocabulary does not escalate', () => {
  const snap = baseSnapshot({
    escalationStats: { by_reason: [{ reason_code: 'unknown', count: 10 }, { reason_code: 'nova_stranded', count: 90 }] },
  });
  const a = weeklyRisk.assess(snap);
  assert.equal(a.findings.find(x => x.kind === 'reason-capture-broken'), undefined);
  assert.equal(a.reasons.share, 10);
});

test('a stale KPI snapshot escalates rather than being reported as today', () => {
  const a = weeklyRisk.assess(baseSnapshot({ kpi: { date: '2026-08-05', ageDays: 12, rows: [] } }));
  const f = a.findings.find(x => x.kind === 'stale-snapshot');
  assert.ok(f);
  assert.equal(f.severity, 'escalate');
  assert.match(f.detail, /not today/);
});

test('a zero against a live higher-is-better target is flagged as a possible stalled pipeline', () => {
  const snap = baseSnapshot({
    kpi: {
      date: '2026-08-17', ageDays: 0,
      rows: [
        kpiRow('AI Resolution Rate', 0, { KPITarget: 50 }),
        kpiRow('CSAT', 0, { KPITarget: 0, KPIDirection: 'higher is better' }),  // no real target — not a finding
      ],
    },
  });
  const a = weeklyRisk.assess(snap);
  const f = a.findings.find(x => x.kind === 'zero-against-target');
  assert.ok(f);
  assert.equal(f.items.length, 1, 'a zero target is not a target');
  assert.equal(f.items[0].kpi, 'AI Resolution Rate');
});

test('ageing is ranked by ratio to target, not by raw days', () => {
  const snap = baseSnapshot({
    kpi: {
      date: '2026-08-17', ageDays: 0,
      rows: [
        { KPI: 'Development oldest actionable', KPIGroup: 'Age', Count: 249, KPITarget: 31, RAG: 'Red' },
        { KPI: 'Tier 2 oldest actionable', KPIGroup: 'Age', Count: 162, KPITarget: 2, RAG: 'Red' },
      ],
    },
  });
  const a = weeklyRisk.assess(snap);
  assert.equal(a.ageing[0].kpi, 'Tier 2 oldest actionable', '81× beats 8× even though 162 < 249');
  assert.equal(a.ageing[0].ratio, 81);
});

// ── Ordering ─────────────────────────────────────────────────────────────────

test('findings rank blocked → escalate → warn', () => {
  const snap = baseSnapshot({
    sources: [{ name: 'kpi-trend', ok: false, error: 'down' }],
    kpi: { date: '2026-08-01', ageDays: 16, rows: [kpiRow('AI Resolution Rate', 0, { KPITarget: 50 })] },
  });
  const a = weeklyRisk.assess(snap);
  const severities = a.findings.map(f => f.severity);
  assert.deepEqual([...severities].sort((x, y) => severities.indexOf(x) - severities.indexOf(y)), severities);
  assert.equal(severities[0], 'blocked');
  assert.ok(severities.indexOf('escalate') < severities.indexOf('warn'));
});

// ── Dates ────────────────────────────────────────────────────────────────────

test('weekCommencing returns the Monday, and is local rather than UTC', () => {
  assert.equal(weeklyRisk.weekCommencing('2026-08-17'), '2026-08-17', 'Monday is its own week start');
  assert.equal(weeklyRisk.weekCommencing('2026-08-21'), '2026-08-17', 'Friday');
  assert.equal(weeklyRisk.weekCommencing('2026-08-23'), '2026-08-17', 'Sunday belongs to the week just ending');
  assert.equal(weeklyRisk.previousWeek('2026-08-17'), '2026-08-10');
});

// ── Rendering ────────────────────────────────────────────────────────────────

test('the rendered note marks unanswered sections rather than quietly omitting them', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot()));
  assert.match(md, /## 3\. Overtime/);
  assert.match(md, /NOT ENTERED/);
  assert.match(md, /NOT CONFIRMED/);
  assert.match(md, /week_commencing: 2026-08-17/);
  assert.match(md, /## Data sources/, 'the format agreed on 12 Aug includes data sources');
  assert.match(md, /## 1\. Week-on-week trend/, "Chris's 12 Aug ask is its own section, not a sentence");
});

test('a nil-overtime week renders the claim, not the warning', () => {
  const manual = weeklyRisk.emptyManual();
  manual.overtime.hours = 0;
  manual.overtime.approvalsOutstanding = 0;
  manual.escalateToChris = [];
  manual.dataQuality = [];
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ manual })));
  assert.match(md, /\*\*0 overtime hours\*\*/);
  assert.doesNotMatch(md, /NOT ENTERED/);
  assert.match(md, /Nothing to escalate this week/);
});

// ── The send gate ────────────────────────────────────────────────────────────

test('the send action is classified outbound and shows the report in full', () => {
  const { describe: present } = require('./action-presenter');
  const p = present({
    type: 'send_weekly_risk_report',
    payload: {
      week: '2026-08-17',
      to: [{ name: 'Chris Middleton', email: 'chrism@nurtur.tech' }],
      subject: 'Weekly Risk & Anomaly Summary — w/c 17 Aug 2026',
      body: '# The whole report\n\nEvery word of it.',
      escalateCount: 2,
      snapshotDate: '2026-08-17',
      vaultPath: 'Projects/PIP/Weekly Risk Summaries/x.md',
    },
  });
  assert.equal(p.kind, 'outbound');
  assert.deepEqual(p.blockers, []);
  assert.match(p.body, /Every word of it/, 'the body is verbatim, never a summary');
  assert.ok(p.fields.some(f => f.value === 'chrism@nurtur.tech'));
});

test('no recipient blocks the send rather than failing after approval', () => {
  const { describe: present } = require('./action-presenter');
  const p = present({
    type: 'send_weekly_risk_report',
    payload: { week: '2026-08-17', to: [], body: 'report' },
  });
  assert.equal(p.blockers.length, 1);
  assert.match(p.blockers[0], /nowhere to send/);
});

test('a clean week warns before approval — it reports an all-clear to Chris', () => {
  const { describe: present } = require('./action-presenter');
  const p = present({
    type: 'send_weekly_risk_report',
    payload: {
      week: '2026-08-17',
      to: [{ email: 'chrism@nurtur.tech' }],
      body: 'report', escalateCount: 0, vaultPath: 'x.md',
    },
  });
  assert.ok(p.warnings.some(w => /clean week/.test(w)));
});

// ── RAG mapping (measured against the live snapshot, 17 Aug 2026) ────────────

test('RAG is numeric in jira_kpi_daily — 1 green, 2 amber, 3 red', () => {
  assert.equal(weeklyRisk.ragBucket(1), 'green');
  assert.equal(weeklyRisk.ragBucket(2), 'amber');
  assert.equal(weeklyRisk.ragBucket(3), 'red');
  assert.equal(weeklyRisk.ragBucket('1'), 'green', 'JSON may hand it back as a string');
});

test('letter RAG still maps, so a column type change cannot break this silently', () => {
  assert.equal(weeklyRisk.ragBucket('Green'), 'green');
  assert.equal(weeklyRisk.ragBucket('RED'), 'red');
  assert.equal(weeklyRisk.ragBucket('Amber'), 'amber');
});

test('an absent RAG is unrated, and unrated is excluded from the percentages', () => {
  assert.equal(weeklyRisk.ragBucket(null), 'unrated');
  assert.equal(weeklyRisk.ragBucket(''), 'unrated');
  assert.equal(weeklyRisk.ragBucket(0), 'unrated');
  const a = weeklyRisk.assess(baseSnapshot({
    kpi: {
      date: '2026-08-17', ageDays: 0,
      rows: [
        { KPI: 'a', RAG: 1 }, { KPI: 'b', RAG: 1 }, { KPI: 'c', RAG: 3 }, { KPI: 'd', RAG: null },
      ],
    },
  }));
  assert.equal(a.rag.green, 2);
  assert.equal(a.rag.red, 1);
  assert.equal(a.rag.unrated, 1);
  assert.equal(a.rag.rated, 3);
  assert.equal(a.rag.greenPct, 67, 'percentages are of RATED rows, not of all rows');
});

test('the live 17 Aug shape produces a real headline, not a dash', () => {
  // 47 green / 1 amber / 63 red — the actual counts from the live snapshot.
  const rows = [
    ...Array.from({ length: 47 }, (_, i) => ({ KPI: `g${i}`, RAG: 1 })),
    { KPI: 'a0', RAG: 2 },
    ...Array.from({ length: 63 }, (_, i) => ({ KPI: `r${i}`, RAG: 3 })),
  ];
  const a = weeklyRisk.assess(baseSnapshot({ kpi: { date: '2026-08-17', ageDays: 0, rows } }));
  assert.equal(a.rag.rated, 111);
  assert.equal(a.rag.greenPct, 42);
  assert.equal(a.rag.redPct, 57);
});
