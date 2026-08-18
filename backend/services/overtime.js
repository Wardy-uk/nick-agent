'use strict';

/**
 * Overtime approvals — PIP competency 1.
 *
 * The finding: overtime was approved on headline productivity indicators —
 * ticket counts, activity status — without cross-checking against logged work in
 * Jira/NOVA, and Working Time Regulation limits were not considered at the point
 * of approval.
 *
 * The plan's remedy is specific: from 27 Jul 2026, 100% of approvals follow the
 * five-step checklist in Section 8 of the WTR briefing, each check recorded in
 * the overtime approval log, with the line manager auditing a sample at the
 * 30/60/90-day checkpoints. Success is measured as "all sampled approvals
 * evidence completion of the five-step checklist with no WTR breach".
 *
 * That last sentence is the whole design brief. The evidence has to be a
 * BY-PRODUCT of approving, not a thing to be written up afterwards — because a
 * record kept separately from the decision is the one that stops being kept.
 * So `approve()` refuses while any step is unanswered, in the same shape as
 * weekly-risk's publication blockers: say what is missing, rather than record an
 * approval whose silence reads as a completed check.
 *
 * Split like management-log and weekly-risk: reads and writes here, `assess()`
 * pure so the WTR arithmetic — which is the part that must not be wrong — is
 * pinned in tests with no database and no clock.
 *
 * ⚠️ This computes the 48-hour average and flags where an opt-out is required.
 * It is not legal advice and it does not decide anything. A red flag here means
 * "do not approve this until HR has confirmed", and the service enforces exactly
 * that by refusing to record an approval over a breach without an explicit
 * override that is itself recorded.
 */

const db = require('../db/database');

/** WTR: average weekly working time must not exceed this without a signed opt-out. */
const WTR_WEEKLY_LIMIT = 48;
/** WTR: the averaging period, in weeks. */
const WTR_REFERENCE_WEEKS = 17;
/** WTR: minimum uninterrupted rest in any 24 hours, in hours. */
const WTR_DAILY_REST_HOURS = 11;
/** Assumed contracted week when no working_time_profile row exists. */
const DEFAULT_CONTRACTED_HOURS = 37.5;

/** The five steps, in the order Section 8 lists them. */
const STEPS = [
  { key: 'chk_activity', label: 'Verified against Jira/NOVA systems activity' },
  { key: 'chk_48h', label: 'Cumulative hours checked against the 48-hour rolling 17-week average' },
  { key: 'chk_optout', label: 'Valid signed opt-out confirmed where the average would be exceeded' },
  { key: 'chk_rest', label: 'Rest entitlements checked' },
  { key: 'chk_recorded', label: 'Check recorded' },
];

function todayLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function nowIso() {
  return new Date().toISOString();
}

