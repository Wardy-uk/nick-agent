'use strict';

/**
 * Every card must be actionable — Nick, 1 Sep 2026.
 *
 * "In NEURO, every card must be actionable — either edit/complete, or navigate
 * to the actual tasks."
 *
 * Two failures sat behind that, and they are different species, so this file
 * pins both.
 *
 * ⚠ **The dead end.** "What you're pushing away" on the DEFAULT screen listed
 * tasks Nick had been avoiding, with no button of any kind. Its own footnote
 * said "stated so you can decide" and there was nothing on the row to decide
 * WITH — so the only thing it could do was say the same sentence again
 * tomorrow. A card that names work and cannot reach it is read once.
 *
 * ⚠ **The link that lies.** `Dashboard` rendered a "Queue" quick action
 * navigating to the view id `queue` — DELETED with the Jira queue feature in
 * July 2026. `App.jsx`'s default case sends an unknown view to Now, so the
 * button landed somewhere unrelated and looked exactly like it had worked. That
 * is worse than no button: it teaches that the links on the page are
 * decoration. The general guard is below, and it is the one worth keeping —
 * it fails on the NEXT deleted view rather than on this one.
 *
 * Lives in backend/services because `node --test` is only run from backend/,
 * and the desktop frontend has no runner of its own. Not a backend service.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', 'frontend', 'src');
const COMPONENTS = path.join(SRC, 'components');

function read(rel, base = COMPONENTS) {
  return fs.readFileSync(path.join(base, rel), 'utf-8');
}

/** Comments describe the bugs by name; the rules are about what the code CALLS. */
function code(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

/** The view ids `App.jsx` can actually render, read from its switch. */
function knownViews() {
  const app = read('App.jsx', SRC);
  const ids = new Set();
  for (const m of app.matchAll(/case\s+'([a-z0-9-]+)'\s*:/gi)) ids.add(m[1]);
  return ids;
}

// ── The general guard ────────────────────────────────────────────────────────

test('every view a component navigates to is one App.jsx can render', () => {
  const views = knownViews();
  // Positive control: if the switch stopped parsing, `views` would be empty and
  // this rule would pass by finding nothing to check. Same trap as a grep
  // returning zero because the pattern was wrong.
  assert.ok(views.size > 20, `expected App.jsx to expose many views, saw ${views.size}`);
  assert.ok(views.has('todos'), 'sanity: todos must be a known view');

  // `chat` is handled before the switch (it opens the aside and deliberately
  // does NOT change activeView), so it is legitimate and not in the case list.
  const HANDLED_OUTSIDE_SWITCH = new Set(['chat']);

  const offenders = [];
  for (const file of fs.readdirSync(COMPONENTS).filter((f) => f.endsWith('.jsx'))) {
    const src = code(read(file));
    for (const m of src.matchAll(/onNavigate\??\.?\(?\s*\??\.?\(\s*'([a-z0-9-]+)'/gi)) {
      const view = m[1];
      if (views.has(view) || HANDLED_OUTSIDE_SWITCH.has(view)) continue;
      offenders.push(`${file} → '${view}'`);
    }
  }

  assert.deepStrictEqual(
    offenders, [],
    'these navigate to a view App.jsx cannot render, so the click silently lands on Now:\n  '
    + offenders.join('\n  ')
  );
});

test('the deleted Jira queue view is not navigated to from anywhere', () => {
  // The specific regression, kept alongside the general rule because it names
  // the feature: the queue was REMOVED on purpose, and a link back to it is a
  // link to something that does not exist rather than a typo.
  const offenders = [];
  for (const file of fs.readdirSync(COMPONENTS).filter((f) => f.endsWith('.jsx'))) {
    if (/onNavigate[^\n]*'queue'/.test(code(read(file)))) offenders.push(file);
  }
  assert.deepStrictEqual(offenders, [], `still navigating to the deleted queue view: ${offenders.join(', ')}`);
});

// ── The dead end ─────────────────────────────────────────────────────────────

test('the avoidance card offers a way to answer each row', () => {
  const src = code(read('AdhdPanel.jsx'));
  // The section exists...
  assert.ok(/What you're pushing away/.test(read('AdhdPanel.jsx')), 'positive control: the section is still on the page');
  // ...and each row can be started, closed, or opened.
  assert.ok(/completeAvoided\(/.test(src), 'a row must be closeable from the card');
  assert.ok(/avoidActionable\(/.test(src), 'a row with no handle must get no buttons rather than a guess');
  assert.ok(/onNavigate\?\.\('todos', \{[\s\S]{0,200}taskId: s\.task_id/.test(src),
    'a row must be able to open the actual task, not just the task list');
});

test('quick wins can be picked up as well as ticked off', () => {
  const src = code(read('AdhdPanel.jsx'));
  assert.ok(/adhd__quick-start/.test(src), 'a quick win must be startable');
  assert.ok(/completeQuickWin\(/.test(src), 'positive control: it is still closeable too');
});

test('a task that fits in the gap can be started and closed from the row', () => {
  const src = code(read('TimeFitCard.jsx'));
  assert.ok(/\/api\/session\/start/.test(src), 'the card that says what fits must be able to begin it');
  assert.ok(/\/complete/.test(src), 'and to close it');
  // ⚠ A held tick must never render as done. That is the silent half-failure
  // shape this codebase refuses everywhere else.
  assert.ok(/json\.task\?\.held/.test(src), 'a held completion must be read off the returned row and said out loud');
});

test('a friction insight can reach the work it is about', () => {
  const src = code(read('FrictionSection.jsx'));
  assert.ok(/ins\.subject && onNavigate/.test(src),
    'an insight naming a task must offer to open it — and offer nothing when it names none');
  assert.ok(/note\(ins\)/.test(src), 'positive control: "Noted" still answers the card itself');
});
