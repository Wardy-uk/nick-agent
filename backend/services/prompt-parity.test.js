'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const voice = require('./sara-voice');

// #112 — the weekday and weekend system prompts were two independent literals,
// and they had already drifted in the way that matters: the weekend personality
// decayed to PROHIBITIONS only, keeping every rule that suppresses output and
// none that generates character. A model handed nothing but a ban list answers
// correctly and lifelessly, which is exactly what a Saturday "Hello there" came
// back as.
//
// 16 Aug 2026 — the same drift was loose across the whole system. Chat had a
// carefully written personality; the standup carried its own copy, the briefing
// had a one-line "you are SARA, an executive AI assistant", and the journal had
// no voice at all. The three surfaces where SARA talks to Nick about his day
// were the three furthest from who she is supposed to be. The blocks now live in
// sara-voice.js and these tests pin every consumer to them.

const HERE = __dirname;
const src = f => fs.readFileSync(path.join(HERE, f), 'utf8');

test('both chat prompts are composed from the shared blocks, not re-typed', () => {
  const claude = src('claude.js');
  const body = name => {
    const m = claude.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
    assert.ok(m, `${name} should exist`);
    return m[1];
  };

  const weekday = body('SYSTEM_PROMPT');
  const weekend = body('WEEKEND_SYSTEM_PROMPT');

  for (const shared of ['${CORE_TRAITS}', '${CORE_RULES}', '${IDENTITY}']) {
    assert.ok(weekday.includes(shared), `weekday prompt must interpolate ${shared}`);
    assert.ok(weekend.includes(shared), `weekend prompt must interpolate ${shared}`);
  }

  assert.match(
    claude,
    /require\('\.\/sara-voice'\)/,
    'claude.js must take the blocks from sara-voice, not declare its own'
  );
});

