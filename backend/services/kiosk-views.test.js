'use strict';

/**
 * The Pi kiosk, guarded from the backend suite.
 *
 * `sara/frontend` has no test runner of its own, and on 30 Aug that showed:
 * three real bugs in the Presence screen were caught by SSHing to the Pi,
 * screenshotting the DSI panel with `grim` and looking at the picture. That
 * worked, and it is not a gate — nobody will do it on the next change.
 *
 * Reading another workspace's source from here is the established pattern
 * (`action-surfaces.test.js` reads the shared tab registry for exactly this
 * reason: neither half errors on its own, so only a test spanning both catches
 * the disagreement).
 *
 * ⚠ REWRITTEN 31 Aug 2026. This file used to assert things about the kiosk's
 * own fourteen-screen registry and its ViewRouter. Both are gone: the kiosk
 * mounts the phone's registry and the two shells are one app. Testing a
 * registry that no longer routes anything would be the same species of
 * dead-but-green as the suite that was passing over VESTA's never-working task
 * path. What is left is what still has to be true.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const KIOSK = path.join(__dirname, '..', '..', 'sara', 'frontend', 'src');
const SHARED = path.join(__dirname, '..', '..', 'sara', 'shared-ui');

const APP = path.join(KIOSK, 'App.jsx');
const KIOSK_CSS = path.join(KIOSK, 'App.css');
const LOCK = path.join(KIOSK, 'components', 'LockScreen.jsx');
const CLOCK = path.join(KIOSK, 'components', 'ClockScreen.jsx');
const SURFACE = path.join(SHARED, 'AttentionSurface.jsx');
const FIELD = path.join(SHARED, 'Field.jsx');

function read(file) {
  // Mixed CRLF/LF repo — normalise before any line-anchored matching.
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

test('positive control — the kiosk shell parses and mounts the shared registry', () => {
  // Without this every assertion below can pass by reading the wrong file.
  const src = read(APP);
  assert.match(src, /shared-ui\/tabs/, 'the kiosk no longer mounts the shared tab registry');
  assert.match(src, /AppShell/);
});

test('⚠ the field renders in EVERY state SARA is seen in', () => {
  // Nick, 31 Aug 2026: "crucially the nebulous connected nodes must be present
  // whenever I see SARA." They were not — `Field` was reachable only from
  // inside `AttentionSurface`, so it drew when the feed was good and vanished
  // in the states where the kiosk still says her name: the lock screen (which
  // drew a pulsing ORB, deprecated permanently by MANIFESTATION.md) and the
  // clock screen. Asserted POSITIVELY per file: a negative ("no file lacks a
  // Field") passes on a broken scan.
  for (const [label, file] of [['App shell', APP], ['LockScreen', LOCK], ['ClockScreen', CLOCK]]) {
    const src = read(file);
    assert.match(src, /from '(\.\.\/)+shared-ui\/Field'/, `${label} no longer imports the shared Field`);
    assert.ok(src.includes('<Field'), `${label} imports the Field but never renders it`);
  }
  assert.doesNotMatch(read(LOCK), /lock__orb/, 'the deprecated orb is back on the lock screen');
});

test('⚠ the locked field is STILL — nothing animates behind an unlit panel', () => {
  // The `locked` state takes the backlight to 0, and a browser cannot see that:
  // a kiosk page is never `document.hidden`, so Field's own "stops dead when the
  // page is hidden" guard protects against a condition that cannot occur on a
  // wall display. Found live 2 Sep 2026 — the Pi 4 had been painting the field
  // at 12fps into a dark screen in an empty house for 1d17h, at 100% of a core.
  //
  // It still RENDERS (the test above), because the display agent can die and the
  // light can come back before the verdict does. It just does not loop.
  assert.ok(read(LOCK).includes('<Field confidenceLevel="low" degraded still />'),
    'the lock screen animates its field behind a backlight set to 0');
});

test('⚠ ONE field at a time — an overlay owns the screen, or the shell does', () => {
  // LockScreen and ClockScreen render as an overlay OVER the live shell rather
  // than instead of it, and each mounts a Field of its own. The shell's own
  // suppression was `active !== 'surface'` — one case short — so the kiosk drew
  // two full-screen fields stacked, which is the exact thing the comment beside
  // that line says must not happen ("two stacked fields would put a `quiet`
  // placeholder under an honest one"). Locked, that was ~22,000 stroke calls a
  // frame, invisible, behind an unlit panel.
  const src = read(APP);
  const guard = src.slice(0, src.indexOf('className="app__field"'));
  assert.ok(guard.includes('overlayOwnsScreen'),
    'the shell field is not suppressed while a lock/clock overlay owns the screen');
  // BOTH overlays, not just the lock — the clock screen mounts a Field too.
  assert.ok(src.includes('const overlayOwnsScreen = locked || showClock;'),
    'overlayOwnsScreen must cover both overlays, each of which mounts its own Field');
});

test('⚠ the covered subtree stops animating, and the overlays are OUTSIDE it', () => {
  // ⚠ THE FIRST FIX MISSED THE FIELD THAT WAS ACTUALLY RUNNING. Suppressing the
  // shell field did nothing here: the kiosk opens on the Surface (DEFAULT_TAB),
  // which was already excluded by `active !== 'surface'` — and AttentionSurface
  // mounts a Field of ITS OWN, which no guard in App.jsx reaches. That is the
  // one that painted under the lock overlay. Measured after the first deploy:
  // still 23% renderer + 23% GPU on a locked, unlit screen.
  //
  // So the cover has to be a property of the SUBTREE, not of a named component.
  const src = read(APP);
  const open = src.indexOf('<FieldCover covered={overlayOwnsScreen}>');
  const close = src.indexOf('</FieldCover>');
  assert.ok(open > -1 && close > open, 'the shell is not wrapped in a FieldCover');

  const covered = src.slice(open, close);
  assert.ok(covered.includes('<ActiveView'),
    'the active view must be INSIDE the cover — its own Field is the expensive one');

  // ⚠ And the overlays must be OUTSIDE it. The clock screen is lit and its field
  // animates; stopping that would blank the only field anyone can see.
  const after = src.slice(close);
  assert.ok(after.includes('<ClockScreen') && after.includes('<LockScreen'),
    'an overlay is inside the cover — its own visible field would be stopped');
});

test('⚠ covering stops the loop without rebuilding the substrate', () => {
  // Uncovering happens exactly when Nick walks back into the room, which is the
  // one moment the field is being looked at. Rebuilding there would flicker the
  // whole substrate, so the cover toggles the loop through a ref rather than
  // re-running the effect that generates it.
  const field = read(FIELD);
  assert.ok(field.includes('useContext(FieldCoverContext)'), 'Field ignores the cover');
  assert.ok(field.includes('}, [covered]);'),
    'the cover must be its own effect — folding it into the build effect rebuilds the substrate');
  assert.ok(!field.includes('[still, covered]') && !field.includes('[covered, still]'),
    'covered must not be a dependency of the substrate build');
});

test('⚠ the shell field is DRIVEN, not hardcoded', () => {
  // It used to be pinned at `quiet` + `low` on every screen but the Surface, so
  // she looked identical whether the queue was on fire or the day was empty —
  // and the slow pulse could not fire there either, which meant a critical item
  // never reached him unless he was already looking at her own screen.
  const src = read(APP);
  assert.match(src, /useFieldDrive/, 'the shell field is no longer driven by the brain');
  assert.doesNotMatch(src, /<Field quiet confidenceLevel="low"/,
    'the shell field is hardcoded again');
});

test('⚠ ONE definition of "pressing", shared by the surface and the shell', () => {
  // Two definitions on the same screen are two answers free to drift.
  const surface = read(SURFACE);
  assert.match(surface, /import \{ isPressing \}/,
    'AttentionSurface restates the pressing rule instead of importing it');
  const hook = read(path.join(SHARED, 'useFieldDrive.js'));
  assert.match(hook, /export function isPressing/);
  assert.match(hook, /critical/);
  assert.match(hook, /high/);
});

test('⚠ dimming the field must not DELETE its edges', () => {
  // The cull ran after `dim`, so at `quiet` an edge computed 0.012 x 0.45 =
  // 0.0054, under the 0.013 floor, and NO EDGE DREW AT ALL — the connected
  // nodes lost their connections in the state a desk kiosk sits in most of the
  // day. It must be tested on the undimmed value.
  const src = read(FIELD);
  assert.match(src, /EDGE_CULL_ALPHA/, 'the edge cull constant is gone');
  assert.match(src, /const base = EDGE_REST_ALPHA \+ near \* EDGE_COHERENT;\s*\n\s*if \(base < EDGE_CULL_ALPHA\)/,
    'the edge cull is being tested against a dimmed alpha again');
});

test('⚠ the kiosk stylesheet defines no app-shell classes', () => {
  // Two files defining `.app__nav` let the cascade decide, and on the real
  // panel the kiosk's retired 248px sidebar won: the bottom bar rendered as a
  // column down the left with the surface squeezed to nothing. The fix is not
  // more specificity, it is not having two definitions.
  // ⚠ COMMENTS STRIPPED FIRST. The header explains which selectors were removed
  // and why, so a bare `includes` matches the prose describing the rule and
  // fails on a correct file — the widget test tripped over its own explanation
  // the same way. Check the CODE, and do not write an exemption for the bits
  // that describe it.
  const css = read(KIOSK_CSS).replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of ['.app__nav', '.app__view', '.app__main', '.app {']) {
    assert.ok(!css.includes(sel), `${sel} is back in the kiosk stylesheet`);
  }
  // Positive control: it must still carry the THEME the remaining chrome uses.
  assert.match(css, /:root/);
  assert.match(css, /--accent/);
});

test('⚠ the retired screens are gone, not merely unreferenced', () => {
  // Dead-but-readable is the shape that let a deleted Jira queue go on being
  // read for seven weeks. If they come back, something is mounting them.
  const screens = path.join(KIOSK, 'screens');
  assert.ok(!fs.existsSync(screens), 'the legacy kiosk screens are back');
  for (const gone of ['ViewRouter.jsx', 'ViewSwitcher.jsx', 'PlannedView.jsx']) {
    assert.ok(!fs.existsSync(path.join(KIOSK, 'components', gone)), `${gone} is back`);
  }
});

test('⚠ the three silences stay three, in the one place they are defined', () => {
  const shared = read(SURFACE);
  assert.match(shared, /read this as an all-clear/i, 'the pool-blind line must refuse an all-clear');
  assert.match(shared, /Nothing pressing/, 'the genuinely-quiet line is gone');
  assert.match(shared, /Staying out of the way|context\?\.summary/, 'the in-a-meeting line is gone');
});
