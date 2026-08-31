'use strict';

/**
 * Temporal range validation.
 *
 * ⚠ THE BUG. `new Date(x)` accepts almost anything and answers `Invalid Date`
 * for the rest — and EVERY comparison against `NaN` is false, so
 * `modified < fromDate || modified > toDate` never excluded anything. An
 * invalid bound therefore did not fail: it silently became an UNBOUNDED one.
 * Asking for notes since "lastweek" searched all of time and returned the
 * answer labelled as a date range. That is the same species as everything else
 * in this area — a broken query presenting itself as a good one.
 *
 * A second, quieter bug lived beside it: `to=2026-08-31` meant midnight, so the
 * whole of the 31st was excluded from a search whose entire purpose is a date
 * range.
 *
 * `parseDateRange` is PURE, so the rules pin without a vault or a clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const retrieval = require('./retrieval');
const { parseDateRange, parseDateBound } = retrieval;

const NOW = new Date('2026-08-31T12:00:00.000Z');

// ── Rejections ──────────────────────────────────────────────────────────────

test('an invalid "from" is an error, NEVER an unbounded range', () => {
  const r = parseDateRange({ from: 'lastweek', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'from');
  assert.match(r.error, /Invalid "from"/);
});

test('an invalid "to" is an error', () => {
  const r = parseDateRange({ to: 'soon', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'to');
});

test('a date that does not exist is refused, not rolled forward', () => {
  // `new Date('2026-02-31')` is 2 March. Accepting it would answer a question
  // nobody asked, using a month the caller did not name.
  const r = parseDateRange({ from: '2026-02-31', now: NOW });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a real calendar date/);
});

test('an inverted range is refused', () => {
  const r = parseDateRange({ from: '2026-09-01', to: '2026-08-01', now: NOW });
  assert.equal(r.ok, false);
  assert.equal(r.field, 'range');
  assert.match(r.error, /later than/);
});

test('a loose non-ISO date is refused rather than guessed at', () => {
  for (const bad of ['31/08/2026', 'August 31 2026', '2026-8-1', '20260831']) {
    assert.equal(parseDateRange({ from: bad, now: NOW }).ok, false, `${bad} must be refused`);
  }
});

// ── Acceptances, and normalisation ──────────────────────────────────────────

test('a calendar date range is inclusive of the whole "to" day', () => {
  const r = parseDateRange({ from: '2026-08-01', to: '2026-08-31', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.fromIso, '2026-08-01T00:00:00.000Z');
  // ⚠ The fix: midnight would have excluded everything that happened ON the
  // 31st, which is a whole day silently missing from a date-bounded search.
  assert.equal(r.toIso, '2026-08-31T23:59:59.999Z');
});

test('a full ISO timestamp is taken as given', () => {
  const r = parseDateRange({ from: '2026-08-01T09:30:00.000Z', to: '2026-08-01T17:00:00.000Z', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.fromIso, '2026-08-01T09:30:00.000Z');
  assert.equal(r.toIso, '2026-08-01T17:00:00.000Z');
});

test('an OMITTED bound keeps the 30-day default — omission is not an error', () => {
  const r = parseDateRange({ now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.fromDefaulted, true);
  assert.equal(r.toDefaulted, true);
  assert.equal(r.fromIso, '2026-08-01T12:00:00.000Z');
  assert.equal(r.toIso, '2026-08-31T12:00:00.000Z');
});

test('one supplied bound and one omitted is fine, and says which was defaulted', () => {
  const r = parseDateRange({ from: '2026-08-20', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.fromDefaulted, false);
  assert.equal(r.toDefaulted, true);
  assert.equal(r.fromIso, '2026-08-20T00:00:00.000Z');
});

test('an empty-string bound counts as omitted, not as invalid', () => {
  // A query string always supplies something; `?from=` must not be a 400.
  const r = parseDateRange({ from: '', to: '', now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.fromDefaulted, true);
});

test('a same-day range is valid, and covers that day', () => {
  const r = parseDateRange({ from: '2026-08-15', to: '2026-08-15', now: NOW });
  assert.equal(r.ok, true);
  assert.ok(r.from < r.to);
});

// ── The bound itself ────────────────────────────────────────────────────────

test('parseDateBound end-of-day applies only to the "to" end', () => {
  assert.equal(parseDateBound('2026-08-15').date.toISOString(), '2026-08-15T00:00:00.000Z');
  assert.equal(parseDateBound('2026-08-15', { end: true }).date.toISOString(), '2026-08-15T23:59:59.999Z');
});

test('a Date instance passes through, and an Invalid Date does not', () => {
  const d = new Date('2026-08-15T00:00:00.000Z');
  assert.equal(parseDateBound(d).date, d);
  assert.equal(parseDateBound(new Date('nonsense')).ok, false);
});

// ── The backstop inside retrieval ───────────────────────────────────────────

test('temporalSearch refuses an invalid range rather than searching all of time', async () => {
  const { results, traversal } = await retrieval.temporalSearchDetailed('anything', { from: 'lastweek' });
  assert.deepEqual(results, []);
  // ⚠ And it is reported as incompleteness, not as an empty vault.
  assert.equal(traversal.truncated, true);
  assert.match(traversal.why, /temporal range rejected/);
});