test('the shared traits are GENERATIVE, not just a ban list', () => {
  // This is the actual failure mode. A block of "never do X" is what the weekend
  // prompt decayed into, and it is why the output went lifeless while still
  // being technically compliant.
  const lines = voice.CORE_TRAITS.split('\n').filter(l => l.trim().startsWith('-'));
  assert.ok(lines.length >= 5, 'the personality needs enough traits to be a personality');

  const prohibitions = lines.filter(l => /\bnever\b|\bdon't\b|\bdo not\b/i.test(l));
  assert.ok(
    prohibitions.length < lines.length / 2,
    'CORE_TRAITS is the block that generates character — if most of it is prohibitions, '
    + 'the weekend regression has happened again'
  );
});

test('character-carrying traits are present', () => {
  for (const trait of ['warm with edge', 'playfulness', 'Acknowledge wins', 'Decisive', 'counterweight']) {
    assert.ok(
      new RegExp(trait, 'i').test(voice.CORE_TRAITS),
      `"${trait}" is shared personality — losing it from one mode is exactly the #112 bug`
    );
  }
});

test('the voice rules that must never differ live in one place', () => {
  assert.match(voice.CORE_RULES, /second person/i, 'talking TO Nick is not a weekday-only rule');
  assert.match(voice.CORE_RULES, /Never open with "Sure!"/);
  assert.match(voice.CORE_RULES, /Feel free to/);
  assert.match(voice.CORE_RULES, /Answer first/i, 'conclusion-first is the structure Nick asked for');
  assert.match(voice.CORE_RULES, /One question at a time/i);
  assert.match(voice.CORE_RULES, /No life-coaching/i, 'SARA is supportive through usefulness, not affirmations');
  assert.match(voice.CORE_RULES, /Never invent/i, 'truthfulness outranks appearing helpful');
});

test('the behaviours that are easiest to compress away are still there', () => {
  // The first pass at this module compressed Nick's ~2,000-word spec into ~25
  // lines and silently lost five things. These are the five, back in and pinned:
  // three general enough to belong to every surface...
  assert.match(voice.CORE_TRAITS, /missing middle/i, 'naming the real distinction, not observing that nuance exists');
  assert.match(voice.CORE_TRAITS, /Useful initiative, not constant activity/i);
  assert.match(voice.CORE_RULES, /second brain/i, 'she must use what she knows rather than re-asking for it');
  assert.match(voice.CORE_RULES, /according to my memory/i, 'using memory is not the same as announcing it');
});

test('the technical partner and the debugging method live in chat only', () => {
  // ...and two that are chat-specific on purpose. The standup does not debug
  // anything and the journal has no architecture to respect, so carrying these
  // in the shared block would spend tokens on every ritual message for nothing.
  const claude = src('claude.js');
  const weekday = claude.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];

  assert.match(weekday, /senior technical partner/i);
  assert.match(weekday, /small, reversible changes/i);
  assert.match(weekday, /Never claim something worked if it hasn't been tested/i);
  assert.match(weekday, /what we know → what we don't know/i, 'the debugging order is the method, not a mood');
  assert.match(weekday, /One hypothesis at a time/i);

  for (const chatOnly of ['senior technical partner', 'One hypothesis at a time']) {
    assert.ok(
      !voice.CORE_TRAITS.includes(chatOnly) && !voice.CORE_RULES.includes(chatOnly),
      `"${chatOnly}" belongs to chat — putting it in the shared block taxes every standup message`
    );
  }
});

test('the weekend prompt still says what makes it a weekend', () => {
  // Sharing must not flatten the difference — the point is one voice, two modes.
  const claude = src('claude.js');
  const weekend = claude.match(/const WEEKEND_SYSTEM_PROMPT = `([\s\S]*?)`;/)[1];
  assert.match(weekend, /It's the weekend/);
  assert.match(weekend, /noticing him, not his queue/);
});

test('the compact voice is compact, and is still SARA', () => {
  // The surfaces using it emit a sentence or two, sometimes on a 1.5b local
  // model with a 2048-token context. If this grows into a full spec it crowds
  // out the task and the output gets worse, not more characterful.
  assert.ok(
    voice.VOICE_COMPACT.length < 900,
    'VOICE_COMPACT must stay short enough to sit in front of a small-model task'
  );
  assert.match(voice.VOICE_COMPACT, /You are SARA/);
  assert.match(voice.VOICE_COMPACT, /second person/i);
  assert.match(voice.VOICE_COMPACT, /life-coaching/i);
});

test('a push notification is always from SARA, never from NEURO', () => {
  // NEURO is the brain; SARA is the half that COMES to Nick. A push is by
  // definition her arriving, so the sender is her name — the scheduler's six
  // jobs and the import pipeline all said "NEURO — ...", which put two different
  // senders on the same phone for the same system. Titles are display-only in
  // both service workers (they fall back to 'SARA'), so this is copy, not routing.
  const dirs = [path.join(HERE), path.join(HERE, '..', 'routes')];
  const offenders = [];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      // Only the sendToAll title argument matters — a log line saying NEURO is fine.
      for (const m of text.matchAll(/sendToAll\(\s*\n?\s*(['"`])([^'"`]*)\1/g)) {
        if (/^NEURO\b/.test(m[2])) offenders.push(`${f}: ${m[2]}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'these pushes introduce themselves as NEURO');
});

test('every surface where SARA speaks takes its voice from the one module', () => {
  // The list IS the point. A new surface that writes its own "You are SARA,
  // a helpful assistant" is the drift this module exists to stop, and it is
  // invisible until someone reads the output and finds it lifeless.
  const consumers = [
    'claude.js',                 // chat
    'standup-session.js',        // morning ritual + EOD
    'briefing.js',               // the push Nick reads first
    '../routes/journal.js',      // evening journal prompts
    '../routes/standup.js',      // legacy question generation (SARA app cards)
  ];

  for (const f of consumers) {
    assert.match(
      src(f),
      /require\((['"])(\.\.\/services\/|\.\/)sara-voice\1\)/,
      `${f} talks to Nick — it must take its voice from sara-voice.js`
    );
  }
});
