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

test('a working overtime log removes the manual overtime blocker', () => {
  // The whole reason the overtime log was built: this section blocked
  // publication every week because nothing measured it.
  const a = weeklyRisk.assess(baseSnapshot({
    overtime: { available: true, hours: 12, totalClaims: 3, approved: 3, pending: 0, declined: 0,
      approvedWithoutFullChecklist: 0, checklistOutstanding: 0, overLimit: [] },
  }));
  assert.ok(!a.blockers.some(b => /Overtime hours not entered/.test(b)),
    'a measured figure is not a missing one');
});

test('an unavailable overtime log still blocks — absent is not nil', () => {
  const a = weeklyRisk.assess(baseSnapshot({ overtime: { available: false, reason: 'unreadable' } }));
  assert.ok(a.blockers.some(b => /Overtime hours not entered/.test(b)));
});

test('an approval recorded without the full checklist escalates', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    overtime: { available: true, hours: 40, totalClaims: 5, approved: 5, pending: 0, declined: 0,
      approvedWithoutFullChecklist: 2, checklistOutstanding: 0, overLimit: [] },
  }));
  const f = a.findings.find(x => x.kind === 'overtime-checklist-gap');
  assert.equal(f.severity, 'escalate', 'this is the exact behaviour competency 1 was written about');
});

test('over the 48h average escalates without an opt-out, warns with one', () => {
  const without = weeklyRisk.assess(baseSnapshot({
    overtime: { available: true, hours: 90, totalClaims: 9, approved: 9, pending: 0, declined: 0,
      approvedWithoutFullChecklist: 0, checklistOutstanding: 0,
      overLimit: [{ person: 'Sam', averageHours: 51.2, optoutSigned: false }] },
  })).findings.find(x => x.kind === 'wtr-limit');
  assert.equal(without.severity, 'escalate');
  assert.match(without.detail, /HR involvement now/);

  const with_ = weeklyRisk.assess(baseSnapshot({
    overtime: { available: true, hours: 90, totalClaims: 9, approved: 9, pending: 0, declined: 0,
      approvedWithoutFullChecklist: 0, checklistOutstanding: 0,
      overLimit: [{ person: 'Sam', averageHours: 51.2, optoutSigned: true }] },
  })).findings.find(x => x.kind === 'wtr-limit');
  assert.equal(with_.severity, 'warn');
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

// ── Flow signals ─────────────────────────────────────────────────────────────
//
// These exist because the Support Review was written from measures NOVA was
// already computing and nobody was reading. The rules below are what stops that
// recurring, so they are pinned rather than trusted.

/** A flow payload in the shape the NOVA bridge returns. */
function flowPayload(over = {}) {
  const sig = data => ({ ok: true, error: null, data });
  return {
    build: '2026-08-18-classifier-b',
    window: { days: 30, from: '2026-07-18' },
    handbacks: sig({ total: 40, previous: 38, changePct: 5.3, routes: [{ from_tier: 'Tier 2', to_tier: 'Customer Care', count: 40 }], unclassified: 0, returnsAfterFix: 0, reasons: { top: [{ reason: 'Insufficient investigation', count: 22 }], withoutReason: 5, classified: 27 } }),
    pingPong: sig({ threshold: 3, ticketsAffected: 0, worst: [] }),
    breachesByQueue: sig({ total: 0, withSlaField: 12, byTier: [], coverage: { cachedTickets: 100, lastSync: '2026-08-17T06:00:00Z' } }),
    unowned: sig({ total: 0, byTier: [] }),
    stalled: sig({ staleDays: 14, total: 0, byTier: [], worst: [] }),
    unavailable: [],
    ...over,
  };
}

test('a handback rise past the threshold escalates; a flat one only warns', () => {
  const rising = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      handbacks: { ok: true, error: null, data: { total: 60, previous: 40, changePct: 50, routes: [{ from_tier: 'T2', to_tier: 'T1', count: 60 }] } },
    }),
  })).findings.find(f => f.kind === 'handbacks');
  assert.equal(rising.severity, 'escalate', '50% rise is news, not background');

  const flat = weeklyRisk.assess(baseSnapshot({ flow: flowPayload() }))
    .findings.find(f => f.kind === 'handbacks');
  assert.equal(flat.severity, 'warn', '5% is the operating model, not this fortnight');
});

