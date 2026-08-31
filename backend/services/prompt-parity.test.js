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


// ── Nick's own spec, merged 31 Aug 2026 ──────────────────────────────────────
//
// These pin the half that came from "SARA — Core Personality & Behaviour
// Prompt" (archived in the vault). They are here for the same reason the
// #112 pins are: every one of them is a GENERATIVE instruction, and generative
// instructions are what get quietly compressed away when someone tidies a
// prompt — leaving a technically-compliant ban list and a lifeless assistant.

test('the humour is licensed, not merely permitted', () => {
  // "Slight playfulness, dry and occasional" produced a SARA who never actually
  // made a joke. Nick's spec is explicit that she may take the piss, and that
  // the target is the humour of two people who know each other well.
  assert.match(voice.CORE_TRAITS, /take the piss/i);
  assert.match(voice.CORE_TRAITS, /never cruel/i, 'the licence has a limit and the limit is stated with it');
});

test('she has a point of view, and helping him decide is the job', () => {
  assert.match(voice.CORE_TRAITS, /point of view/i);
  assert.match(
    voice.CORE_TRAITS,
    /listing the options is what he could have done without you/i,
    'a menu is the failure mode this trait exists to prevent',
  );
});

test('she reads the register instead of narrating it', () => {
  assert.match(voice.CORE_TRAITS, /Attuned/i);
  assert.match(voice.CORE_TRAITS, /If he's joking, join in/i);
  // The two halves must travel together. Attunement without this rule becomes
  // "I can tell you're frustrated" — which is therapy-speak wearing a new hat,
  // and is exactly what "No life-coaching" already forbids.
  assert.match(voice.CORE_RULES, /never announce that you have noticed a feeling/i);
});

test('an ordinary bad afternoon is not a symptom', () => {
  // He is neurodivergent and the whole system is built around that, which makes
  // this the easiest possible slip: reading every flat hour as a condition.
  assert.match(voice.CORE_RULES, /Never medicalise/i);
  assert.match(voice.CORE_RULES, /not fragile/i);
});

test('a memory is never invented, and a gap is a complete answer', () => {
  assert.match(voice.CORE_RULES, /Never invent a memory/i);
  assert.match(voice.VOICE_COMPACT, /invent facts or memories/i, 'true on the small surfaces too');
});

test('REGISTERS exists and covers work, building, personal and stuck', () => {
  // The block that stopped SARA being only a work assistant. Everything else in
  // this module was written for the queue and the calendar, so with no work to
  // do she was accurate and lifeless — the #112 symptom arriving by a different
  // route.
  for (const register of ['Work', 'Building', 'Personal', 'Stuck']) {
    assert.match(
      voice.REGISTERS,
      new RegExp(`^- ${register}\\.`, 'm'),
      `"${register}" is one of the four registers and losing it narrows her back down`,
    );
  }
  assert.ok(voice.VOICE_FULL.includes(voice.REGISTERS), 'and the full voice must actually carry it');
});

test('building the over-elaborate thing is allowed to BE the point', () => {
  // The single most compressible line in the file, and the one that decides
  // whether she is a collaborator on NEURO or a reviewer of it.
  assert.match(voice.REGISTERS, /enjoyment is a legitimate requirement/i);
  assert.match(voice.REGISTERS, /IS the hobby/);
});

test('not everything personal needs an action', () => {
  assert.match(
    voice.REGISTERS,
    /sometimes the useful response is to be good company/i,
    'without this she optimises his hobbies at him',
  );
});

test('she knows the personal half is thin, and asks rather than inventing', () => {
  // Nick's own point: the vault is work-heavy, so she genuinely does not know
  // much about the rest of him. Saying so is what stops the gap being filled
  // with a plausible invented interest.
  assert.match(voice.WHO_IS_NICK, /he also has a life/i);
  assert.match(voice.WHO_IS_NICK, /ask rather than assume/i);
  assert.match(voice.WHO_IS_NICK, /Do not fill the gap by inventing an interest/i);
});

test('the self-check rides on the full voice, not just in a comment', () => {
  assert.match(voice.VOICE_FULL, /genuinely useful, or just sounding helpful/i);
});

// ── From Nick's ChatGPT memory export, 31 Aug 2026 ───────────────────────────
//
// He spotted the split himself: a large part of that dump was not FACTS about
// him but INSTRUCTIONS for how SARA should behave. Those belong in the voice,
// not in a profile she reads as facts. Three were genuinely new, and all three
// describe a specific way of being annoying that he has evidently met before.

test('a rejected constraint stays rejected', () => {
  // "not black", and three messages later she offers the black one. The
  // clearest possible proof of not listening, and it survives any amount of
  // otherwise-good conversation.
  assert.match(voice.CORE_RULES, /REJECTED CONSTRAINT STAYS REJECTED/);
  assert.match(voice.CORE_RULES, /unless he changes it himself/i);
});

test('once he has said go, she goes', () => {
  assert.match(voice.CORE_RULES, /ONCE HE HAS SAID GO/);
  assert.match(voice.CORE_RULES, /friction dressed up as diligence/i);
  // ⚠ The carve-out has to travel WITH it, or this rule quietly cancels the
  // confirm-before-irreversible rule the outbound paths depend on.
  assert.match(voice.CORE_RULES, /irreversible or outward-facing/i);
});

test('considering is not owning', () => {
  // Without this she ends up believing he owns every product he has ever asked
  // about, and recommending accessories for a car he did not buy.
  assert.match(voice.CORE_RULES, /CONSIDERING IS NOT OWNING/);
  assert.match(voice.CORE_RULES, /state that expires/i);
});

test('memory is used to ANSWER, not merely to recall', () => {
  // The distinction between a database of facts and a second brain. Asked about
  // a walk she should already be accounting for the dog, the terrain, the
  // distance and the fact he overheats.
  assert.match(voice.CORE_RULES, /use it to ANSWER, not merely to recall/i);
});

test('the answer is sized to the question', () => {
  assert.match(voice.CORE_RULES, /Match the size of the answer to the size of the question/i);
});

test('CORE_TRAITS is still majority generative after all of this', () => {
  // Every rule above is a prohibition or a constraint, and they all went into
  // CORE_RULES on purpose. If they had gone into CORE_TRAITS the #112
  // regression — a personality that is nothing but a ban list — would be back.
  const lines = voice.CORE_TRAITS.split('\n').filter(l => l.trim().startsWith('-'));
  const prohibitions = lines.filter(l => /\bnever\b|\bdon't\b|\bdo not\b/i.test(l));
  assert.ok(prohibitions.length < lines.length / 2);
});
