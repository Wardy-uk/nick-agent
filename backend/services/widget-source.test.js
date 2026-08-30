'use strict';

/**
 * The Scriptable widget must survive a copy/paste through Safari.
 *
 * It is the one file in this repo that reaches its runtime by being COPIED as
 * TEXT — scanned off a QR, selected in Safari, pasted into Scriptable — rather
 * than deployed. A backslash does not reliably survive that trip: `/\/+$/`
 * arrived on Nick's phone as a syntax error and the whole widget refused to
 * parse, which reads exactly like "the widget is broken" rather than "the
 * transport ate a character".
 *
 * Same species as the mistakes-log entry about regex-bearing JS in a heredoc.
 * The fix there was "don't send it through the pipeline"; here the pipeline is
 * unavoidable, so the file has to be written to survive it.
 *
 * Lives in backend/services because `node --test` is only run from backend/ —
 * it is not a backend service, and this comment is here so nobody moves it
 * somewhere "tidier" where it would silently stop running.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const WIDGET_DIR = path.join(__dirname, '..', '..', 'sara', 'widget');
const WIDGET = path.join(WIDGET_DIR, 'neuro-attention.js');

function source() {
  return fs.readFileSync(WIDGET, 'utf8');
}

/**
 * EVERY Scriptable file, not just the widget.
 *
 * The first version of this test named one file, so when a second script landed
 * in the same directory — reaching the phone by the same copy-and-paste route,
 * with exactly the same backslash hazard — it was unguarded, and only the phone
 * would have discovered a syntax error in it. A rule that protects the file it
 * was written for and nothing else is one that gets out of date on the first
 * addition.
 */
function scriptableFiles() {
  return fs.readdirSync(WIDGET_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ name: f, path: path.join(WIDGET_DIR, f) }));
}

test('the widget file exists where the tests expect it', () => {
  // Positive control: without this, every assertion below would pass by
  // absence the moment the file moved.
  assert.ok(fs.existsSync(WIDGET), `expected the widget at ${WIDGET}`);
  assert.ok(source().length > 5000, 'widget source looks truncated');
});

test('there is more than one Scriptable file, and the scan sees them all', () => {
  // Positive control for the two tests below. Without it, a broken readdir or a
  // moved directory would make them pass by iterating nothing at all — the same
  // way an invented metric name returns zero rows and proves nothing.
  const files = scriptableFiles();
  assert.ok(files.length >= 2, `expected at least two Scriptable files, found ${files.length}`);
  assert.ok(files.some((f) => f.name === 'neuro-attention.js'));
});

