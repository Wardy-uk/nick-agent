'use strict';

/**
 * SARA opens the End of Day.
 *
 * The old notification was an instruction — "End of day. Before you close the
 * laptop: one win, one thing that didn't go to plan... Standup tab → EOD." That
 * tells him a ritual is due; it is not SARA saying anything. Now the session is
 * started server-side first so her actual opening line exists BEFORE the
 * notification does, and that line is what he reads.
 *
 * The two pure halves are pinned here. The delivery path is covered by the
 * fallback test at the bottom, which is the one that matters most: a clever
 * opener is never worth losing the prompt over.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-eod-'));
process.env.NEURO_DB_PATH = path.join(root, 'a.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(process.env.OBSIDIAN_VAULT_PATH, { recursive: true });

const db = require('../db/database');
const nudges = require('./nudges');

// `triggerEodNudge` reads and writes the "already nudged today" key.
test.before(async () => { await db.init(); });

// ── Is he already in it? ─────────────────────────────────────────────────────

test('the seeded opener is not Nick talking', () => {
  // `start()` pushes one synthetic user message to open the turn. Reading that
  // as engagement would mean SARA never opens the EOD at all.
  const justStarted = {
    messages: [
      { role: 'user', content: "Let's do my end of day." },
      { role: 'assistant', content: 'How was today?' },
    ],
  };
  assert.equal(nudges._alreadyTalking(justStarted), false);
});

test('a conversation already under way is NOT interrupted', () => {
  // He started the EOD himself at four. A push at five saying "how was your
  // day?" into a chat he is already in reads as SARA not listening.
  const inFlight = {
    messages: [
      { role: 'user', content: "Let's do my end of day." },
      { role: 'assistant', content: 'How was today?' },
      { role: 'user', content: 'Long. Shipped the dedupe work.' },
    ],
  };
  assert.equal(nudges._alreadyTalking(inFlight), true);
});

test('a missing or malformed session is not mistaken for a conversation', () => {
  assert.equal(nudges._alreadyTalking(null), false);
  assert.equal(nudges._alreadyTalking({}), false);
  assert.equal(nudges._alreadyTalking({ messages: 'nope' }), false);
});

// ── The opening line ─────────────────────────────────────────────────────────

test('a short opener goes out whole', () => {
  const session = { messages: [{ role: 'assistant', content: 'How was today?' }] };
  assert.equal(nudges._openingLine(session), 'How was today?');
});

test('a long opener is cut on a SENTENCE, never mid-word', () => {
  // A notification that stops halfway through her first thought reads as broken
  // rather than brief. The full opening is in the session either way.
  const session = {
    messages: [{
      role: 'assistant',
      content: 'How was today? I can see you shipped the dedupe work and got out for a walk. '
        + 'Anything that did not go the way you wanted? There is also something I want to own up to.',
    }],
  };
  const line = nudges._openingLine(session);
  assert.ok(line.length <= 180);
  assert.ok(line.endsWith('?') || line.endsWith('.'), `cut on a sentence, got: ${line}`);
  assert.ok(!line.includes('…') && !line.endsWith('...'), 'no ellipsis');
  assert.ok(line.startsWith('How was today?'));
});

test('one very long sentence is sent whole rather than severed', () => {
  const long = `How was today, because ${'x'.repeat(300)}?`;
  const line = nudges._openingLine({ messages: [{ role: 'assistant', content: long }] });
  assert.equal(line, long, 'a slightly long notification beats a severed one');
});

test('it takes the LATEST thing she said, not the first', () => {
  const session = {
    messages: [
      { role: 'assistant', content: 'Older.' },
      { role: 'user', content: 'x' },
      { role: 'assistant', content: 'Newer.' },
    ],
  };
  assert.equal(nudges._openingLine(session), 'Newer.');
});

test('nothing to say is null, so the caller falls back rather than sending blank', () => {
  assert.equal(nudges._openingLine({ messages: [] }), null);
  assert.equal(nudges._openingLine({ messages: [{ role: 'user', content: 'hi' }] }), null);
  assert.equal(nudges._openingLine(null), null);
  assert.equal(nudges._openingLine({ messages: [{ role: 'assistant', content: '   ' }] }), null);
});

// ── The refusal that matters most ────────────────────────────────────────────

test('⚠ an AI failure falls back to the old wording, never to silence', async () => {
  // Starting the session is an AI call and an AI call can fail — no credit, rate
  // limit, provider down. A missed EOD is the thing this exists to prevent, and
  // a clever opener is not worth losing it over.
  const standupSession = require('./standup-session');
  const webpush = require('./webpush');
  const workingDays = require('./working-days');

  const realStart = standupSession.start;
  const realSend = webpush.sendToAll;
  const realHolidays = workingDays.holidaySet;
  const sent = [];

  standupSession.start = async () => { throw new Error('no credit'); };
  webpush.sendToAll = async (title, body) => { sent.push({ title, body }); };
  // ⚠ Without this the test is clock-dependent and passes or fails by the
  // calendar: it was written on 31 Aug 2026, the Summer bank holiday, and
  // `nudgeSuppression()` CORRECTLY skipped the whole nudge. That is the feature
  // working, not a bug — but a test that only runs on a working day is a test
  // that lies twice a year.
  workingDays.holidaySet = () => new Set();

  try {
    await nudges.triggerEodNudge();
  } finally {
    standupSession.start = realStart;
    webpush.sendToAll = realSend;
    workingDays.holidaySet = realHolidays;
  }

  assert.equal(sent.length, 1, 'the prompt still went out');
  assert.match(sent[0].body, /End of day/, 'and it fell back to the wording that always worked');
  assert.equal(sent[0].title, 'SARA');
});
