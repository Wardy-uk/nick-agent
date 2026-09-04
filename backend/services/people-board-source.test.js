'use strict';

/**
 * What the People card is no longer allowed to do.
 *
 * Three things moved to NOVA on 2026-09-04, and all three would regress silently — a
 * button that comes back, a count that goes back to guessing, a date field that becomes
 * a fourth writer. None of them throws; each just quietly disagrees with NOVA.
 *
 * Source scans, each with a positive control, because there is no runtime assertion that
 * can see the absence of a control.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const BOARD = path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'PeopleBoard.jsx');
const src = fs.readFileSync(BOARD, 'utf8');

test('positive control: this is the People board', () => {
  assert.match(src, /export default function PeopleBoard/);
  assert.match(src, /person-card-actions/);
});

test('the n8n 1-2-1 review is gone from the board', () => {
  // It duplicated NOVA's day-before prep (`runDayBeforePrep` / `gatherPrepSignals`)
  // against the KPI database NOVA owns, via an n8n hop and a second approval queue.
  assert.doesNotMatch(src, /api\/n8n/, 'no n8n call may return to this board');
  assert.doesNotMatch(src, /ApprovalPanel/, 'the n8n approval queue is retired');
  assert.doesNotMatch(src, /lookbackDays|nextStepsDays/, 'the snapshot window selects are retired');
});

test('the actions count comes from NOVA, never from matching names against tasks', () => {
  // The old count was `personSummaries[name].tasks.length` — NEURO's own open tasks whose
  // text happened to mention the person, rendered as "N actions owed" on a 1-2-1 card.
  assert.match(src, /1to1\/open-actions/, 'the count must come off the NOVA bridge');
  assert.doesNotMatch(
    src,
    /personSummaries\[person\.name\]\?\.tasks/,
    'a name match over Nick\'s todo list must not be presented as actions a colleague owes',
  );
});

test('1-2-1 dates are shown, not typed', () => {
  // `last-1-2-1` is detected from the written-up note and stamped by the NOVA writeback;
  // `next-1-2-1-due` is recomputed from last + cadence at read time. A date input here is
  // a fourth writer racing three detectors.
  assert.doesNotMatch(src, /setLast121|setNext121/, 'no date input may return to the update form');
  assert.match(src, /update-readonly/, 'positive control: the read-only rows are rendered');
  // What Nick still decides himself, and nothing can detect for him.
  assert.match(src, /setCadence/);
  assert.match(src, /setEmploymentStatus/);
});