test('NO Scriptable file contains a backslash anywhere', () => {
  const offenders = [];
  for (const file of scriptableFiles()) {
    const lines = fs.readFileSync(file.path, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].indexOf(String.fromCharCode(92)) !== -1) {
        offenders.push(`  ${file.name} line ${i + 1}: ${lines[i].trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders, [],
    'Backslashes do not survive the copy/paste trip to Scriptable. Use '
    + 'String.fromCharCode() for control characters, split/join instead of '
    + 'regex replace, and endsWith/slice instead of anchored patterns.\n'
    + offenders.join('\n')
  );
});

test('every Scriptable file parses as JavaScript', () => {
  // Nothing require()s these, so without this test only the phone would ever
  // discover a syntax error. Wrapped in an async body because they use
  // top-level await, exactly as Scriptable runs them.
  for (const file of scriptableFiles()) {
    const src = fs.readFileSync(file.path, 'utf8');
    assert.doesNotThrow(
      () => new Function(`return (async () => { ${src} })`),
      `${file.name} does not parse`
    );
  }
});

test('the version marker is present and bumped shape', () => {
  // The marker is what makes "did my edit land?" answerable on the phone at a
  // glance; losing it costs a diagnostic round trip, which it already has once.
  assert.match(source(), /const VERSION = 'v\d+';/, 'VERSION constant missing');
});

test('the token is never hardcoded in the widget', () => {
  // The repo is public. The PIN leaked this way in July; this file is the one
  // most likely to reacquire a credential, because pasting one in is the
  // quickest way to make it work on the phone.
  const src = source();
  assert.ok(src.indexOf('Keychain.get') !== -1, 'widget should read the token from the Keychain');
  assert.ok(
    !/X-NEURO-API-TOKEN['"]\s*:\s*['"][A-Za-z0-9]{8,}/.test(src),
    'a literal token appears to be embedded in the widget'
  );
});

test('the field is informative, not decorative — its coherence tracks the read', () => {
  // sara/app's Field.jsx rule, carried into the widget: THE COHERENCE ON SCREEN
  // IS THE COHERENCE OF THE READ. A widget cannot animate, so it renders one
  // frame — and that frame still has to be honest. If the pool is unreadable
  // there must be NO mesh at all, because a confident-looking picture over a
  // failed read is the false all-clear this whole layer exists to prevent.
  // ⚠ Slice from the ALPHA CONSTANTS, not from `function field(`. They sit
  // above it, so starting at the function excluded them — field() then threw a
  // ReferenceError, caught it, and returned null, and the test failed on a
  // missing property rather than on anything about the widget. An extraction
  // that silently drops a dependency fails for the wrong reason.
  const src = source();
  const body = src.slice(src.indexOf('// ⚠ These are NOT'), src.indexOf('function dial('));

  const stub = {
    DrawContext: function () {
      this._d = 0; this._e = 0;
      this.setFillColor = () => {}; this.setStrokeColor = () => {}; this.setLineWidth = () => {};
      this.fillEllipse = () => { this._d++; }; this.addPath = () => {}; this.strokePath = () => { this._e++; };
      this.getImage = () => ({ dots: this._d, edges: this._e });
    },
    Size: function (w, h) { this.w = w; this.h = h; },
    Rect: function () {}, Point: function () {}, Color: function () {},
    Path: function () { this.move = () => {}; this.addLine = () => {}; },
  };
  const make = new Function(...Object.keys(stub), body + '; return { field, fieldDrive };');
  const { field, fieldDrive } = make(...Object.values(stub));

  const run = (d) => field(330, 350, fieldDrive(d, {}));

  const blind = run({ poolAvailable: false, context: {} });
  assert.equal(blind.edges, 0, 'an unreadable pool must show no coherence at all');
  assert.ok(blind.dots > 0, 'the substrate is still there — noise, not emptiness');

  // ⚠ AVERAGED, because the field seeds itself with Math.random() — each call
  // is a different layout, so comparing two single renders is a coin toss on
  // the margins. It flaked exactly that way: green five runs in a row, red on
  // the sixth. A test that fails one time in ten trains you to ignore it.
  const meanEdges = (d) => {
    let total = 0;
    for (let i = 0; i < 8; i++) total += run(d).edges;
    return total / 8;
  };
  const high = meanEdges({ poolAvailable: true, context: { confidence: { level: 'high' } } });
  const low = meanEdges({ poolAvailable: true, context: { confidence: { level: 'low' } } });
  assert.ok(high > low * 1.1,
    `a confident read must settle further than an unsure one (${high.toFixed(0)} vs ${low.toFixed(0)})`);

  // Quiet dims rather than disconnects — she is present and staying out of the way.
  const quiet = fieldDrive({ poolAvailable: true, quiet: true, context: {} }, {});
  const confident = fieldDrive({ poolAvailable: true, context: { confidence: { level: 'high' } } }, {});
  // Expressed as a RELATIONSHIP, not a magic number. The first version asserted
  // dim < 0.6, which was only ever the value of the day — so raising the
  // visibility floor to stop her vanishing on a quiet weekend failed a test
  // that had no opinion about visibility at all.
  assert.ok(quiet.dim < confident.dim, 'quiet must be dimmer than a confident read');
  assert.ok(quiet.depth < confident.depth, 'and must settle less');
  assert.ok(quiet.depth > 0, 'quiet is not the same as blind');
});

test('the widget renders no orb, avatar or glyph', () => {
  // MANIFESTATION.md deprecates every one of those permanently: SARA is not an
  // object and there is no "where SARA is". I proposed three orbs before being
  // corrected, so this is here to stop the next attempt.
  //
  // ⚠ No regex here. The first version built one from a template literal, where
  // a lone backslash is swallowed — `\s` became `s`, so the pattern could never
  // match and the test passed by being broken. Exactly the untested-pattern
  // trap already in mistakes.md, and a substring check needs no escaping at all.
  const src = source();
  const declares = (name) => ['function ', 'const ', 'let '].some((kw) =>
    src.toLowerCase().indexOf(kw + name) !== -1);

  for (const banned of ['orb', 'avatar', 'nebula']) {
    assert.ok(!declares(banned), `the widget defines a ${banned} — she is a field, not an object`);
  }

  // Positive control: the check must be capable of finding something. Without
  // this, a typo'd helper would make every assertion above pass by absence.
  assert.ok(declares('field'), 'the guard cannot detect a declaration at all');
});

test('quiet is dimmed, never invisible', () => {
  // Nick: "we've lost SARA". She was being drawn the whole time, at 8% opacity
  // for the nodes and 5% for the edges, because Field.jsx's dim values were
  // lifted wholesale — and that canvas is full-screen, where a huge area of
  // very faint texture still reads. On a 330x350 tile against a near-black card
  // it crossed from dimmed into absent.
  //
  // Absent is the one thing quiet must never look like: quiet means she is here
  // and staying out of the way, and rendering nothing says she has gone.
  const src = source();
  const body = src.slice(src.indexOf('// ⚠ These are NOT'), src.indexOf('function dial('));

  let seen = [];
  const stub = {
    DrawContext: function () {
      this.setFillColor = (c) => seen.push(['node', c.a]);
      this.setStrokeColor = (c) => seen.push(['edge', c.a]);
      this.setLineWidth = () => {}; this.fillEllipse = () => {};
      this.addPath = () => {}; this.strokePath = () => {};
      this.getImage = () => ({});
    },
    Size: function () {}, Rect: function () {}, Point: function () {},
    Path: function () { this.move = () => {}; this.addLine = () => {}; },
    Color: function (h, a) { this.h = h; this.a = a; },
  };
  const { field, fieldDrive } = new Function(
    ...Object.keys(stub), body + '; return { field, fieldDrive };'
  )(...Object.values(stub));

  const alphas = (d) => {
    seen = [];
    field(330, 350, fieldDrive(d, {}));
    const node = seen.filter((x) => x[0] === 'node').map((x) => x[1]);
    const edge = seen.filter((x) => x[0] === 'edge').map((x) => x[1]);
    return { node: node.length ? node[0] : 0, edge: edge.length ? Math.max(...edge) : 0 };
  };

  const quiet = alphas({ poolAvailable: true, quiet: true, context: {} });
  assert.ok(quiet.node >= 0.18, `quiet nodes at ${quiet.node} are effectively invisible`);
  assert.ok(quiet.edge >= 0.10, `quiet edges at ${quiet.edge} are effectively invisible`);

  // Dimmer than a confident read, though — quiet still has to LOOK quiet.
  const high = alphas({ poolAvailable: true, context: { confidence: { level: 'high' } } });
  assert.ok(high.node > quiet.node && high.edge > quiet.edge,
    'a confident read must be visibly stronger than a quiet one');

  // And blind still has no mesh at all — visibility must not have bought
  // coherence where there is none.
  const blind = alphas({ poolAvailable: false, context: {} });
  assert.equal(blind.edge, 0, 'an unreadable pool must still show no coherence');
  assert.ok(blind.node > 0, 'the substrate is still there — noise, not emptiness');
});
