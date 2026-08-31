'use strict';

/**
 * VESTA's fridge photo — the rules, without an API key, a network or a clock.
 *
 * The judgement here is entirely in three pure functions, which is why they are
 * pure: what counts as a readable answer, where an item is allowed to land, and
 * whether she has any allowance left.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const vision = require('./vesta-vision');

const SECTIONS = ['Fridge', 'Freezer', 'Cupboard'];

// ── The answer is read honestly, or not at all ───────────────────────────────

test('a plain JSON array is read', () => {
  const r = vision.parseProposal('[{"name":"eggs","section":"Fridge"}]', SECTIONS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, [{ name: 'eggs', section: 'Fridge' }]);
});

test('a fenced array is read, because models fence things', () => {
  const r = vision.parseProposal('```json\n[{"name":"milk","section":"Fridge"}]\n```', SECTIONS);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].name, 'milk');
});

test('prose either side of the array does not stop it being read', () => {
  const r = vision.parseProposal('Here is what I can see:\n[{"name":"bread","section":"Cupboard"}]\nHope that helps.', SECTIONS);
  assert.equal(r.ok, true);
  assert.equal(r.items[0].name, 'bread');
});

/**
 * ⚠ THE test. An unreadable answer must never come back as an empty list.
 *
 * "I couldn't read the photo" and "there is no food in the photo" are different
 * facts, and the whole of VESTA is built on keeping that pair apart. An empty
 * array here would be rendered to her as a fridge she has just been told is
 * bare, off the back of a model failure.
 */
test('an unreadable answer REFUSES rather than returning an empty list', () => {
  for (const bad of ['', 'I am not able to help with that.', '{"name":"eggs"}', 'null']) {
    const r = vision.parseProposal(bad, SECTIONS);
    assert.equal(r.ok, false, `"${bad.slice(0, 20)}" must not read as an empty fridge`);
    assert.ok(r.why, 'and it must say why');
  }
});

test('a TRUNCATED array refuses — it does not silently keep the part that parsed', () => {
  // The shape a too-small max_tokens produces, and the reason the cap is
  // generous. Email triage lost whole runs to exactly this.
  const r = vision.parseProposal('[{"name":"eggs","section":"Fridge"},{"name":"chi', SECTIONS);
  assert.equal(r.ok, false);
});

test('an empty array is a real answer, and is NOT a failure', () => {
  // An empty worktop exists. This is the one "nothing" that is honest.
  const r = vision.parseProposal('[]', SECTIONS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, []);
});

// ── Where an item is allowed to land ─────────────────────────────────────────

test('a section is matched case-insensitively against the REAL sections', () => {
  assert.equal(vision.placeSection('freezer', SECTIONS), 'Freezer');
  assert.equal(vision.placeSection('Fridge', SECTIONS), 'Fridge');
});

/**
 * ⚠ An invented section becomes null, never itself.
 *
 * `catalogue.addItem` refuses a section it does not know, so passing "Larder"
 * through would fail at the moment she taps Confirm — with the error attached
 * to the item rather than to the guess that caused it. Null renders as "you
 * choose" and costs one tap.
 */
test('a section the catalogue does not have becomes null, not itself', () => {
  assert.equal(vision.placeSection('Larder', SECTIONS), null);
  assert.equal(vision.placeSection('', SECTIONS), null);
  assert.equal(vision.placeSection(null, SECTIONS), null);

  const r = vision.parseProposal('[{"name":"rice","section":"Larder"}]', SECTIONS);
  assert.equal(r.items[0].section, null);
});

test('the same thing seen twice is one line', () => {
  const r = vision.parseProposal('[{"name":"Eggs","section":"Fridge"},{"name":"eggs","section":"Fridge"}]', SECTIONS);
  assert.equal(r.items.length, 1);
});

test('a nameless entry is dropped rather than added blank', () => {
  const r = vision.parseProposal('[{"name":"","section":"Fridge"},{"name":"peas","section":"Freezer"}]', SECTIONS);
  assert.deepEqual(r.items, [{ name: 'peas', section: 'Freezer' }]);
});

// ── The allowance ────────────────────────────────────────────────────────────

test('the cap counts a rolling 24 hours, not a total that never forgets', () => {
  const now = Date.now();
  const yesterday = now - 30 * 3600 * 1000;
  // Ten from yesterday must not count against today.
  const stamps = [...Array(10)].map(() => yesterday);
  const r = vision.withinCap(stamps, now, 12);
  assert.equal(r.ok, true);
  assert.equal(r.used, 0);
});

