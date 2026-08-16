'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// #112 — the weekday and weekend system prompts were two independent literals,
// and they had already drifted in the way that matters: the weekend personality
// decayed to PROHIBITIONS only, keeping every rule that suppresses output and
// none that generates character. A model handed nothing but a ban list answers
// correctly and lifelessly, which is exactly what a Saturday "Hello there" came
// back as.
//
// The 15 Aug fix restated the traits by hand, leaving two copies to keep in step
// and a comment asking the next person to remember. These tests are the reason
// that is no longer necessary — they fail if the two ever stop sharing a source.

const SOURCE = fs.readFileSync(path.join(__dirname, 'claude.js'), 'utf8');

function block(name) {
  // Both prompts are template literals, so read the shared blocks out of source
  // rather than exporting internals purely to be testable.
  const m = SOURCE.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  assert.ok(m, `${name} should exist — #112 composes both prompts from it`);
  return m[1];
}

function promptBody(name) {
  const m = SOURCE.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
  assert.ok(m, `${name} should exist`);
  return m[1];
}

test('both prompts are composed from the shared blocks, not re-typed', () => {
  const weekday = promptBody('SYSTEM_PROMPT');
  const weekend = promptBody('WEEKEND_SYSTEM_PROMPT');

  for (const shared of ['${CORE_TRAITS}', '${CORE_RULES}', '${IDENTITY}']) {
    assert.ok(weekday.includes(shared), `weekday prompt must interpolate ${shared}`);
    assert.ok(weekend.includes(shared), `weekend prompt must interpolate ${shared}`);
  }
});

test('the shared traits are GENERATIVE, not just a ban list', () => {
  // This is the actual failure mode. A block of "never do X" is what the weekend
  // prompt decayed into, and it is why the output went lifeless while still
  // being technically compliant.
  const traits = block('CORE_TRAITS');
  const lines = traits.split('\n').filter(l => l.trim().startsWith('-'));
  assert.ok(lines.length >= 5, 'the personality needs enough traits to be a personality');

  const prohibitions = lines.filter(l => /\bnever\b|\bdon't\b|\bdo not\b/i.test(l));
  assert.ok(
    prohibitions.length < lines.length / 2,
    'CORE_TRAITS is the block that generates character — if most of it is prohibitions, '
    + 'the weekend regression has happened again'
  );
});

test('character-carrying traits appear in both modes', () => {
  const traits = block('CORE_TRAITS');
  for (const trait of ['warm with edge', 'playfulness', 'Acknowledge wins', 'Decisive']) {
    assert.ok(
      new RegExp(trait, 'i').test(traits),
      `"${trait}" is shared personality — losing it from one mode is exactly the #112 bug`
    );
  }
});

test('the voice rules that must never differ live in one place', () => {
  const rules = block('CORE_RULES');
  assert.match(rules, /second person/i, 'talking TO Nick is not a weekday-only rule');
  assert.match(rules, /Never open with "Sure!"/);
  assert.match(rules, /Feel free to/);
});

test('the weekend prompt still says what makes it a weekend', () => {
  // Sharing must not flatten the difference — the point is one voice, two modes.
  const weekend = promptBody('WEEKEND_SYSTEM_PROMPT');
  assert.match(weekend, /It's the weekend/);
  assert.match(weekend, /noticing him, not his queue/);
});
