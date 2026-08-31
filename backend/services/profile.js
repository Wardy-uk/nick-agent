'use strict';

/**
 * What SARA knows about Nick as a person.
 *
 * ── The measurement that made this necessary ────────────────────────────────
 * Taken 31 Aug 2026, across ~6,000 vault notes:
 *
 *   Meetings 263 · Plaud 417 · People 42 · Projects 14 folders
 *   Personal/ ......... 6 notes, ALL of them disciplinary prep, GP appointment
 *                       prep and occupational health. Work-adjacent and
 *                       sensitive, not "who Nick is".
 *   Non-work anything . ONE. `Projects/D&D`.
 *
 * So `WHO_IS_NICK` telling her the record is work-heavy and to ask rather than
 * assume was not hedging. It was the literal state: she can see his body, his
 * diary and his laptop, and has no idea what he would want to do with a free
 * evening.
 *
 * ── Why it is not a form ────────────────────────────────────────────────────
 * The obvious fix is an "About Me" note he maintains. It would rot. His failure
 * mode is avoidance and drift, and everything in this system that WORKS follows
 * one rule instead: *detected, not declared*. Who reports to him is read from
 * People notes. 1-2-1s are detected from meeting notes. Wins are detected —
 * that one exists precisely BECAUSE the hand-typed version recorded four
 * completions in a month he shipped 271 commits in.
 *
 * Nick's own design (31 Aug): seed it from the memory Claude and ChatGPT have
 * already accumulated, enrich it with a one-time interview run from NEURO, and
 * let SARA add to it as she learns. So the only typing is a paste and one
 * conversation, and after that it grows by being used.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 * ⚠ **EVERY FACT CARRIES ITS SOURCE.** A line from a ChatGPT memory dump is
 * weaker evidence than something he said last Tuesday, and SARA must be able to
 * tell — "I think you mentioned" is a different sentence from "you told me".
 * Nothing goes in unattributed.
 *
 * ⚠ **NOTHING IS INVENTED.** The seed ingest RESTRUCTURES prose into facts and
 * may not add one. A profile that quietly acquires an interest he does not have
 * is worse than an empty one, because he would have no reason to distrust it.
 *
 * ⚠ **IT IS NOT `Personal/`.** That folder holds the disciplinary prep, the
 * fraud investigation and three occupational-health documents, and VESTA refuses
 * it outright. Hobbies do not belong next to an OH report, and this note should
 * not inherit that refusal for the wrong reason. It lives in `Me/`.
 *
 * ⚠ **NEVER SHARED.** Not to VESTA, not to a catalogue, not anywhere outside
 * NEURO. It is the most personal thing in the vault by construction.
 *
 * ⚠ **It must actually be CONSUMED.** Three separate things were found today
 * that computed something nothing ever read — `health-signals`' trends, the Jira
 * cache's readers, the ambient layer before it was wired. A profile nothing
 * injects is the same bug with a friendlier name, so `contextBlock()` exists and
 * is wired into chat before anything else here is worth having.
 *
 * PURE where it judges: `parse`, `render` and `contextBlock` take plain data.
 *
 * CommonJS — NEURO backend convention.
 */

const fs = require('fs');
const path = require('path');

const PROFILE_PATH = 'Me/About Nick.md';

// The shape of a person, roughly. Sections are FIXED rather than free-form so
// the interview knows what it is still missing and `contextBlock` can decide
// what is worth the tokens — but an unrecognised heading in the file is kept,
// because he will add his own and losing it would teach him not to.
const SECTIONS = [
  'Outside work',
  'People who matter',
  'How I work',
  'What drains me',
  'What I care about',
  'Health and body',
  'Preferences',
];

// How a fact got here, weakest first. The wording SARA uses depends on it.
const SOURCES = ['seed', 'interview', 'conversation', 'observed', 'nick'];

const MAX_FACT = 300;

