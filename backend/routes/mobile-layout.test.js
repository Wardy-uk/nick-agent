'use strict';

// Two mobile layout invariants, pinned by scanning the stylesheet.
//
// Both failures are INVISIBLE on a desktop browser, which is why they survived:
// the app was wider than the phone screen and scrolled sideways, and the last
// line of a long page (the "show all" link on My Health) sat underneath the
// bottom nav. Neither shows up in any unit test, and nothing else in the suite
// looks at CSS.
//
// Scanned rather than rendered because there is no browser in this suite. That
// makes the assertions coarse on purpose: each pins the DECISION, not the
// formatting — the same shape as `widget-source.test.js`, and each carries a
// positive control so a broken scan cannot pass by finding nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_CSS = path.join(__dirname, '..', '..', 'frontend', 'src', 'App.css');
const SIDEBAR_CSS = path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'Sidebar.css');

// ⚠ Comments are STRIPPED before scanning. The comment above the nav rule
// explains why `height: 56px` was wrong, and quoting the thing you are banning
// is enough to trip a scan that reads prose as a declaration — this test caught
// itself doing exactly that on its first run. Same species as the widget test
// that tripped on the backslashes in the comment describing the backslash rule.
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '');

const css = stripComments(fs.readFileSync(APP_CSS, 'utf8'));
const sidebarCss = stripComments(fs.readFileSync(SIDEBAR_CSS, 'utf8'));

test('the scan is looking at the real stylesheet (positive control)', () => {
  // If App.css moves or is renamed, every assertion below would pass by finding
  // nothing at all.
  assert.ok(css.includes('.main-panel'), 'App.css does not contain .main-panel — wrong file?');
  assert.ok(css.includes('mobile-bottom-nav'), 'App.css does not contain the bottom nav');
});

test('⚠ a panel can shrink below its content — .main-panel > * sets min-width: 0', () => {
  // `.main-panel` is a flex container. A flex item defaults to `min-width: auto`,
  // so it refuses to shrink below its content's intrinsic width — one long
  // unbreakable string (a URL, a Notion page id, a file path) then makes the
  // whole app wider than the phone and it scrolls sideways.
  const block = css.match(/\.main-panel\s*>\s*\*\s*\{([^}]*)\}/);
  assert.ok(block, '.main-panel > * rule is missing');
  assert.match(block[1], /min-width:\s*0/,
    'without min-width: 0 a long string makes the whole app scroll horizontally');
});

test('the bottom nav height and the space reserved for it come from ONE value', () => {
  // They were two unrelated numbers (56px and 60px). Nothing tied them together,
  // so they were free to drift — and the drift is invisible until content goes
  // missing under the bar.
  assert.match(css, /--bottom-nav-h:\s*\d+px/, 'no shared nav-height variable');

  const navBlock = css.match(/\.mobile-bottom-nav\s*\{[^}]*\}[\s\S]*?@media[^{]*\{[\s\S]*?\.mobile-bottom-nav\s*\{([^}]*)\}/);
  assert.ok(navBlock, 'could not find the mobile bottom nav rule');
  assert.match(navBlock[1], /var\(--bottom-nav-h\)/,
    'the nav must size itself from the shared variable');

  // And the reservation must be derived from the same one.
  assert.match(css, /padding-bottom:\s*calc\(var\(--bottom-nav-h\)/,
    'main-panel must reserve space from the shared variable, not a second number');
});

test('⚠ the nav uses min-height, not height — box-sizing is border-box', () => {
  // A fixed `height` INCLUDES the safe-area padding under border-box, so on a
  // phone with a 34px home-indicator inset the buttons were squeezed into 22px
  // and the bar's real height stopped matching what content reserved for it.
  const navBlocks = [...css.matchAll(/\.mobile-bottom-nav\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(navBlocks.length >= 2, 'expected a base rule and a mobile rule');
  for (const b of navBlocks) {
    assert.ok(!/[^-]\bheight:\s*\d+px/.test(b),
      'a fixed height swallows the safe-area padding under border-box — use min-height');
  }
  assert.ok(navBlocks.some((b) => /min-height:/.test(b)), 'the nav must set a min-height');
});

test('the safe-area inset is added ON TOP of the nav height, not folded into it', () => {
  // env() is 0 on a device without an inset, so this is correct in both cases —
  // but omitting it puts the last line under the home indicator on a phone.
  assert.match(css, /padding-bottom:\s*calc\(var\(--bottom-nav-h\)\s*\+\s*env\(safe-area-inset-bottom/);
});

test('the sidebar reserves the same space, from the same variable', () => {
  // It scrolls past the bottom nav too, and its last item was reachable only by
  // luck.
  assert.match(sidebarCss, /padding-bottom:\s*calc\(var\(--bottom-nav-h\)/,
    'the sidebar must not carry its own copy of the number');
});

test('nothing inside a panel may be wider than the panel', () => {
  // A chart, table or fenced block that genuinely needs the room scrolls in its
  // own box rather than taking the page with it.
  assert.match(css, /\.main-panel\s+pre[\s\S]{0,120}overflow-x:\s*auto/,
    'a wide <pre> must scroll itself, not the page');
  assert.match(css, /\.main-panel\s+svg[\s\S]{0,160}max-width:\s*100%/,
    'an SVG chart must be capped at the panel width');
});