/** Parse YYYY-MM-DD as LOCAL. `new Date('2026-08-14')` is UTC midnight. */
function parseLocal(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

// ── Working time profile ─────────────────────────────────────────────────────

function getProfile(person) {
  try {
    return db.get('SELECT * FROM working_time_profile WHERE person = ?', [person]) || null;
  } catch { return null; }
}

function setProfile(person, { contractedHours, optoutSigned, optoutDate, notes } = {}) {
  const existing = getProfile(person);
  const hours = contractedHours ?? existing?.contracted_hours ?? DEFAULT_CONTRACTED_HOURS;
  db.run(
    `INSERT INTO working_time_profile (person, contracted_hours, optout_signed, optout_date, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(person) DO UPDATE SET
       contracted_hours = excluded.contracted_hours,
       optout_signed    = excluded.optout_signed,
       optout_date      = excluded.optout_date,
       notes            = excluded.notes,
       updated_at       = excluded.updated_at`,
    [
      person, hours,
      optoutSigned === undefined ? (existing?.optout_signed ?? null) : optoutSigned,
      optoutDate ?? existing?.optout_date ?? null,
      notes ?? existing?.notes ?? null,
      nowIso(),
    ],
  );
  return getProfile(person);
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * The read that THROWS. Used by anything whose answer is a compliance claim.
 *
 * Caught during the first deploy: `status()` reported `available: true,
 * totalClaims: 0` against a database that was not even initialised, because the
 * swallowing `list()` handed it an empty array. That would have put "0 overtime
 * hours, no checklist gaps" into the weekly report on the strength of a dead
 * database, AND cleared the publication blocker while doing it — a false
 * all-clear on a PIP competency, which is the precise failure this codebase is
 * built to refuse.
 *
 * So there are two reads. This one is the truth; `list()` is the convenience.
 */
function listOrThrow({ person, from, to, outcome, limit = 500 } = {}) {
  const where = [];
  const params = [];
  if (person) { where.push('person = ?'); params.push(person); }
  if (from) { where.push('work_date >= ?'); params.push(from); }
  if (to) { where.push('work_date <= ?'); params.push(to); }
  if (outcome) { where.push('outcome = ?'); params.push(outcome); }
  const sql = `SELECT * FROM overtime_approvals
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY work_date DESC, id DESC
               LIMIT ?`;
  return db.all(sql, [...params, Math.min(Math.max(limit, 1), 2000)]) || [];
}

/** Degrading read, for callers where an empty list and a failure are the same. */
function list(opts = {}) {
  try { return listOrThrow(opts); } catch { return []; }
}

function get(id) {
  try { return db.get('SELECT * FROM overtime_approvals WHERE id = ?', [id]); } catch { return null; }
}

// ── The WTR arithmetic ───────────────────────────────────────────────────────

/**
 * Average weekly hours across the 17-week reference period ending on `asOf`.
 *
 * PURE. Takes the rows rather than reading them, so the arithmetic can be pinned
 * without a database — this is the number an approval is justified against, and
 * it is the one that must not be quietly wrong.
 *
 * Contracted hours are counted for every week in the period, with recorded
 * overtime added on top. That is the conservative reading and the right one: the
 * 48-hour limit is on TOTAL working time, not on overtime, and averaging only
 * the overtime would produce a comfortable number that means nothing.
 *
 * Returns `null` for the average when there is no contracted figure to build on,
 * rather than assuming one. A fabricated baseline is worse than an absent one
 * here, because the whole finding was about approving on assumptions.
 */
function rollingAverage(entries, contractedHours, asOf = todayLocal()) {
  const end = parseLocal(asOf);
  if (!end) return { averageHours: null, overtimeHours: 0, weeks: WTR_REFERENCE_WEEKS, reason: 'invalid date' };
  if (contractedHours === null || contractedHours === undefined) {
    return {
      averageHours: null, overtimeHours: 0, weeks: WTR_REFERENCE_WEEKS,
      reason: 'no contracted hours on file — the average cannot be computed without a baseline',
    };
  }

  const start = addDays(end, -(WTR_REFERENCE_WEEKS * 7) + 1);
  const startStr = todayLocal(start);

  const overtimeHours = (entries || [])
    .filter(e => {
      const d = String(e.work_date || '').slice(0, 10);
      return d >= startStr && d <= asOf;
    })
    // Declined overtime was never worked, so it does not count toward the limit.
    // Pending does — the hours were worked whether or not the paperwork caught
    // up, and a limit that only counts approved time is one you can breach by
    // being slow at admin.
    .filter(e => e.outcome !== 'declined')
    .reduce((sum, e) => sum + (Number(e.hours) || 0), 0);

  const totalHours = contractedHours * WTR_REFERENCE_WEEKS + overtimeHours;
  return {
    averageHours: Math.round((totalHours / WTR_REFERENCE_WEEKS) * 100) / 100,
    overtimeHours: Math.round(overtimeHours * 100) / 100,
    weeks: WTR_REFERENCE_WEEKS,
    from: startStr,
    to: asOf,
    reason: null,
  };
}

/**
 * Judge one claim against the regulations. PURE.
 *
 * Returns the flags an approver needs BEFORE deciding, which is the point — the
 * finding was that limits were not considered at the point of approval, so the
 * answer has to be available at that moment rather than reconstructable later.
 */
function assess({ claim, entries, profile, activity, asOf = todayLocal() }) {
  const contracted = profile?.contracted_hours ?? null;
  const avg = rollingAverage(
    [...(entries || []), claim].filter(Boolean),
    contracted,
    asOf,
  );

  const flags = [];
  const wouldExceed = avg.averageHours !== null && avg.averageHours > WTR_WEEKLY_LIMIT;
  const optoutSigned = profile?.optout_signed === 1;

  if (avg.averageHours === null) {
    flags.push({
      severity: 'blocked',
      code: 'no-baseline',
      message: `${avg.reason}. Set contracted hours for ${claim?.person || 'this person'} before approving.`,
    });
  } else if (wouldExceed && !optoutSigned) {
    flags.push({
      severity: 'breach',
      code: 'wtr-48h-no-optout',
      message: `Approving this takes the 17-week average to ${avg.averageHours}h, above the ${WTR_WEEKLY_LIMIT}h limit, and no signed opt-out is on file. Do not approve without HR.`,
    });
  } else if (wouldExceed && optoutSigned) {
    flags.push({
      severity: 'warn',
      code: 'wtr-48h-optout',
      message: `17-week average would be ${avg.averageHours}h, above ${WTR_WEEKLY_LIMIT}h. A signed opt-out is on file${profile.optout_date ? ` (${profile.optout_date})` : ''}, so this is permitted — record that it was relied on.`,
    });
  }

  if (profile?.optout_signed === null || profile?.optout_signed === undefined) {
    flags.push({
      severity: 'info',
      code: 'optout-unknown',
      message: 'No opt-out status recorded — that is "never asked", not "no opt-out". Step 3 cannot be answered honestly until it is established.',
    });
  }

  // Step 1's evidence. Absent activity is reported as absent; the whole finding
  // was approving on indicators without checking logged work, and a missing
  // check must not read as a passed one.
  if (!activity) {
    flags.push({
      severity: 'info',
      code: 'no-activity-evidence',
      message: 'No Jira/NOVA activity pulled for this date — step 1 must be evidenced manually, and what was checked recorded in the note.',
    });
  } else if (activity.ticketsTouched === 0 && activity.ticketsSolved === 0) {
    flags.push({
      severity: 'warn',
      code: 'no-logged-work',
      message: `NOVA shows no ticket activity for ${claim?.person} on ${claim?.work_date}. That does not mean no work happened — it means the claim needs a different evidence source before approval.`,
    });
  }

  return {
    rolling: avg,
    limit: WTR_WEEKLY_LIMIT,
    wouldExceed,
    optoutSigned,
    activity: activity || null,
    flags,
    // A breach or a missing baseline stops approval outright. Warnings do not —
    // they have to be acknowledged, which is what the checklist is for.
    blocking: flags.filter(f => f.severity === 'breach' || f.severity === 'blocked'),
  };
}

/** Which of the five steps are still unanswered on a stored row. */
function outstandingSteps(row) {
  return STEPS.filter(s => row?.[s.key] === null || row?.[s.key] === undefined);
}

// ── Writes ───────────────────────────────────────────────────────────────────

function record({ person, workDate, hours, reason, requestedAt, notes } = {}) {
  if (!person || !workDate || hours === undefined || hours === null) {
    throw new Error('person, workDate and hours are required');
  }
  const now = nowIso();
  const res = db.run(
    `INSERT INTO overtime_approvals
       (person, work_date, hours, reason, requested_at, logged_at, outcome, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    [person, workDate, Number(hours), reason || null, requestedAt || now, now, notes || null, now, now],
  );
  return get(res.lastInsertRowid);
}

/** Answer one of the five checks. `passed` is true/false — never implied. */
function check(id, step, passed, note) {
  const meta = STEPS.find(s => s.key === step);
  if (!meta) throw new Error(`Unknown step "${step}". Expected one of: ${STEPS.map(s => s.key).join(', ')}`);
  const params = [passed ? 1 : 0, nowIso()];
  let sql = `UPDATE overtime_approvals SET ${step} = ?, updated_at = ?`;
  if (step === 'chk_activity' && note !== undefined) {
    sql += ', chk_activity_note = ?';
    params.push(note);
  }
  sql += ' WHERE id = ?';
  params.push(id);
  db.run(sql, params);
  return get(id);
}

/**
 * Approve — but only with the whole checklist answered.
 *
 * Refuses, rather than recording a partial approval, for the same reason
 * weekly-risk refuses to publish with a manual section blank: the missing check
 * would otherwise be indistinguishable from a passed one in the record Chris
 * audits. Returns `{ ok: false, blockers }` so the caller can show what is
 * missing; it does not throw, because "not finished yet" is a normal state.
 *
 * A WTR breach cannot be approved without `override`, and the override reason is
 * stored on the row. That is deliberate friction: the plan's success measure is
 * "no WTR breach", so approving over one has to be a recorded, deliberate act
 * with a name against it.
 */
function approve(id, { approvedBy, override, overrideReason, asOf = todayLocal() } = {}) {
  const row = get(id);
  if (!row) return { ok: false, blockers: [`No overtime claim with id ${id}.`] };

  const blockers = [];
  const outstanding = outstandingSteps(row);
  for (const s of outstanding) {
    blockers.push(`Step not answered: ${s.label}. An unanswered check must not be recorded as a passed one.`);
  }

  const failed = STEPS.filter(s => row[s.key] === 0);
  const profile = getProfile(row.person);
  const others = list({ person: row.person }).filter(e => e.id !== row.id);
  const judged = assess({ claim: row, entries: others, profile, activity: null, asOf });

  if (judged.blocking.length && !override) {
    for (const f of judged.blocking) blockers.push(f.message);
  }
  if (failed.length && !override) {
    blockers.push(`${failed.length} check(s) recorded as FAILED: ${failed.map(f => f.label).join('; ')}. Approving over a failed check needs an explicit override with a reason.`);
  }
  if (override && !overrideReason) {
    blockers.push('An override must carry a reason — it is the thing the auditor will ask about.');
  }

  if (blockers.length) return { ok: false, blockers, assessment: judged };

  db.run(
    `UPDATE overtime_approvals
        SET outcome = 'approved', approved_by = ?, approved_at = ?,
            rolling_avg_hours = ?, notes = COALESCE(?, notes), updated_at = ?
      WHERE id = ?`,
    [
      approvedBy || 'Nick Ward',
      nowIso(),
      judged.rolling.averageHours,
      overrideReason ? `${row.notes ? `${row.notes}\n` : ''}OVERRIDE: ${overrideReason}` : null,
      nowIso(),
      id,
    ],
  );
  return { ok: true, row: get(id), assessment: judged };
}

function decline(id, reason) {
  if (!reason) throw new Error('A declined claim must carry a reason.');
  db.run(
    `UPDATE overtime_approvals SET outcome = 'declined', declined_reason = ?, updated_at = ? WHERE id = ?`,
    [reason, nowIso(), id],
  );
  return get(id);
}

// ── Compliance status, for the weekly report ─────────────────────────────────

/**
 * What the Weekly Risk & Anomaly Summary needs, computed rather than typed.
 *
 * Section 3 of that report currently BLOCKS publication until Nick types an
 * overtime figure, because nothing held one. This is that source. `available`
 * stays false when the table has never been used, so the report says "no
 * approvals recorded" rather than rendering a confident nil.
 */
function status({ from, to, asOf = todayLocal() } = {}) {
  let rows;
  try {
    // listOrThrow, deliberately. The degrading list() returns [] on failure,
    // which would make an unreachable database indistinguishable from a clean
    // compliance record in the report that goes to Chris.
    rows = listOrThrow({ from, to });
  } catch (err) {
    return { available: false, reason: `overtime log unreadable: ${err?.message || err}` };
  }

  const pending = rows.filter(r => r.outcome === 'pending');
  const approved = rows.filter(r => r.outcome === 'approved');
  const incomplete = rows.filter(r => outstandingSteps(r).length > 0 && r.outcome !== 'declined');
  const approvedWithGaps = approved.filter(r => outstandingSteps(r).length > 0);

  const people = [...new Set(rows.map(r => r.person))];
  const overLimit = [];
  for (const person of people) {
    const profile = getProfile(person);
    const avg = rollingAverage(listOrThrow({ person }), profile?.contracted_hours ?? null, asOf);
    if (avg.averageHours !== null && avg.averageHours > WTR_WEEKLY_LIMIT) {
      overLimit.push({ person, averageHours: avg.averageHours, optoutSigned: profile?.optout_signed === 1 });
    }
  }

  return {
    available: true,
    totalClaims: rows.length,
    hours: Math.round(rows.filter(r => r.outcome !== 'declined').reduce((s, r) => s + (Number(r.hours) || 0), 0) * 100) / 100,
    approved: approved.length,
    pending: pending.length,
    declined: rows.filter(r => r.outcome === 'declined').length,
    // The competency-1 success measure, expressed as a number: approvals that
    // reached "approved" without the full checklist answered. Target is zero,
    // and it should be structurally impossible via approve() — this counts it
    // anyway, because a rule enforced in one code path is not a guarantee.
    approvedWithoutFullChecklist: approvedWithGaps.length,
    checklistOutstanding: incomplete.length,
    overLimit,
    window: { from: from || null, to: to || null },
  };
}

module.exports = {
  list, listOrThrow, get, record, check, approve, decline, status,
  getProfile, setProfile, assess, rollingAverage, outstandingSteps,
  STEPS, WTR_WEEKLY_LIMIT, WTR_REFERENCE_WEEKS, WTR_DAILY_REST_HOURS, DEFAULT_CONTRACTED_HOURS,
};
