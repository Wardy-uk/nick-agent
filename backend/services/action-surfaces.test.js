'use strict';

/**
 * #26 — the phone's route into the standup.
 *
 * Two separate silent failures are pinned here, because neither one throws and
 * neither one is visible in a green suite that only exercises services:
 *
 *  1. REGISTRATION. A tab id in App.jsx with no entry in SARA_LITE_TABS makes
 *     notification routing fall through to Focus with no error. An id in
 *     SARA_LITE_TABS with no tab in App.jsx sends a notification to a screen
 *     that does not exist. Both directions are asserted.
 *
 *  2. ORDERING. resolveSaraLitePlan checks the 'sheet' list BEFORE the 'tab'
 *     list, so adding 'standup' to SARA_LITE_TABS while leaving it in the sheet
 *     branch is a no-op that looks like a completed change — the card keeps
 *     rendering and App never switches tabs. That branch also covers journal,
 *     meeting and brain, so this asserts those three are STILL sheets: the
 *     naive fix is to empty the branch and quietly change four other paths.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const surfaces = require('../../shared/action-surfaces.cjs');
const { resolveSaraLitePlan, resolveSaraLiteTab } = surfaces;

const APP_JSX = path.join(__dirname, '..', '..', 'sara', 'app', 'src', 'App.jsx');

// Pull the tab ids straight out of the TABS array literal. Reading the source
// is the point — a test that re-declared the list would agree with itself
// forever while the app disagreed.
function tabIdsFromApp() {
  // The vault and this repo are Windows-authored and mixed CRLF/LF; `.` does not
  // match \r, so normalise before any line-anchored matching.
  const src = fs.readFileSync(APP_JSX, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('const TABS = [');
  assert.ok(start !== -1, 'could not find the TABS array in App.jsx');
  const end = src.indexOf('\n];', start);
  assert.ok(end !== -1, 'could not find the end of the TABS array in App.jsx');
  const block = src.slice(start, end);
  const ids = [...block.matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(ids.length >= 8, `expected the full tab list, parsed ${ids.length}`);
  return ids;
}

// Comments in these files legitimately NAME the retired endpoints to explain
// why they are gone, so a bare includes() check would fail on the explanation
// rather than on a real call. Strip comments and assert against live code only.
// Line comments MUST go first. A comment naming a route glob — literally
// "/api/standup-session/*" in Standup.jsx — contains "/*", so stripping block
// comments first opens a false one there and swallows half the file, which
// silently turns every assertion below into a pass-by-absence.
function codeOnly(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/(^|[^:])\/\/[^\n]*/gm, '$1') // the [^:] guard keeps http:// intact
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

// SARA_LITE_TABS is not exported. Probe it through the one behaviour that
// depends on it: resolveSaraLiteTab returns an explicit tab verbatim only when
// the set contains it, otherwise it resolves by kind.
function isRegisteredTab(id) {
  return resolveSaraLiteTab({ tab: id }) === id;
}

test('every tab in App.jsx is registered in SARA_LITE_TABS', () => {
  for (const id of tabIdsFromApp()) {
    assert.ok(
      isRegisteredTab(id),
      `tab '${id}' exists in App.jsx but not in SARA_LITE_TABS — notifications for it fall back to Focus silently`
    );
  }
});

test('every id SARA_LITE_TABS accepts has a tab in App.jsx', () => {
  const ids = tabIdsFromApp();
  // The set is private, so drive the check from the other side: anything the
  // resolver hands back as a tab must be mountable.
  const candidates = new Set(ids.concat(['standup', 'eod', 'journal', 'meeting', 'brain', 'todo', 'chat', 'capture']));
  for (const candidate of candidates) {
    const resolved = resolveSaraLiteTab({ tab: candidate });
    assert.ok(
      ids.includes(resolved),
      `resolveSaraLiteTab('${candidate}') returned '${resolved}', which App.jsx cannot mount`
    );
  }
});

test('a standup nudge opens the Ritual tab, not the notification sheet', () => {
  const plan = resolveSaraLitePlan({ type: 'nudge', meta: { type: 'standup' } });
  assert.equal(plan.kind, 'standup');
  assert.equal(plan.tab, 'standup');
  // 'sheet' here means the retired /api/standup/submit-guided stepper.
  assert.equal(plan.presentation, 'tab');
});

test('an EOD nudge opens the same tab but keeps its kind', () => {
  const plan = resolveSaraLitePlan({ type: 'nudge', meta: { type: 'eod' } });
  // The tab is shared; the kind is what tells the view to open EOD rather than
  // the morning standup, and App threads it through as intentKind.
  assert.equal(plan.kind, 'eod');
  assert.equal(plan.tab, 'standup');
  assert.equal(plan.presentation, 'tab');
});

// The exact payloads nudges.js pushes, not a shape invented here. (Note
// '/?view=standup' — what resolveNueroPath EMITS for the desktop — does not
// resolve inbound, because normalisePath reduces it to '/'. That is pre-existing
// and harmless: nothing sends it to the phone.)
test('the real standup and EOD push payloads both route to the tab', () => {
  const standup = resolveSaraLitePlan({ type: 'standup', url: '/standup' });
  assert.equal(standup.kind, 'standup');
  assert.equal(standup.tab, 'standup');
  assert.equal(standup.presentation, 'tab');

  const eod = resolveSaraLitePlan({ type: 'eod', url: '/standup' });
  assert.equal(eod.kind, 'eod', 'the EOD nudge must not be flattened into a standup');
  assert.equal(eod.tab, 'standup');
  assert.equal(eod.presentation, 'tab');
});

test('journal, meeting and brain are still sheets', () => {
  // Moving standup/eod out of the sheet branch must not take these with them.
  for (const [raw, kind] of [
    [{ type: 'journal' }, 'journal'],
    [{ type: 'meeting_alert' }, 'meeting'],
    [{ type: 'vault_hygiene' }, 'brain'],
  ]) {
    const plan = resolveSaraLitePlan(raw);
    assert.equal(plan.kind, kind);
    assert.equal(plan.presentation, 'sheet', `${kind} should still open as a sheet`);
  }
});

test('NotificationActionCard no longer calls the retired stepper', () => {
  // The card is what the sheet renders. If a standup arm survives there, the
  // phone has two standup flows again, and they disagree about today.
  const card = codeOnly(
    path.join(__dirname, '..', '..', 'sara', 'app', 'src', 'components', 'NotificationActionCard.jsx')
  );
  assert.ok(!card.includes('/api/standup/questions'), 'card still fetches the retired standup questions');
  assert.ok(!card.includes('submit-guided'), 'card still posts to the retired submit-guided endpoint');
});

test('the phone view talks to the session API and preserves the retry contract', () => {
  const view = codeOnly(
    path.join(__dirname, '..', '..', 'sara', 'app', 'src', 'views', 'Standup.jsx')
  );
  assert.ok(view.includes('/api/standup-session/'), 'Standup view must drive the session API');
  assert.ok(!view.includes('submit-guided'), 'Standup view must not use the retired stepper');
  // apiFetch flattens a non-2xx body into an Error message, which throws away
  // `retryable` and the SAVED SESSION the 503 carries — the two fields the
  // whole no-retyping recovery rests on. Using it here would rebuild the bug
  // standup-session.js exists to fix.
  assert.ok(view.includes('err.retryable'), 'the 503 retryable flag must survive');
  assert.ok(view.includes('err.session'), 'the saved session on a failed turn must survive');
  assert.ok(!/\bapiFetch\b/.test(view), 'Standup view must not use apiFetch — it discards the error body');
});