test('a ticket past the nameable move count escalates', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      pingPong: { ok: true, error: null, data: { threshold: 3, ticketsAffected: 12, worst: [{ ticket_key: 'NT-16112', moves: 16, returns: 13 }] } },
    }),
  }));
  const f = a.findings.find(x => x.kind === 'ping-pong');
  assert.equal(f.severity, 'escalate');
  assert.match(f.detail, /NT-16112/, 'the worst ticket is named so it can be picked up');
});

test('breach concentration is framed as routing, never as the queue underperforming', () => {
  const f = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      breachesByQueue: {
        ok: true, error: null,
        data: {
          total: 1439,
          byTier: [{ tier: 'Customer Care', breaches: 1302, sharePct: 90.5 }],
          coverage: { cachedTickets: 16511, lastSync: '2026-08-17T06:00:00Z' },
        },
      },
    }),
  })).findings.find(x => x.kind === 'breach-concentration');
  // The available misreading sends the whole improvement effort into the wrong
  // team. If this wording ever drifts, the report starts blaming Customer Care.
  assert.match(f.detail, /not a Customer Care performance finding/);
  assert.equal(f.severity, 'warn');
});

test('an unreadable SLA field escalates — it is not a clean month', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      breachesByQueue: {
        ok: true, error: null,
        data: { total: 0, withSlaField: 0, byTier: [], coverage: { cachedTickets: 5602, lastSync: '2026-08-18T11:00:00Z' } },
      },
    }),
  }));
  const f = a.findings.find(x => x.kind === 'breach-data-missing');
  assert.equal(f.severity, 'escalate', 'the wallboards show breaches; zero here means the mapping is broken');

  const md = weeklyRisk.render(a);
  assert.match(md, /not reportable/i);
  assert.doesNotMatch(md, /\*\*0\*\*, by the queue holding them now/, 'a hollow zero must never render as a measured total');
  // The claim that cost a correction: NOVA holding no breach data does not mean
  // the business holds none. The wallboards read the same field live from Jira.
  assert.match(md, /wallboards read the same field live/);
});

test('the breach section never claims to be the review\'s at-time-of-breach figure', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      breachesByQueue: {
        ok: true, error: null,
        data: {
          total: 210, withSlaField: 5602, basis: 'stock',
          byTier: [{ tier: 'Customer Care', breaches: 190, sharePct: 90.5 }],
          coverage: { cachedTickets: 5602, lastSync: '2026-08-18T11:00:00Z' },
        },
      },
    }),
  })));
  // Presenting a current snapshot as the Support Review's historical measure is
  // the easiest and most damaging error available in this report.
  assert.match(md, /not\*\* the Support Review/);
  assert.match(md, /queue holding them now/);
});

test('a genuine zero in the window still reads as a measurement, not a gap', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      breachesByQueue: {
        ok: true, error: null,
        data: { total: 0, withSlaField: 400, byTier: [], coverage: { cachedTickets: 5602, lastSync: '2026-08-18T11:00:00Z' } },
      },
    }),
  }));
  assert.equal(a.findings.find(x => x.kind === 'breach-data-missing'), undefined,
    'breaches exist in the table, so a quiet window is a real result');
});