test('the cap refuses once it is reached, and says how many', () => {
  const now = Date.now();
  const stamps = [...Array(12)].map((_, i) => now - i * 1000);
  const r = vision.withinCap(stamps, now, 12);
  assert.equal(r.ok, false);
  assert.equal(r.used, 12);
  assert.equal(r.cap, 12);
});

test('no history at all is not an error', () => {
  assert.equal(vision.withinCap(undefined, Date.now(), 12).ok, true);
  assert.equal(vision.withinCap(null, Date.now(), 12).ok, true);
});

// ── The gate ─────────────────────────────────────────────────────────────────

/**
 * ⚠ Nick's own condition: this comes last, after the typed path is proven. The
 * flag is how that is respected in code, and OFF is the default — same idiom as
 * DAY_PLANNER_ENABLED and NOTION_SYNC_ENABLED.
 */
test('the feature is OFF unless explicitly switched on', () => {
  const before = process.env.VESTA_PHOTO_ENABLED;
  try {
    delete process.env.VESTA_PHOTO_ENABLED;
    assert.equal(vision.isEnabled(), false, 'unset means off');
    process.env.VESTA_PHOTO_ENABLED = 'false';
    assert.equal(vision.isEnabled(), false);
    process.env.VESTA_PHOTO_ENABLED = '1';
    assert.equal(vision.isEnabled(), false, 'only the literal word switches it on');
    process.env.VESTA_PHOTO_ENABLED = 'true';
    assert.equal(vision.isEnabled(), true);
  } finally {
    if (before === undefined) delete process.env.VESTA_PHOTO_ENABLED;
    else process.env.VESTA_PHOTO_ENABLED = before;
  }
});

test('a disabled feature refuses BEFORE it looks at anything else', async () => {
  const before = process.env.VESTA_PHOTO_ENABLED;
  try {
    delete process.env.VESTA_PHOTO_ENABLED;
    const r = await vision.proposeFromPhoto({ username: 'p', imageBase64: 'x', mediaType: 'image/jpeg', sections: SECTIONS });
    assert.equal(r.ok, false);
    assert.equal(r.disabled, true);
  } finally {
    if (before === undefined) delete process.env.VESTA_PHOTO_ENABLED;
    else process.env.VESTA_PHOTO_ENABLED = before;
  }
});

test('an unsupported file type and an oversized photo are refused in words', async () => {
  const before = process.env.VESTA_PHOTO_ENABLED;
  process.env.VESTA_PHOTO_ENABLED = 'true';
  try {
    const bad = await vision.proposeFromPhoto({ username: 'p', imageBase64: 'x', mediaType: 'application/pdf', sections: SECTIONS });
    assert.equal(bad.ok, false);
    assert.match(bad.why, /picture/);

    // Comfortably over MAX_BYTES once base64 is decoded.
    const huge = 'A'.repeat(Math.ceil((vision.MAX_BYTES + 1024) * 4 / 3));
    const big = await vision.proposeFromPhoto({ username: 'p', imageBase64: huge, mediaType: 'image/jpeg', sections: SECTIONS });
    assert.equal(big.ok, false);
    assert.match(big.why, /too big/);
  } finally {
    if (before === undefined) delete process.env.VESTA_PHOTO_ENABLED;
    else process.env.VESTA_PHOTO_ENABLED = before;
  }
});

// ── The prompt ───────────────────────────────────────────────────────────────

test('the prompt names the real sections and licenses null', () => {
  const prompt = vision.buildPrompt(SECTIONS);
  for (const s of SECTIONS) assert.match(prompt, new RegExp(s));
  assert.match(prompt, /null/, 'the model must be allowed to decline to place something');
  assert.match(prompt, /empty array/, 'and an empty shelf must have an expressible answer');
});

/**
 * The prompt is what stops the list filling with guesses. If these instructions
 * are ever dropped, the failure is silent and looks like a worse model.
 */
test('the prompt forbids inference and brands', () => {
  const prompt = vision.buildPrompt(SECTIONS);
  assert.match(prompt, /Only what is visible/);
  assert.match(prompt, /leave it out rather than guessing/);
  assert.match(prompt, /not the brand/);
});
