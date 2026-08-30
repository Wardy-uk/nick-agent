'use strict';

/**
 * The notification prompt is never raised on launch.
 *
 * `usePushSubscription` used to call `Notification.requestPermission()` as soon
 * as the PIN was accepted, which puts the browser's ONE-SHOT dialog in front of
 * someone who opened the app to write down a thought. On iOS a denial is close
 * to permanent, so asking at the wrong moment is the single most expensive thing
 * this app can do — and it is invisible in every test that does not run on a
 * phone, because node has no `Notification`.
 *
 * So this asserts the SOURCE, the same way `widget-source.test.js` and the
 * `await describe(` pin work: the failure is syntactic and silent, and the only
 * other thing that would catch it is Nick's phone.
 *
 * ⚠ With a POSITIVE CONTROL. A scan that quietly stopped matching would pass by
 * absence, which is how a green suite once proved nothing at all about a bypass
 * (`meeting_alert` — a string that code path never sent).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HOOK = path.join(__dirname, '..', '..', 'sara', 'app', 'src', 'hooks', 'usePushSubscription.js');

function source() {
  // This repo is Windows-authored and mixed CRLF/LF; normalise before any
  // line-anchored matching.
  return fs.readFileSync(HOOK, 'utf8').replace(/\r\n/g, '\n');
}

test('positive control — the scan can find requestPermission at all', () => {
  const src = source();
  assert.ok(
    src.includes('requestPermission'),
    'the control failed: if this string is gone the assertions below prove nothing'
  );
});

test('requestPermission is reachable ONLY from the explicit enable path', () => {
  const src = source();

  // Everything from `export function usePushSubscription` to end of file is the
  // automatic path. The prompt must not appear anywhere in it.
  const hookStart = src.indexOf('export function usePushSubscription');
  assert.ok(hookStart !== -1, 'usePushSubscription is gone — this test needs rewriting, not deleting');
  const autoPath = src.slice(hookStart);
  assert.ok(
    !autoPath.includes('requestPermission'),
    'the launch prompt is back: usePushSubscription must never ask for permission'
  );

  // And it must appear in the deliberate one, or nothing can ever be enabled.
  const enableStart = src.indexOf('export async function enableNotifications');
  assert.ok(enableStart !== -1, 'enableNotifications is gone — there would be no way to turn notifications on');
  const enablePath = src.slice(enableStart, hookStart === -1 ? undefined : hookStart);
  assert.ok(enablePath.includes('requestPermission'), 'enableNotifications no longer asks for permission');
});

test('the automatic path returns before anything that could prompt', () => {
  const src = source();
  const hook = src.slice(src.indexOf('export function usePushSubscription'));
  // The guard must be the granted-check, and it must come BEFORE the first
  // await — a fall-through past it is exactly how the prompt came back.
  const guard = hook.indexOf("Notification.permission !== 'granted'");
  assert.ok(guard !== -1, 'the granted-only guard is gone');
  const firstAwait = hook.indexOf('await');
  assert.ok(firstAwait === -1 || guard < firstAwait, 'the guard must precede any awaited work');
});
