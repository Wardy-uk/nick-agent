'use strict';

// Pages NEURO writes from its own state, rather than mirroring from a note.
//
// `Current Priorities`, `Current Problems` and `Current State` have no vault
// note behind them and never will — they are a VIEW of what NEURO already
// knows (tasks, escalations, the weekly risk read), not a document Nick keeps.
// Mirroring cannot produce them; generating can.
//
// ── The rule that makes this safe to run every 15 minutes ───────────────────
//
// ⚠ A generated page MUST NOT contain anything that changes on its own. No
// timestamps, no "as of", no counts that tick with the clock. The sync decides
// whether to push by hashing the generated markdown against what it last
// pushed, so a body carrying the time of generation differs on EVERY run: it
// would rewrite three Notion pages every quarter of an hour, for ever, burning
// API quota and filling the page history with edits nobody made. `renderedAt`
// belongs in the sync state, never in the body.
//
// ── And the rule that keeps it honest ───────────────────────────────────────
//
// ⚠ A source that cannot be read is a NAMED GAP on the page, never an omission.
// The whole point of publishing this is that ChatGPT reads it and answers from
// it; a page that silently drops the escalations section reads as "no
// escalations", which is a confident lie. Every generator returns `gaps`, and
// they are rendered on the page itself.

const MAX_ITEMS = 12;

/** A vault-safe, Notion-safe line. Keeps the markdown the converter supports. */
function bullet(text) {
  return `- ${String(text).replace(/\s+/g, ' ').trim()}`;
}

function section(heading, lines) {
  return [`## ${heading}`, '', ...lines, ''].join('\n');
}

/**
 * What Nick owes, ranked the way the rest of NEURO ranks it.
 *
 * Deliberately reuses `task-store.activeTodos()` rather than a fresh query, so
 * this page cannot disagree with Focus, the Surface or the widget about what
 * matters — three surfaces with three orderings is the drift this codebase
 * already documents in several places.
 */
async function currentPriorities() {
  const gaps = [];
  let tasks = [];
  try {
    tasks = require('../task-store').activeTodos() || [];
  } catch (e) {
    gaps.push(`Task list could not be read (${e.message}) — this page is NOT a complete picture.`);
  }

  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'dropped');
  const must = open.filter((t) => (t.moscow || '').toLowerCase() === 'must');
  const overdue = open.filter((t) => t.dueDate && t.dueDate < todayKey());

  const blocks = [];

  blocks.push(section('Must do', must.length
    ? must.slice(0, MAX_ITEMS).map((t) => bullet(t.text))
    : ['Nothing is currently marked as a must.']));

  blocks.push(section('Overdue', overdue.length
    ? overdue.slice(0, MAX_ITEMS).map((t) => bullet(`${t.text} — due ${t.dueDate}`))
    : ['Nothing overdue.']));

  // The count is a fact about the list, not a clock-driven number, so it is
  // stable between runs unless the list actually changes.
  blocks.push(section('Everything else', [
    `${Math.max(0, open.length - must.length)} other open tasks.`,
  ]));

  return { markdown: blocks.join('\n'), gaps };
}

/**
 * What is going wrong right now — the things a stand-in would need to know.
 *
 * ⚠ Escalations are read from the LIVE Jira path, never the retired
 * `jira_tickets_cache`. That cache lost its writer in July 2026 and went on
 * serving a frozen snapshot to seven consumers for seven weeks; publishing it
 * to an external AI would be the same bug with a wider audience.
 */
async function currentProblems() {
  const gaps = [];
  const blocks = [];

  let escalations = null;
  try {
    escalations = await require('../jira').fetchActiveEscalations();
  } catch (e) {
    gaps.push(`Escalations could not be read (${e.message}) — assume this section is incomplete.`);
  }

  if (escalations === null) {
    blocks.push(section('Escalations', ['Could not be read. This is NOT an all-clear.']));
  } else {
    blocks.push(section('Escalations', escalations.length
      ? escalations.slice(0, MAX_ITEMS).map((t) => bullet(
        `${t.key || 'unknown'} — ${t.summary || '(no summary)'}${t.status ? ` (${t.status})` : ''}`))
      : ['No active escalations.']));
  }

  // Waiting-on: what other people owe Nick. Only rows with a recorded source,
  // following meeting-prep's rule — the backfill misparses, and an unattributed
  // claim that a named colleague has not delivered is not one to publish.
  try {
    // `list({status:'open'})` — the real API. An earlier draft guessed
    // `listOpen()` and guarded it with `?`, which would have published an EMPTY
    // section rather than an error: silently reading as "nobody owes Nick
    // anything". Same species as the invented metric names this repo has been
    // bitten by twice.
    const rows = require('../waiting-on').list({ status: 'open' }) || [];
    // Only rows with a recorded source, following meeting-prep's rule: the
    // backfill misparses, and an unattributed claim that a named colleague has
    // not delivered is not something to publish to an external AI.
    const sourced = rows.filter((r) => r.sourcePath || r.source_path);
    blocks.push(section('Waiting on other people', sourced.length
      ? sourced.slice(0, MAX_ITEMS).map((r) => bullet(`${r.person} — ${r.what || r.item || r.text}`))
      : ['Nothing recorded with a traceable source.']));
  } catch (e) {
    gaps.push(`Waiting-on list could not be read (${e.message}).`);
    blocks.push(section('Waiting on other people', ['Could not be read. This is NOT an all-clear.']));
  }

  return { markdown: blocks.join('\n'), gaps };
}

function todayKey(now = new Date()) {
  // Local date, never toISOString() — the Pi may run in UTC.
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

const GENERATORS = {
  current_priorities: { label: 'Current Priorities', build: currentPriorities },
  current_problems: { label: 'Current Problems', build: currentProblems },
};

/**
 * Build one generated page.
 *
 * Returns `{ ok, markdown, gaps }`. ⚠ `ok:false` means REFUSE TO PUSH — used
 * when the page would be actively misleading rather than merely thin. The
 * caller must not publish a body it was told not to.
 */
async function generate(name) {
  const gen = GENERATORS[name];
  if (!gen) return { ok: false, markdown: '', gaps: [`Unknown generator "${name}".`] };

  const { markdown, gaps } = await gen.build();

  const header = [
    '> Written by NEURO from its own records. Editing this page in Notion has no',
    '> effect — it is replaced on the next sync.',
    '',
  ].join('\n');

  // Gaps go ON the page, at the top, where a reader cannot miss them. A section
  // that silently vanished would read as "nothing there".
  const gapBlock = gaps.length
    ? section('⚠ Incomplete', gaps.map(bullet))
    : '';

  return { ok: true, markdown: `${header}${gapBlock}${markdown}`.trim(), gaps };
}

module.exports = { GENERATORS, generate, todayKey, _internals: { bullet, section } };