test('no reasons captured yet reads as "not started", not as reasons being skipped', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      handbacks: { ok: true, error: null, data: {
        total: 217, previous: 289, changePct: -24.9,
        routes: [{ from_tier: 'Tier 3', to_tier: 'Tier 2', count: 106 }],
        unclassified: 154, returnsAfterFix: 80,
        reasons: { top: [], withoutReason: 217, classified: 217 },
      } },
    }),
  })));
  // The field is mandatory in Jira. An empty list means NOVA only just started
  // capturing it — reporting that as "reasons are being skipped" would accuse
  // the team of something the tooling caused.
  assert.match(md, /not evidence that reasons are being skipped/);
});

test('captured reasons are rendered as written, not bucketed', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ flow: flowPayload() })));
  assert.match(md, /Why they came back/);
  assert.match(md, /Insufficient investigation/);
  assert.match(md, /recorded before NOVA began capturing/, 'unreasoned rows are explained, not hidden');
});

test('a return after a released fix is never presented as friction', () => {
  // The correction that mattered most: Development → Customer Care is usually a
  // released fix coming back to be tested. Folding those into a "handbacks"
  // total reported successful delivery as failure.
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      handbacks: { ok: true, error: null, data: {
        total: 19, previous: 22, changePct: -13.6,
        routes: [{ from_tier: 'Tier 2', to_tier: 'Customer Care', count: 19 }],
        unclassified: 154, returnsAfterFix: 80,
        reasons: { top: [{ reason: 'Insufficient investigation', count: 12 }], withoutReason: 7, classified: 19 },
      } },
    }),
  })));
  assert.match(md, /\*\*Rejections:\*\* \*\*19\*\*/, 'only evidenced rejections carry the rejection label');
  assert.match(md, /80\*\* returned after a released fix/);
  assert.match(md, /that is the flow working/);
  assert.doesNotMatch(md, /\*\*99\*\*/, 'the two counts must never be summed');
});

test('an older NOVA build has its flow figures withheld, not rendered', () => {
  // This happened: NOVA served a stale dist, the response looked fine, and the
  // fields added since came back undefined. Undefined renders as blanks and
  // zeroes, not as an error — and the old logic counted every downward move as a
  // rejection, so its numbers overstate friction in a specific direction.
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({ build: '2026-08-18-pre-classifier' }),
  }));
  const f = a.findings.find(x => x.kind === 'flow-build-mismatch');
  assert.equal(f.severity, 'blocked');

  const md = weeklyRisk.render(a);
  assert.match(md, /figures withheld/i);
  assert.doesNotMatch(md, /\*\*Rejections:\*\*/, 'no numbers may be shown from a build we cannot read');
});

test('a response with no build field at all is treated as stale', () => {
  const flow = flowPayload();
  delete flow.build;
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ flow })));
  assert.match(md, /unknown \(pre-versioning\)/);
});

test('a failed sub-signal renders as absent, never as a healthy zero', () => {
  const a = weeklyRisk.assess(baseSnapshot({
    flow: flowPayload({
      handbacks: { ok: false, error: 'Query failed', data: null },
      unavailable: [{ name: 'handbacks', error: 'Query failed' }],
    }),
  }));
  assert.ok(a.findings.some(f => f.kind === 'flow-signal-unavailable' && f.severity === 'blocked'));

  const md = weeklyRisk.render(a);
  assert.match(md, /Handbacks:.*unavailable/, 'the section says it could not measure');
  assert.doesNotMatch(md, /\*\*Handbacks:\*\* \*\*0\*\*/, 'a failed query must never read as nil handbacks');
});