// ⚠ `render` writes this, so `parse` MUST skip it. Left unrecognised it is
// preserved into `preamble`, re-rendered under the header, and read back on the
// next save — one more copy per write, for ever. Exactly the bug found in
// `catalogue.js` the same morning, and the same species as the outcome-note
// fence: a placeholder the system wrote must never read back as user content.
// The stability test compares the rendered TEXT, because comparing parsed fields
// is blind to it.
const INTRO = [
  '> What SARA knows about Nick as a person, as opposed to as Head of Technical',
  '> Support. Every line says where it came from. Edit or delete anything —',
  '> she reads this file, she does not own it.',
];
const EMPTY_MARK = '*(nothing yet)*';

// ── Pure ─────────────────────────────────────────────────────────────────────

/**
 * Parse the profile. PURE.
 *
 * Format is the plainest markdown that survives hand-editing in Obsidian:
 *
 *     ## Outside work
 *     - Plays D&D, runs a campaign <!--p:interview 2026-08-31-->
 *
 * ⚠ Anything unrecognised is PRESERVED. He will edit this by hand — it is about
 * him — and a writer that silently drops what it did not expect is one he stops
 * trusting with the thing he most needs it to hold.
 */
function parse(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const facts = {};
  const order = [];
  const preamble = [];
  const trailing = [];

  const ensure = (name) => {
    const key = name.trim().toLowerCase();
    if (!facts[key]) { facts[key] = []; order.push(name.trim()); }
    return key;
  };
  for (const s of SECTIONS) ensure(s);

  let current = null;
  let inFrontmatter = lines[0] === '---';
  for (let i = inFrontmatter ? 1 : 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (inFrontmatter) {
      if (raw === '---') inFrontmatter = false;
      continue;
    }
    if (/^#\s+/.test(raw)) continue;

    const h2 = /^##\s+(.+?)\s*$/.exec(raw);
    if (h2) { current = ensure(h2[1]); continue; }

    const item = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (current && item) {
      const body = item[1];
      const meta = /<!--\s*p:([a-z]+)(?:\s+(\d{4}-\d{2}-\d{2}))?\s*-->/.exec(body);
      const text = body.replace(/<!--.*?-->/g, '').trim();
      if (text) {
        facts[current].push({
          text,
          source: meta && SOURCES.includes(meta[1]) ? meta[1] : 'seed',
          at: meta && meta[2] ? meta[2] : null,
        });
      }
      continue;
    }

    if (!raw.trim()) continue;
    if (raw.trim() === EMPTY_MARK) continue;
    if (INTRO.includes(raw)) continue;
    (current ? trailing : preamble).push(raw);
  }

  return { sections: order, facts, preamble, trailing };
}

/** Render back to markdown. PURE, and STABLE — parse → render → parse returns
 *  the same thing, or a file nobody edited churns on every save. */
function render(profile = {}, { today = null } = {}) {
  const sections = profile.sections && profile.sections.length ? profile.sections : SECTIONS;
  const out = [
    '---',
    'type: profile',
    'private: true',
    `updated: ${today || _today()}`,
    '---',
    '',
    '# About Nick',
    '',
    ...INTRO,
    '',
  ];
  if (profile.preamble && profile.preamble.length) out.push(...profile.preamble, '');

  for (const section of sections) {
    const list = (profile.facts || {})[section.trim().toLowerCase()] || [];
    out.push(`## ${section}`, '');
    if (!list.length) { out.push(EMPTY_MARK, ''); continue; }
    for (const f of list) {
      out.push(`- ${f.text} <!--p:${f.source}${f.at ? ` ${f.at}` : ''}-->`);
    }
    out.push('');
  }

  if (profile.trailing && profile.trailing.length) out.push(...profile.trailing, '');
  return out.join('\n');
}

function _today() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function count(profile) {
  return Object.values((profile && profile.facts) || {}).reduce((n, l) => n + l.length, 0);
}

/**
 * The block injected into SARA's context. PURE.
 *
 * ⚠ Provenance travels WITH it, because it changes the sentence she is entitled
 * to say. Something he told her in an interview she may state; something
 * recovered from a ChatGPT memory dump she should hold more loosely. Stripping
 * the source here and letting her speak with equal confidence about both is how
 * a half-remembered detail becomes a confident assertion about his life.
 *
 * Returns null when there is nothing — an empty block would occupy tokens to say
 * nothing, and worse, would read to her as "he has no personal life" rather than
 * "nobody has told me yet".
 */
function contextBlock(profile, { limit = 40 } = {}) {
  if (!profile || !count(profile)) return null;

  const lines = ['## About Nick (personal)'];
  lines.push('Everything here is something he or a previous assistant said, never inferred.');
  lines.push('`(mentioned)` is weaker than `(told me)` — hold the first more loosely.');
  lines.push('');

  let used = 0;
  for (const section of profile.sections || SECTIONS) {
    const list = (profile.facts || {})[section.trim().toLowerCase()] || [];
    if (!list.length) continue;
    lines.push(`**${section}**`);
    for (const f of list) {
      if (used >= limit) break;
      const tag = f.source === 'seed' ? '(mentioned)'
        : f.source === 'observed' ? '(observed)'
          : '(told me)';
      lines.push(`- ${f.text} ${tag}`);
      used += 1;
    }
    lines.push('');
    if (used >= limit) break;
  }

  return lines.join('\n').trim();
}

/** Which sections are still empty — what the interview should go after. PURE. */
function gaps(profile) {
  const facts = (profile && profile.facts) || {};
  return (profile && profile.sections ? profile.sections : SECTIONS)
    .filter(s => !(facts[s.trim().toLowerCase()] || []).length);
}

// ── Reading and writing ──────────────────────────────────────────────────────

function _file() {
  const root = process.env.OBSIDIAN_VAULT_PATH;
  return root ? path.join(root, PROFILE_PATH) : null;
}

function read() {
  const file = _file();
  if (!file) return { ok: false, why: 'no vault configured', profile: parse('') };
  try {
    if (!fs.existsSync(file)) return { ok: true, empty: true, profile: parse('') };
    return { ok: true, profile: parse(fs.readFileSync(file, 'utf-8')) };
  } catch (e) {
    // ⚠ Unreadable is NOT empty. "I have never been told anything about you" and
    // "I could not open the file" are completely different things for her to
    // believe, and only one of them should make her start asking questions.
    return { ok: false, why: e.message, profile: parse('') };
  }
}

function write(profile) {
  const file = _file();
  if (!file) return { ok: false, why: 'no vault configured' };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, render(profile), 'utf-8');
    try { require('./vault-hooks').onVaultWrite(file, 'profile'); } catch { /* not fatal */ }
    return { ok: true };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

/**
 * Add facts. Returns what was actually added and what was skipped as a
 * duplicate, so a caller can say "I already knew four of those" rather than
 * silently absorbing them.
 */
function addFacts(items = [], { source = 'conversation', at = null } = {}) {
  const found = read();
  if (!found.ok) return { ok: false, why: found.why };
  const profile = found.profile;
  const stamp = at || _today();
  const src = SOURCES.includes(source) ? source : 'conversation';

  const added = [];
  const duplicates = [];

  for (const item of items) {
    const text = String((item && item.text) || '').trim().slice(0, MAX_FACT);
    if (!text) continue;
    const sectionName = _matchSection(profile, (item && item.section) || '');
    const key = sectionName.trim().toLowerCase();
    if (!profile.facts[key]) { profile.facts[key] = []; profile.sections.push(sectionName); }

    // Same thing said twice is one fact. He will tell her about D&D more than
    // once, and a profile that grows a duplicate every time is one that stops
    // being readable.
    if (profile.facts[key].some(f => f.text.toLowerCase() === text.toLowerCase())) {
      duplicates.push(text);
      continue;
    }
    profile.facts[key].push({ text, source: src, at: stamp });
    added.push({ text, section: sectionName });
  }

  if (!added.length) return { ok: true, added: [], duplicates, profile };
  const written = write(profile);
  if (!written.ok) return { ok: false, why: written.why };
  return { ok: true, added, duplicates, profile };
}

/** Nearest known section, or the catch-all. An unrecognised section name is
 *  never invented as a new heading by a MODEL — only by Nick, editing the file. */
function _matchSection(profile, asked) {
  const want = String(asked || '').trim().toLowerCase();
  if (!want) return 'What I care about';
  const known = (profile.sections || SECTIONS).find(s => s.trim().toLowerCase() === want);
  return known || 'What I care about';
}

/** The context block, read from disk. Null when there is nothing or it failed —
 *  and a failure is LOGGED, because a silently absent profile looks exactly like
 *  an empty one. */
function block(opts) {
  const found = read();
  if (!found.ok) {
    console.warn('[Profile] Could not read:', found.why);
    return null;
  }
  return contextBlock(found.profile, opts);
}

/**
 * Turn a pasted memory dump into attributed facts.
 *
 * ⚠ THE MODEL RESTRUCTURES AND MAY NOT ADD. Said twice in the prompt because it
 * is the one thing that would make this feature harmful: a profile that quietly
 * acquires an interest he does not have is worse than an empty one, since he
 * would have no reason to distrust it. Everything lands stamped `seed`, which
 * SARA renders as "(mentioned)" rather than "(told me)".
 *
 * ⚠ Anything about WORK is dropped. The vault already has 263 meeting notes and
 * 417 Plaud recordings; this file exists for the half that is missing, and
 * letting a dump refill it with job facts wastes the one place she looks for
 * everything else.
 */
async function extractFacts(text) {
  const sections = SECTIONS.join(', ');
  const prompt = [
    'Below is an exported memory dump about a person called Nick, written by a previous AI assistant.',
    '',
    'Extract what it says about him AS A PERSON into a JSON array of {"text","section"}.',
    '',
    'RULES — the first is the one that matters:',
    '1. INVENT NOTHING. Every fact must be traceable to a sentence in the dump. If it is not there, it does not go in. Do not infer, do not generalise, do not round up a maybe into a fact.',
    '2. Drop anything about his JOB, his employer, his team, his queue or his projects. That is already recorded elsewhere in far more detail. Keep it only where it is about HIM rather than the work — how he thinks, what he finds hard.',
    '3. One fact per entry, short, in the third person ("Plays D&D and runs a campaign").',
    '4. `section` must be exactly one of: ' + sections,
    '5. Drop anything you are not confident the dump actually says. A shorter honest list is the goal.',
    '',
    'Return ONLY the JSON array.',
    '',
    '--- DUMP ---',
    text,
  ].join('\n');

  try {
    const aiRouting = require('./ai-routing');
    const result = await aiRouting.runTask('profile_seed', prompt, { maxTokens: 4000 });
    const body = typeof result === 'string' ? result : (result && (result.text || result.content)) || '';
    const match = body.match(/\[[\s\S]*\]/);
    if (!match) {
      // ⚠ Say WHAT came back. "the model did not return a JSON array" sent me
      // round three separate wrong diagnoses (routing, the cloud gate, the AI
      // mode) before the actual answer — an empty string, because every
      // provider had declined — was visible. An error that does not carry the
      // evidence is an error that costs an hour.
      const provider = (result && result.provider) || 'unknown';
      const reason = (result && result.reason) || null;
      return {
        ok: false,
        why: body
          ? `${provider} replied but not with a JSON array: "${body.slice(0, 200)}"`
          : `no model answered (provider: ${provider}${reason ? `, ${reason}` : ''})`,
      };
    }
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return { ok: false, why: 'not an array' };
    return {
      ok: true,
      facts: parsed
        .filter(f => f && typeof f.text === 'string' && f.text.trim())
        .map(f => ({ text: String(f.text).trim().slice(0, MAX_FACT), section: String(f.section || '').trim() })),
    };
  } catch (e) {
    return { ok: false, why: e.message };
  }
}

module.exports = {
  // pure
  parse,
  render,
  contextBlock,
  gaps,
  count,
  // stateful
  read,
  write,
  addFacts,
  block,
  extractFacts,
  // constants
  PROFILE_PATH,
  SECTIONS,
  SOURCES,
  MAX_FACT,
};
