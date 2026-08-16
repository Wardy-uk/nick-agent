'use strict';

/**
 * #104 — the urgency window was a silent cap.
 *
 * The arm asked NOVA's escalation log for 90 days. An urgency escalation older
 * than that on a still-open ticket silently stopped being badged, and "still
 * open 91 days after being escalated" is exactly the ticket worth surfacing.
 *
 * Measured before changing anything: the log holds TWO manual escalations over
 * its whole life, both from 15 Aug 2026, and widening 90 → 3650 days moves
 * 1,935 rows to 2,352 while finding the same 2. Incidence today is zero. So the
 * load-bearing half is not the width — it is that the response NAMES the window
 * it used, which is what makes the count honest about its own edge.
 *
 * Source-level, deliberately: standing the route up means Jira and NOVA. What
 * can go wrong silently is the constant drifting back down and the window
 * disappearing from the payload, and both are visible here.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'escalation.js'), 'utf-8');

// Strip LINE comments before block comments. The other way round, a line
// comment legitimately containing `/*` opens a false block and swallows the
// rest of the file — after which every `includes()` fails by ABSENCE and a
// negative assertion would pass on nothing at all (mistakes.md, 16 Aug).
function stripComments(src) {
  const noLine = src.replace(/^[ \t]*\/\/.*$/gm, '');
  return noLine.replace(/\/\*[\s\S]*?\*\//g, '');
}

const CODE = stripComments(SRC);

test('the stripper left real code behind — the assertions below mean something', () => {
  assert.ok(CODE.includes('router.get(\'/active\''), 'the /active route survived the strip');
  assert.ok(CODE.includes('listEscalations'), 'the NOVA call survived the strip');
  assert.ok(CODE.length > 1000, 'stripped source is not gutted');
});

test('the urgency window is a named constant, not a literal at the call site', () => {
  assert.ok(/const URGENCY_WINDOW_DAYS = (\d+)/.test(CODE), 'URGENCY_WINDOW_DAYS is declared');
  assert.ok(
    /listEscalations\(\{\s*days:\s*URGENCY_WINDOW_DAYS/.test(CODE),
    'the call reads the constant rather than an inline number'
  );
});

test('the window is far wider than the 90 days that made it a cap', () => {
  const days = Number(CODE.match(/const URGENCY_WINDOW_DAYS = (\d+)/)[1]);
  // 90 was the bug. Anything that could plausibly age out is the bug again, so
  // this pins the intent ("the whole log") rather than the exact number.
  assert.ok(days >= 365 * 5, `window is ${days} days — must outlive the log`);
});

test('no bare 90-day window survives at the NOVA call', () => {
  assert.ok(
    !/listEscalations\(\{[^}]*days:\s*90\b/.test(CODE),
    'the 90-day literal must not come back at the call site'
  );
});

test('the response states the window it used', () => {
  // The half that matters even at zero incidence: a caller must be able to tell
  // a complete list from a truncated one without reading this file.
  assert.ok(/windowDays:\s*URGENCY_WINDOW_DAYS/.test(CODE), 'windowDays is reported from the constant');
  assert.ok(/\n\s*urgency,/.test(CODE), 'the urgency block is returned in the JSON body');
});

test('the arm reports which of its three states it reached', () => {
  // `off`, `error` and `ok` are different claims. Only `ok` means the count is
  // the whole population — collapsing them is how "NOVA is down" reads as
  // "there are no urgency escalations".
  assert.ok(/state:\s*'off'/.test(CODE), "defaults to 'off' when NOVA is unconfigured");
  assert.ok(/urgency\.state = 'ok'/.test(CODE), "marks 'ok' only after the call returns");
  assert.ok(/urgency\.state = 'error'/.test(CODE), "marks 'error' in the catch");
});

test("the client-side type filter is kept — an older NOVA ignores the query param", () => {
  // Verified live 17 Aug: asking for type=manual at days=90 returned 1,935 rows
  // of every type. Trusting the param would badge ~1,900 tier moves "urgency".
  assert.ok(
    /filter\(e => e\.escalation_type === 'manual'\)/.test(CODE),
    'rows are filtered to manual locally, not just in the query'
  );
  assert.ok(
    /logRows = raw\.length/.test(CODE) && /manual = logged\.length/.test(CODE),
    'both the raw and filtered counts are reported, so the gap between them is visible'
  );
});