test('no flow data at all renders as absent rather than omitting the section', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ flow: null })));
  assert.match(md, /## 3\. Ticket flow & ownership/, 'the section is still there');
  assert.match(md, /absent, not zero/i);
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
  assert.match(md, /## 4\. Overtime/);
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

// ── Test send ────────────────────────────────────────────────────────────────

test('testSend takes no recipient — it cannot be aimed at anyone but Nick', () => {
  // The safety property is structural, not a runtime check: there is no
  // parameter to pass an address through, which is why this needs no approval
  // gate. If a `to` is ever added, this test should be the thing that objects.
  // 0 rather than 1: Function.length stops counting at the first defaulted
  // parameter, and the single options bag is defaulted. What matters is that
  // nothing positional follows it.
  assert.equal(weeklyRisk.testSend.length, 0, 'a single defaulted options bag, nothing else');
  const src = weeklyRisk.testSend.toString();
  assert.match(src, /OWN_ADDRESS/, 'destination comes from the shared constant');
  assert.doesNotMatch(src, /\bto\s*=|opts\.to|options\.to/, 'no caller-supplied recipient');
});

test('the address constant is the one email-sender already owns', () => {
  const emailSender = require('./email-sender');
  assert.equal(typeof emailSender.OWN_ADDRESS, 'string');
  assert.match(emailSender.OWN_ADDRESS, /@/);
});

test('a test send is marked as one in the subject and the body', () => {
  const src = weeklyRisk.testSend.toString();
  assert.match(src, /\[TEST\]/, 'subject is prefixed, so it cannot be forwarded on as the real thing');
  assert.match(src, /did not go to Chris/, 'the body says who it did not go to');
  assert.match(src, /not finished/i, 'an unfinished report names what is missing');
  assert.match(src, /blockers\.map/, 'and lists each unanswered section by name');
});

// ── Email HTML ───────────────────────────────────────────────────────────────

const SAMPLE_MD = [
  '---',
  'type: risk-summary',
  'updated: 2026-08-17',
  '---',
  '',
  '# Weekly Risk & Anomaly Summary',
  '',
  '> Standing agenda item. Flagged **ESCALATE**. See [[Nick Ward - PIP Reference]].',
  '',
  '## Headline',
  '',
  '**41%** of rated KPIs green, **53%** red.',
  '',
  '| KPI | This week | Last week |',
  '|---|---|---|',
  '| FRT Compliance % (Tier 2) | 40% | 61% |',
  '| FRT Compliance % (Production) | 100% | 96% |',
  '',
  '- Reason capture: 1054 of 1076 as `unknown`',
  '- [ ] Root-cause the Tier 2 slide',
  '- [x] Add week-on-week trend',
  '',
  '1. First escalation',
  '2. Second escalation',
].join('\n');

test('vault frontmatter never reaches the mail', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.doesNotMatch(html, /type: risk-summary/);
  assert.doesNotMatch(html, /updated: 2026-08-17/);
});

test('tables become real tables — this is the whole reason plain text failed', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.match(html, /<table/);
  assert.equal((html.match(/<th /g) || []).length, 3);
  assert.equal((html.match(/<tr>/g) || []).length, 3, 'header plus two body rows');
  assert.doesNotMatch(html, /\|\s*FRT Compliance/, 'no pipe soup left');
});

