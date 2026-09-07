'use strict';

/**
 * SARA's opening line must be about the day she was actually shown.
 *
 * 7 Sep 2026, live at the top of the briefing and spoken aloud: "Avoid the
 * meeting. / Stay focused on tasks.", then on the next refresh "Start the
 * meeting now. / Attend / Don't worry about the tasks for today." There was NO
 * MEETING — two todos and an email. The model invented one, contradicted itself
 * about it, and told Nick to ignore the only real work on the list.
 *
 * The prompt fix (whole tone instruction, item types and reasons) is necessary
 * and not sufficient: a small model asked to write a directive can always
 * invent. This is the check that stops one reaching the screen.
 *
 * Pure — no model, no DB, no clock.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('./ai-provider');

const check = (message, action, ignore, items) =>
  ai.checkSaraGrounding({ primary: { message, action }, ignore: ignore || '' }, items);

const TODOS_AND_EMAIL = [
  { type: 'todo', title: 'Stand up a single view of aged tickets', reason: '3 days late' },
  { type: 'email', title: 'Udemny', reason: 'urgent, unread' },
  { type: 'todo', title: '3 high-priority tasks with no date', reason: 'no due date' },
];

// ── The two lines that actually shipped ────────────────────────────────────

test('the live "Avoid the meeting" line is rejected', () => {
  const r = check('Avoid the meeting.', 'Stay focused on tasks.', '', TODOS_AND_EMAIL);
  assert.equal(r.ok, false);
  assert.match(r.reason, /meeting/);
});

test('the live "Start the meeting now" line is rejected', () => {
  const r = check('Start the meeting now.', 'Attend',
    "Don't worry about the tasks for today.", TODOS_AND_EMAIL);
  assert.equal(r.ok, false);
});

// ── 1. The directive may not name something that is not there ──────────────

test('a directive about an absent kind of thing is rejected', () => {
  assert.equal(check('Handle the escalation first.', 'Open escalation queue', '', TODOS_AND_EMAIL).ok, false);
  assert.equal(check('Clear the SLA tickets.', 'Review at-risk', '', TODOS_AND_EMAIL).ok, false);
});

test('a directive about something that IS there passes', () => {
  assert.equal(check('Reply to the Udemny email first.', 'Open inbox', 'The rest can wait.', TODOS_AND_EMAIL).ok, true);
  assert.equal(check('Start with your top overdue task.', 'Open the first one', '', TODOS_AND_EMAIL).ok, true);
});

test('the ignore line may name an absent category — that is its job', () => {
  // The deterministic builder says exactly this. Checking `ignore` for absent
  // types would reject the honest phrasing along with the invented one.
  assert.equal(check('Start with your top overdue task.', 'Open the first one',
    'Lower-priority imports and email can wait.',
    [{ type: 'todo', title: 't', reason: 'r' }]).ok, true);
});

test('a subject word is matched whole — "mail" is not found inside "email"', () => {
  // entities.js's rule: includes() fired "Liam" inside "William".
  const r = check('Send the mail.', '', '', [{ type: 'todo', title: 't', reason: 'r' }]);
  assert.equal(r.ok, false, 'a bare "mail" with no email item should be caught');
  assert.equal(check('Start the task.', '', '', [{ type: 'email', title: 'e', reason: 'r' }]).ok, false);
});

// ── 2. A directive must direct ─────────────────────────────────────────────

test('the directive may not hand out permission to avoid', () => {
  for (const [m, a] of [
    ['Avoid the task.', ''],
    ['Skip the email.', ''],
    ['', 'Ignore it for now'],
    ["Don't start the task.", ''],
    ['Postpone the task.', ''],
  ]) {
    const r = check(m || 'Do the thing.', a, '', TODOS_AND_EMAIL);
    assert.equal(r.ok, false, `"${m} ${a}" was allowed through`);
  }
});

test('assertive is exactly the register this protects', () => {
  // The tone fires BECAUSE avoidance was detected. A line telling him to avoid
  // something is the failure at its most expensive.
  assert.equal(check('Avoid it today.', 'Come back tomorrow', '', TODOS_AND_EMAIL).ok, false);
});

// ── 3. It may not tell him to ignore what it just told him to do ───────────

test('the ignore line may not name the TOP item', () => {
  const r = check('Start with your top overdue task.', 'Open the first one',
    'Don\'t worry about the tasks for today.', TODOS_AND_EMAIL);
  assert.equal(r.ok, false);
  assert.match(r.reason, /top item/);
});

test('an ambiguous word is not a subject claim', () => {
  // "queue" belongs to the escalation queue as much as the ticket queue, so it
  // identifies nothing and must not reject on its own.
  assert.equal(check('Open the queue.', '', '', TODOS_AND_EMAIL).ok, true);
});

test('the ignore line may name a lower item', () => {
  assert.equal(check('Start with your top overdue task.', 'Open the first one',
    'Email can wait.', TODOS_AND_EMAIL).ok, true);
});

// ── Refusals and agreement ─────────────────────────────────────────────────

test('an empty message is rejected rather than rendered', () => {
  assert.equal(check('', '', '', TODOS_AND_EMAIL).ok, false);
});

test('the deterministic line always passes its own check', () => {
  // The two must agree: if the grounded fallback would fail this check, one of
  // them is wrong, and it is the check that gets used on every drift.
  for (const type of ['escalation', 'jira_ticket', 'meeting', 'todo', 'nudge', 'email', 'imports']) {
    const items = [{ type, title: 'Something', reason: 'a reason' },
      { type: 'todo', title: 'Other', reason: 'r' }];
    const det = ai.buildDeterministicSara(items, 'focused');
    const r = ai.checkSaraGrounding(det, items);
    assert.equal(r.ok, true, `deterministic line for ${type} failed: ${r.reason} — "${det.primary.message}"`);
  }
});

test('the EOD override also passes', () => {
  const items = [{ type: 'nudge', title: 'EOD', reason: 'not done', meta: { type: 'eod' } }];
  const det = ai.buildDeterministicSara(items, 'focused');
  assert.equal(ai.checkSaraGrounding(det, items).ok, true);
});

// ── The wiring, not just the rules ─────────────────────────────────────────
//
// A green suite over the pure function says nothing about whether enhanceFocus
// APPLIES it, or about what actually reaches the model. Both of those were the
// bug, so both are exercised here against a stubbed provider.

const aiRouting = require('./ai-routing');

async function withModel(reply, fn) {
  const real = aiRouting.runTask;
  const seen = {};
  aiRouting.runTask = async (task, opts) => {
    seen.task = task;
    seen.systemPrompt = opts.systemPrompt;
    seen.user = opts.messages?.[0]?.content;
    return { text: JSON.stringify(reply), provider: 'ollama' };
  };
  try { return { result: await fn(), seen }; } finally { aiRouting.runTask = real; }
}

const ITEMS = [
  { type: 'todo', title: 'Sign the risk assessment', reason: '3 days late' },
  { type: 'email', title: 'Udemny', reason: 'urgent, unread' },
];

test('enhanceFocus DISCARDS a drifting line rather than returning it', async () => {
  const { result } = await withModel(
    { primary: { message: 'Avoid the meeting.', action: 'Stay focused on tasks.' }, ignore: '' },
    () => ai.enhanceFocus({ items: ITEMS, context: {}, tone: 'assertive', primaryItem: null }));
  // null is already the "AI unavailable" path, so the caller renders the
  // deterministic line with no new branch.
  assert.equal(result, null);
});

test('enhanceFocus returns a grounded line', async () => {
  const { result } = await withModel(
    { primary: { message: 'Sign the risk assessment.', action: 'Open the task' }, ignore: 'Email can wait.' },
    () => ai.enhanceFocus({ items: ITEMS, context: {}, tone: 'assertive', primaryItem: null }));
  assert.equal(result.primary.message, 'Sign the risk assessment.');
  assert.equal(result.provider, 'ollama');
});

test('the WHOLE tone instruction reaches the model', async () => {
  // `toneGuide.split('.')[0]` sent "He is avoiding something." and dropped
  // every word saying what to do about it — which is how the model came to
  // echo "avoid" back as an instruction.
  const { seen } = await withModel(
    { primary: { message: 'Sign the risk assessment.', action: 'Open it' }, ignore: '' },
    () => ai.enhanceFocus({ items: ITEMS, context: {}, tone: 'assertive', primaryItem: null }));
  assert.match(seen.systemPrompt, /avoiding something/);
  assert.match(seen.systemPrompt, /smallest first move/, 'the instruction was truncated to its diagnosis');
  assert.match(seen.systemPrompt, /No escape routes/);
});

test('the item TYPES and REASONS reach the model, not bare titles', async () => {
  const { seen } = await withModel(
    { primary: { message: 'Sign the risk assessment.', action: 'Open it' }, ignore: '' },
    () => ai.enhanceFocus({ items: ITEMS, context: {}, tone: 'focused', primaryItem: null }));
  assert.match(seen.user, /\[todo\]/);
  assert.match(seen.user, /3 days late/, 'the reason was dropped — the model has nothing to base a directive on');
  assert.match(seen.user, /\[email\]/);
});
