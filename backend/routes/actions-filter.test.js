'use strict';

/**
 * Filtering, faceting and the bulk-reject guards (#108).
 *
 * `/api/actions` caps its payload at 120 and the panel showed 8 a group behind
 * "show more" — but "show more" only revealed what had already been SENT, so
 * 347 of 467 pending actions were unreachable from the UI entirely. The cap
 * itself is right (outbound sorts first, so nothing that leaves the building is
 * ever what gets dropped); what was missing was a way through the tail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');

// The route module pulls in the DB on require.
process.env.NEURO_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-actfilter-')), 'a.db');

const { monthOf, matchesFilter, readFilter, buildFacets } = require('./actions')._internals;

const act = (over = {}) => ({
  id: 1,
  type: 'capture_todo',
  created_at: '2026-08-14T22:00:00.000Z',
  presentation: { kind: 'write' },
  payload: { sourcePath: 'Meetings/2026/06/2026-06-12 – ProCo.md', owner: 'unowned', text: 'Do a thing' },
  ...over,
});

test('month comes from the NOTE date, not when the sweep created the row', () => {
  // The backfill ran in one night across notes spanning March to August. Keying
  // on created_at would put all 463 in the same month and make the filter
  // useless for exactly the job it exists for.
  assert.equal(monthOf(act()), '2026-06');
});

test('month falls back to created_at when the path carries no date', () => {
  assert.equal(monthOf(act({ payload: { sourcePath: 'Projects/Notes.md' } })), '2026-08');
});

test('an empty filter matches everything', () => {
  assert.equal(Object.keys(readFilter({})).length, 0);
  assert.equal(matchesFilter(act(), {}), true);
});

test('filters combine as AND', () => {
  const a = act();
  assert.equal(matchesFilter(a, { month: '2026-06', owner: 'unowned' }), true);
  assert.equal(matchesFilter(a, { month: '2026-06', owner: 'mine' }), false);
  assert.equal(matchesFilter(a, { source: 'Meetings/2026/06/2026-06-12 – ProCo.md' }), true);
  assert.equal(matchesFilter(a, { source: 'Meetings/2026/07/other.md' }), false);
  assert.equal(matchesFilter(a, { kind: 'write' }), true);
  assert.equal(matchesFilter(a, { kind: 'outbound' }), false);
});

test('a missing owner is treated as unowned, not as unfilterable', () => {
  // 325 of the 463 are owner:unowned and the classifier is unreliable there
  // (#104), so this is the filter most likely to be used in anger.
  const a = act({ payload: { sourcePath: 'Meetings/2026/06/x-2026-06-01 – y.md' } });
  assert.equal(matchesFilter(a, { owner: 'unowned' }), true);
});

test('readFilter ignores anything not a known facet', () => {
  const f = readFilter({ month: '2026-06', limit: '500', evil: 'DROP TABLE', offset: '10' });
  assert.deepEqual(f, { month: '2026-06' });
});

test('facets count the whole queue and rank the noisiest note first', () => {
  const all = [
    act({ id: 1 }),
    act({ id: 2 }),
    act({ id: 3, payload: { sourcePath: 'Meetings/2026/07/2026-07-03 – SMT.md', owner: 'mine' } }),
  ];
  const f = buildFacets(all);
  assert.equal(f.byMonth['2026-06'], 2);
  assert.equal(f.byMonth['2026-07'], 1);
  assert.equal(f.byOwner.unowned, 2);
  assert.equal(f.byOwner.mine, 1);
  assert.equal(f.bySource[0].count, 2, 'biggest source first — that is the one worth clearing in one go');
});