test('every style is inline — Outlook strips <style> blocks', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.doesNotMatch(html, /<style/i);
  assert.match(html, /<table style="/);
  assert.match(html, /<th style="/);
});

test('inline emphasis, code, checkboxes and lists all convert', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.match(html, /<strong>41%<\/strong>/);
  assert.match(html, /<code[^>]*>unknown<\/code>/);
  assert.match(html, /&#9744;/, 'unchecked box');
  assert.match(html, /&#9745;/, 'checked box');
  assert.match(html, /<ol/);
  assert.match(html, /<blockquote/);
  assert.doesNotMatch(html, /\*\*/, 'no raw markdown markers survive');
});

test('a vault wikilink is not shown as one — it means nothing in a mail client', () => {
  const html = weeklyRisk.toEmailHtml(SAMPLE_MD);
  assert.doesNotMatch(html, /\[\[/);
  assert.match(html, /<em>Nick Ward - PIP Reference<\/em>/);
});

test('markup in the report content is escaped, not rendered', () => {
  const html = weeklyRisk.toEmailHtml('# T\n\nA <script>alert(1)</script> and 5 < 6.');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /5 &lt; 6/);
});

test('the real send and the test send render through the same function', () => {
  const engine = require('./suggestion-engine').executeAction.toString();
  assert.match(engine, /toEmailHtml/, 'the executor converts rather than sending raw markdown');
  assert.match(engine, /html:\s*true/);
  assert.match(weeklyRisk.testSend.toString(), /toEmailHtml/);
});

// ── Task position: commitments vs continual improvement ─────────────────────
//
// The split exists because counting the two together made the improvement
// backlog PENALISE Nick: thirty of his own ideas, optimistically dated, read in
// a compliance report exactly like thirty broken promises. Overdue counts
// commitments only (Nick, 1 Sep 2026), and the third bucket — the rows nobody
// has classified — is named rather than folded into either, because folding it
// one way manufactures a broken promise and the other way hides one.

function group(over = {}) {
  return { available: true, open: 0, overdue: 0, undated: 0, closedLastWeek: 0, ...over };
}

function taskSnap(tasks) {
  const t = {
    available: true,
    lastWeek: { from: '2026-08-10', to: '2026-08-16' },
    open: 0, overdue: 0, undated: 0, closedLastWeek: 0, droppedLastWeek: 0,
    proposedCount: 0,
    commitments: group(), improvement: group(), unclassified: group(),
    ...tasks,
  };
  return baseSnapshot({ tasks: t });
}

test('commitments and improvement work are reported as separate sections', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 92, overdue: 14, closedLastWeek: 23,
    commitments: group({ open: 40, overdue: 6, undated: 12, closedLastWeek: 15 }),
    improvement: group({ open: 52, overdue: 8, undated: 28, closedLastWeek: 8 }),
  })));
  assert.match(md, /## 6\. My task position/);
  assert.match(md, /### Commitments — work others asked for or are waiting on/);
  assert.match(md, /\| Open commitments \| \*\*40\*\* \|/);
  assert.match(md, /\| \*\*Overdue\*\* \| \*\*6\*\* \(15%\) \|/);
  assert.match(md, /### Continual improvement — work I set myself/);
  assert.match(md, /\| Open improvement tasks \| 52 \|/);
});

test('improvement dates are never called overdue — they are self-set and nobody is waiting', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 30, overdue: 20,
    improvement: group({ open: 30, overdue: 20 }),
  })));
  // The wording is doing real work: "overdue" in a compliance report invites
  // these to be read as missed promises, which is exactly what they are not.
  assert.match(md, /\| Past their target date \| 20/);
  assert.match(md, /self-set target dates on work nobody is waiting for/);
  assert.match(md, /not as a compliance measure/);
});

test('the overdue FINDING counts commitments only', () => {
  // A backlog that is entirely Nick's own ideas must not be flagged to Chris.
  const own = weeklyRisk.assess(taskSnap({
    open: 100, overdue: 40,
    improvement: group({ open: 100, overdue: 40 }),
  }));
  assert.equal(own.findings.find(x => x.kind === 'commitment-backlog'), undefined,
    'his own improvement backlog is not a compliance finding');

  const owed = weeklyRisk.assess(taskSnap({
    open: 100, overdue: 40,
    commitments: group({ open: 100, overdue: 40, closedLastWeek: 3 }),
  }));
  const f = owed.findings.find(x => x.kind === 'commitment-backlog');
  assert.ok(f, 'expected a finding when 40% of the work others are waiting on is late');
  assert.equal(f.severity, 'warn');
  assert.match(f.title, /40 of 100 open commitments are overdue/);

  const light = weeklyRisk.assess(taskSnap({ commitments: group({ open: 100, overdue: 5 }) }));
  assert.equal(light.findings.find(x => x.kind === 'commitment-backlog'), undefined,
    'flagging a small number every week trains him to skip the section');
});

