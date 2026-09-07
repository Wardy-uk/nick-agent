'use strict';

/**
 * The Management Log is its OWN view, and it is the only place that writes to
 * the log.
 *
 * Two failures are being pinned, and this repo has shipped both before.
 *
 * (1) **Routable but unreachable.** A panel with a `case` in App.jsx and no
 * entry in the sidebar is reachable only by deep link — the hole documented in
 * Sidebar.jsx for `todos` and `decisions`. A view nobody can find is the same
 * as no view, which is exactly what was wrong with the log before it had one:
 * `POST /api/weekly-risk/log` existed with no caller in either frontend.
 *
 * (2) **Two mutating surfaces over one table.** WeeklyRiskPanel keeps the
 * compliance picture READ-ONLY and links here. If it grows its own form again
 * the two drift, and the log is a compliance record where "which screen did I
 * add it on" must never be a question.
 *
 * Source scans, so each carries a POSITIVE CONTROL: a scan that silently
 * matched nothing would pass by absence and prove the opposite of what it says.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'src');
const read = (...p) => fs.readFileSync(path.join(FRONTEND, ...p), 'utf8');

const app = read('App.jsx');
const sidebar = read('components', 'Sidebar.jsx');
const panel = read('components', 'ManagementLogPanel.jsx');
const weekly = read('components', 'WeeklyRiskPanel.jsx');

test('the view is both routable AND findable', () => {
  // Positive control: the scan is looking at real files with real views in them.
  assert.match(app, /case 'weekly-risk'/, 'control — App.jsx routes views by id');
  assert.match(sidebar, /id: 'weekly-risk'/, 'control — Sidebar.jsx lists views by id');

  assert.match(app, /case 'management-log'/, 'App.jsx must route it');
  assert.match(sidebar, /id: 'management-log'/, 'and the sidebar must list it, or it is deep-link only');
});

test('it can log, edit, close and drop — every verb the log needs', () => {
  assert.match(panel, /'\/api\/weekly-risk\/log', 'POST'/, 'add');
  assert.match(panel, /\/api\/weekly-risk\/log\/\$\{id\}`, 'PATCH'/, 'edit and close');
  assert.match(panel, /\/api\/weekly-risk\/log\/\$\{id\}`, 'DELETE'/, 'drop a row that was never his');
  assert.match(panel, /status: 'done'/, 'closing an item is reachable from the row');
});

test('Weekly Risk no longer writes to the log — one mutating surface, not two', () => {
  // Positive control: it still READS the log, so an empty scan cannot pass.
  assert.match(weekly, /\/api\/weekly-risk\/log/, 'control — it still reads the log for the compliance picture');

  assert.doesNotMatch(weekly, /'POST'[\s\S]{0,80}weekly-risk\/log|weekly-risk\/log'[\s\S]{0,120}method: 'POST'/,
    'no second entry form');
  assert.doesNotMatch(weekly, /method: 'PATCH'/, 'no second editor — People HR is answered in the log');
  assert.doesNotMatch(weekly, /method: 'DELETE'/, 'no second way to delete a compliance row');
  assert.match(weekly, /onNavigate\('management-log'\)/, 'and there is a way through to the one that does');
});

test('the panel never offers to set when something was logged', () => {
  // ⚠ The whole of competency 3 is the gap between a conversation happening and
  // being written down. `entryDate` is editable — correcting when it happened is
  // a legitimate fix — but `loggedAt` is the server's stamp and the API refuses
  // one from a manual caller. A field for it here would advertise a forgery the
  // backend would silently ignore, which is worse than either.
  // Scan the REQUEST PAYLOADS, not the whole file — `loggedAt` legitimately
  // appears in the receipt, which displays the server's stamp back to Nick.
  // Each payload runs from a `send(..., 'POST'|'PATCH', {` to its `});`.
  const payloads = [];
  for (const verb of ["'POST', {", "'PATCH', {"]) {
    let at = panel.indexOf(verb);
    while (at !== -1) {
      const end = panel.indexOf('});', at);
      payloads.push(panel.slice(at, end === -1 ? panel.length : end));
      at = panel.indexOf(verb, at + 1);
    }
  }
  assert.ok(payloads.length >= 2, 'control — found the add and edit payloads');
  assert.ok(payloads.some(b => b.includes('entryDate')), 'control — a payload does carry when it happened');
  for (const body of payloads) {
    // ⚠ Narrow on purpose: `hrLogged` is a legitimate field (the People HR
    // answer) and matching a bare /logged/ would flag it. What must never be
    // sent is the STAMP.
    assert.ok(!/loggedAt|logged_at/.test(body), 'a payload must never carry a log stamp');
  }
  assert.match(panel, /not editable from here/, 'and it says so where the form is');
});

test('an unreadable log is never rendered as an empty one', () => {
  assert.match(panel, /not<\/strong> an empty log/, 'the error state says which');
  assert.match(panel, /No entries match this filter/, 'and a narrow filter is not an empty record either');
});
