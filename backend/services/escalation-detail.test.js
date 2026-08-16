'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jira = require('./jira');
const { _informativeStatus, _informativePriority, _informativeAssignee } = jira;

// #54 — getUnseenEscalations() had been shipping status, priority and assignee
// through meta.escalations into Focus and Briefing, where nothing rendered any
// of them. The question was whether to show them or stop sending them, and the
// live data answered it rather than taste did.
//
// Measured over all 41 escalations Jira holds (not just the 6 open now, which
// would have said "always Unset, always Nick" and got this wrong):
//   priority — Unset 33, Normal 5, Major 2, Critical 1
//   assignee — Nick Ward 23, unassigned 7, five other people 11
//   status   — of the 6 open: Open 3, Reopened 2, Waiting on Development 1
//
// So neither "show all three" nor "drop all three" is right. Each field has a
// DEFAULT that is a fact about the queue rather than about the ticket, and a
// tail that is worth interrupting for. Suppress the default, keep the tail.
// Doing it in the service — not in each panel — is what stops Focus and
// Briefing drifting apart on what deserves a badge.

test('an unset priority is dropped — it is 80% of the queue and sorts nothing', () => {
  assert.equal(_informativePriority('Unset'), null);
  assert.equal(_informativePriority('None'), null);
  assert.equal(_informativePriority(null), null);
});

test('a real priority survives — the whole reason the field is kept', () => {
  assert.equal(_informativePriority('Critical'), 'Critical');
  assert.equal(_informativePriority('Major'), 'Major');
  assert.equal(_informativePriority('Normal'), 'Normal');
});

test('Open is dropped — it is the baseline for an unresolved escalation', () => {
  assert.equal(_informativeStatus('Open'), null);
  assert.equal(_informativeStatus(null), null);
});

test('a status that changes whether a reply is owed survives', () => {
  assert.equal(_informativeStatus('Reopened'), 'Reopened');
  assert.equal(_informativeStatus('Waiting on Development'), 'Waiting on Development');
});

test("Nick's own name is dropped — it is his board, so it badges every row", () => {
  assert.equal(_informativeAssignee('Nick Ward'), null);
});

test('someone else owning it is information, and nobody owning it is louder', () => {
  assert.equal(_informativeAssignee('Chris Middleton'), 'Chris Middleton');
  // 7 of the 41 had no assignee at all. On an escalation that is the finding,
  // so it renders as a value rather than vanishing with the other defaults.
  assert.equal(_informativeAssignee(null), 'Unassigned');
  assert.equal(_informativeAssignee(undefined), 'Unassigned');
});

test('a row with nothing to say emits no badges at all', () => {
  // The common case, and the one that keeps the card quiet: the panels render
  // a badge per non-null field, so three nulls is three fewer things on screen.
  assert.equal(_informativeStatus('Open'), null);
  assert.equal(_informativePriority('Unset'), null);
  assert.equal(_informativeAssignee('Nick Ward'), null);
});