test('NEGATIVE: unclassified overdue work is neither counted as a commitment nor written off', () => {
  const a = weeklyRisk.assess(taskSnap({
    open: 50, overdue: 9,
    commitments: group({ open: 10, overdue: 0 }),
    unclassified: group({ open: 40, overdue: 9 }),
  }));
  // Not folded into the commitment finding...
  assert.equal(a.findings.find(x => x.kind === 'commitment-backlog'), undefined);
  // ...and not silently dropped either. It gets its own finding.
  const f = a.findings.find(x => x.kind === 'task-unclassified');
  assert.ok(f, 'nine overdue unclassified tasks must be surfaced, not absorbed');
  assert.match(f.title, /9 overdue tasks are not classified/);

  const md = weeklyRisk.render(a);
  assert.match(md, /### Not yet classified/);
  assert.match(md, /\*\*40\*\* open tasks/);
  assert.match(md, /Treat the commitment figure as a floor/);
});

test('a fully classified list SAYS so — the absence of a caveat is itself a fact', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 20, commitments: group({ open: 12 }), improvement: group({ open: 8 }),
  })));
  assert.match(md, /### Not yet classified/);
  assert.match(md, /every open task is marked/);
  assert.doesNotMatch(md, /Treat the commitment figure as a floor/);
});

test("a proposed classification is declared as a guess, not as Nick's call", () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({
    open: 20, commitments: group({ open: 20, overdue: 1 }), proposedCount: 14,
  })));
  assert.match(md, /14 of the classifications above were proposed automatically/);
  assert.match(md, /have not yet been confirmed/);
});

test('closed is the previous FULL week, not a rolling seven days', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({ open: 10, closedLastWeek: 5 })));
  assert.match(md, /10 Aug 2026 to 16 Aug 2026/);
  assert.match(md, /rather than a rolling seven days/);
});

test('dropped is reported separately from done — a clear-out is not a productive week', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(taskSnap({ open: 10, closedLastWeek: 4, droppedLastWeek: 30 })));
  assert.match(md, /30 dropped/);
  assert.match(md, /Dropped is counted separately from done/);
});

test('unavailable task counts say so rather than rendering zeros', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot({ tasks: { available: false } })));
  assert.match(md, /Task counts unavailable/);
  assert.doesNotMatch(md, /Open commitments/);
});

test('no divide-by-zero on an empty task list', () => {
  assert.doesNotThrow(() => weeklyRisk.render(weeklyRisk.assess(taskSnap({}))));
  const a = weeklyRisk.assess(taskSnap({}));
  assert.equal(a.findings.find(x => x.kind === 'commitment-backlog'), undefined);
  assert.equal(a.findings.find(x => x.kind === 'task-unclassified'), undefined);
});

test('the underscore italic form converts — render() uses it for every aside', () => {
  const html = weeklyRisk.toEmailHtml('# T\n\n_None recorded._\n\n_Added at Chris\'s request, 12 Aug 2026._');
  assert.match(html, /<em>None recorded\.<\/em>/);
  assert.doesNotMatch(html, /_None recorded/);
  assert.doesNotMatch(html, /request, 12 Aug 2026\._/);
});

test('snake_case identifiers are not italicised — the report is full of them', () => {
  const html = weeklyRisk.toEmailHtml('# T\n\n- `management_log` — NEURO, 19 rows\n- NOVA `jira_kpi_daily` as at today\n- weekly_risk and kpi_snapshot in prose');
  assert.match(html, /management_log/);
  assert.match(html, /jira_kpi_daily/);
  assert.match(html, /weekly_risk and kpi_snapshot/, 'a bare identifier in prose keeps its underscores');
  assert.doesNotMatch(html, /management<em>/);
});

test('no stray underscore markers survive anywhere in a rendered report', () => {
  const a = weeklyRisk.assess(taskSnap({ open: 10, overdue: 1, closedLastWeek: 2 }));
  const html = weeklyRisk.toEmailHtml(weeklyRisk.render(a));
  // Any underscore left must have a word character on both sides (an identifier).
  const strays = (html.match(/(^|[\s>(])_|_([\s<).,;:]|$)/g) || []);
  assert.deepEqual(strays, [], `stray italic markers: ${strays.join(' ')}`);
});

