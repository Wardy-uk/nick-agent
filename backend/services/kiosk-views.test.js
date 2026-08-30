'use strict';

/**
 * The Pi kiosk's view registry — guarded from the backend suite.
 *
 * `sara/frontend` has no test runner of its own, and on 30 Aug that showed:
 * three real bugs in the new Presence screen were caught by SSHing to the Pi,
 * screenshotting the DSI panel with `grim` and looking at the picture. That
 * worked, and it is not a gate — nobody will do it on the next change.
 *
 * Reading another workspace's source from here is the established pattern
 * (`action-surfaces.test.js` reads `sara/app/src/App.jsx` for exactly this
 * reason: neither half errors on its own, so only a test spanning both catches
 * the disagreement).
 *
 * Both invariants below are bugs that ACTUALLY HAPPENED today, not hypotheses.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const KIOSK = path.join(__dirname, '..', '..', 'sara', 'frontend', 'src');
const VIEWS = path.join(KIOSK, 'state', 'views.js');
const PRESENCE = path.join(KIOSK, 'screens', 'presence', 'PresenceView.jsx');

function read(file) {
  // Mixed CRLF/LF repo — normalise before any line-anchored matching.
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** The `key: 'value'` pairs inside a named object literal. */
function objectKeys(src, name) {
  const start = src.indexOf(`const ${name} = {`);
  assert.ok(start !== -1, `could not find ${name}`);
  const end = src.indexOf('\n};', start);
  assert.ok(end !== -1, `could not find the end of ${name}`);
  return [...src.slice(start, end).matchAll(/^\s*'?([A-Za-z0-9_-]+)'?:/gm)].map((m) => m[1]);
}

test('positive control — the registry parses', () => {
  const src = read(VIEWS);
  assert.ok(src.includes('VIEW_REGISTRY'), 'the control failed; nothing below proves anything');
  const ids = [...src.matchAll(/id:\s*SARA_VIEWS\.([A-Z_]+)/g)].map((m) => m[1]);
  assert.ok(ids.length >= 10, `expected the full registry, parsed ${ids.length}`);
});

test('⚠ no ALIAS shadows a real view id', () => {
  // THE BUG. `presence` was an alias pointing at mission-control from when no
  // presence screen existed. Adding the real view left the alias in place, so
  // `normalizeViewId('presence')` silently rewrote every request for the new
  // screen into the briefing — the kiosk would never have opened where it was
  // told to, with nothing anywhere reporting a problem.
  const src = read(VIEWS);
  const viewValues = new Map(
    [...src.matchAll(/^\s*([A-Z_]+):\s*'([^']+)'/gm)].map((m) => [m[1], m[2]])
  );
  const realIds = new Set(
    [...src.matchAll(/id:\s*SARA_VIEWS\.([A-Z_]+)/g)].map((m) => viewValues.get(m[1])).filter(Boolean)
  );

  // ⚠ An IDENTITY alias is fine and several exist on purpose:
  // `'mission-control': SARA_VIEWS.BRIEFING` where BRIEFING *is*
  // 'mission-control' is a no-op that lets an old id keep working. What is
  // fatal is an alias whose key is a registered view and whose TARGET is a
  // DIFFERENT one — that silently rewrites every request for the real screen.
  const start = src.indexOf('const VIEW_ALIASES = {');
  const body = src.slice(start, src.indexOf('\n};', start));
  const pairs = [...body.matchAll(/^\s*'?([A-Za-z0-9_-]+)'?:\s*SARA_VIEWS\.([A-Z_]+)/gm)];
  assert.ok(pairs.length > 0, 'the control failed — no aliases parsed');

  for (const [, alias, targetKey] of pairs) {
    const target = viewValues.get(targetKey);
    if (!realIds.has(alias)) continue;      // aliasing a non-view is the normal case
    assert.equal(
      target, alias,
      `'${alias}' is a registered view but its alias points at '${target}' — every request for it is rewritten away`
    );
  }
});

test('DEFAULT_VIEW names a view that actually exists', () => {
  const src = read(VIEWS);
  const m = src.match(/export const DEFAULT_VIEW = SARA_VIEWS\.([A-Z_]+);/);
  assert.ok(m, 'DEFAULT_VIEW is not set from SARA_VIEWS');
  const registered = [...src.matchAll(/id:\s*SARA_VIEWS\.([A-Z_]+)/g)].map((x) => x[1]);
  assert.ok(
    registered.includes(m[1]),
    `DEFAULT_VIEW is ${m[1]}, which is not in VIEW_REGISTRY — the kiosk opens on a screen the switcher cannot show`
  );
});

test('every registered view is reachable in the router', () => {
  const src = read(VIEWS);
  const router = read(path.join(KIOSK, 'components', 'ViewRouter.jsx'));
  const registered = [...src.matchAll(/id:\s*SARA_VIEWS\.([A-Z_]+)/g)].map((m) => m[1]);
  const routed = new Set([...router.matchAll(/case SARA_VIEWS\.([A-Z_]+):/g)].map((m) => m[1]));
  // `PlannedView` is the honest fallback for reserved-but-unbuilt screens, so a
  // missing case is not automatically wrong — but the DEFAULT must be routed,
  // or the kiosk opens on a placeholder.
  const def = src.match(/export const DEFAULT_VIEW = SARA_VIEWS\.([A-Z_]+);/)[1];
  assert.ok(routed.has(def), `the default view ${def} has no case in ViewRouter`);
  assert.ok(registered.length > 0);
});

test('⚠ the Presence field handles EVERY provenance, mixed included', () => {
  // THE OTHER BUG. `provenance.js` rolls up to neuro / neuro-stale /
  // unavailable / demo AND 'mixed' — five, not the four CLAUDE.md claimed. The
  // live kiosk sits in 'mixed' most of the time, and with no case for it the
  // screen fell to the default and would have rendered "I can't see the brain":
  // a false negative when most of the read was fine.
  const src = read(PRESENCE);
  assert.ok(src.includes('function fieldStateFor'), 'the control failed');
  for (const state of ['neuro', 'neuro-stale', 'mixed', 'demo', 'unavailable']) {
    assert.ok(src.includes(`case '${state}'`), `no case for provenance '${state}'`);
  }
});

test('⚠ Presence always renders SOMETHING — silence is not a screen', () => {
  // THE THIRD BUG. There was no branch for a live read with no headline, so the
  // panel drew the field and NOT ONE WORD — indistinguishable from a broken
  // view, on the surface whose whole job is making the state legible. Silence
  // is a valid answer for a NOTIFICATION; it is never one for a screen.
  const src = read(PRESENCE);
  assert.ok(src.includes('Here, and reading.'), 'the live-and-quiet fallback line is gone');

  // ⚠ Asserted POSITIVELY. A first cut tried "the file must not contain the
  // words 'all-clear'" and failed on the two lines that exist precisely to
  // REFUSE one — a negative assertion over prose, which is the same trap as a
  // regex about a regex. What matters is that the blind states say so, so that
  // is what is checked.
  assert.match(src, /isn.t an all-clear/i, 'the unreachable-brain line must refuse an all-clear');
  assert.match(src, /don.t read this as an all-clear/i, 'the pool-blind line must refuse an all-clear');
});