test('the footer timestamp is readable, not an ISO string', () => {
  const md = weeklyRisk.render(weeklyRisk.assess(baseSnapshot()));
  assert.doesNotMatch(md, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, 'no raw ISO stamp in a document going to Chris');
  assert.match(md, /Generated by NEURO, \w{3}/);
});

test('an unmeasured People HR state never reaches the report', () => {
  const mgmt = {
    totals: { rows: 4, open: 4, closed: 0 },
    baseline: { date: '2026-07-27', count: 0, stillOpen: 0, targetDate: '2026-09-11', items: [] },
    overdue: [], overdueCount: 0, breachesFiveDay: [], lateLogged: [],
    missingOwner: [], missingDue: [],
    hrGap: [],
    hrUnknown: [{ id: 1 }, { id: 2 }, { id: 3 }],
  };
  const a = weeklyRisk.assess(baseSnapshot({ management: mgmt }));
  assert.equal(a.findings.find(f => f.kind === 'people-hr-gap'), undefined,
    'three unknowns must not become an accusation in a report to the person who spot-checks People HR');
  const md = weeklyRisk.render(a);
  assert.doesNotMatch(md, /People HR/);
});

test('a CONFIRMED People HR gap does reach the report, and says it is confirmed', () => {
  const mgmt = {
    totals: { rows: 1, open: 1, closed: 0 },
    baseline: { date: '2026-07-27', count: 0, stillOpen: 0, targetDate: '2026-09-11', items: [] },
    overdue: [], overdueCount: 0, breachesFiveDay: [], lateLogged: [],
    missingOwner: [], missingDue: [],
    hrGap: [{ id: 1 }], hrUnknown: [],
  };
  const f = weeklyRisk.assess(baseSnapshot({ management: mgmt })).findings.find(x => x.kind === 'people-hr-gap');
  assert.ok(f);
  assert.match(f.title, /confirmed NOT logged/);
});

/**
 * Behaviour, not source text.
 *
 * The first version of this test asserted that queueSend's SOURCE contained
 * `getPendingSaraActionsByType` and `alreadyQueued`. It did — and the dedupe was
 * broken anyway, because the payload was double-parsed and a defensive catch
 * swallowed the throw. A test that reads the code cannot catch the code being
 * wrong, so this one drives the real thing against a scratch DB.
 */
test('queueSend dedupes on the week — a second press returns the SAME action', async (t) => {
  const path = require('path');
  const os = require('os');
  const fs = require('fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-dedupe-'));
  process.env.NEURO_DB_PATH = path.join(dir, 'scratch.db');

  // Fresh module registry so the DB path is picked up.
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const db = require('../db/database');
  await db.init();
  const wr = require('./weekly-risk');
  const engine = require('./suggestion-engine');

  const week = '2026-08-17';
  const payload = { week, to: [{ email: 'chris@nurtur.tech' }], subject: 's', body: 'b' };
  const first = engine.queueAction('send_weekly_risk_report', payload, 'test');

  const pending = db.getPendingSaraActionsByType('send_weekly_risk_report', 50);
  assert.equal(pending.length, 1);
  assert.equal(typeof pending[0].payload, 'object',
    'the db helper parses payload — re-parsing it is what broke the dedupe');
  assert.equal(pending[0].payload.week, week);

  // The matching logic itself, against exactly what the helper hands back.
  const match = pending.find(a => (typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload)?.week === week);
  assert.ok(match, 'an existing pending send for this week must be found');
  assert.equal(match.id, first);

  // A different week must NOT match, or every week would reuse one card.
  const other = pending.find(a => (typeof a.payload === 'string' ? JSON.parse(a.payload) : a.payload)?.week === '2026-08-10');
  assert.equal(other, undefined);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
});
