'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Scratch DB and scratch vault — set before anything requires the db module, since
// database.js reads NEURO_DB_PATH at load time.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-chattools-'));
process.env.NEURO_DB_PATH = path.join(root, 'tools.db');
process.env.OBSIDIAN_VAULT_PATH = path.join(root, 'vault');
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Meetings'), { recursive: true });
fs.mkdirSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Tasks'), { recursive: true });
fs.writeFileSync(path.join(process.env.OBSIDIAN_VAULT_PATH, 'Meetings', 'Note.md'), '# A note\n\nBody text.\n');
fs.writeFileSync(path.join(root, 'secret.txt'), 'not for the model');

const db = require('../db/database');
const chatTools = require('./chat-tools');
const { _normaliseHistory } = require('./providers/anthropic-provider');

test.before(async () => { await db.init(); });

test('tool definitions carry no internal fields and are all well-formed', () => {
  const defs = chatTools.toolDefinitions();
  assert.equal(defs.length, chatTools.TOOLS.length);
  for (const d of defs) {
    assert.ok(d.name && d.description && d.input_schema, `${d.name} is incomplete`);
    // `tier` is our safety model, not part of the API contract.
    assert.equal(d.tier, undefined);
  }
});

test('every declared tool has a handler — a listed tool with no handler is dead weight', async () => {
  for (const tool of chatTools.TOOLS) {
    const result = await chatTools.execute(tool.name, {});
    assert.notEqual(result.error, `Unknown tool: ${tool.name}`, `${tool.name} has no handler`);
  }
});

test('an unknown tool name is reported, not thrown', async () => {
  const result = await chatTools.execute('delete_everything', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test('read_note refuses to escape the vault', async () => {
  const escaped = await chatTools.execute('read_note', { path: '../secret.txt' });
  assert.equal(escaped.ok, false);
  assert.match(escaped.error, /outside the vault/);

  const absolute = await chatTools.execute('read_note', { path: path.join(root, 'secret.txt') });
  assert.equal(absolute.ok, false);

  const nonMarkdown = await chatTools.execute('read_note', { path: 'Meetings/../secret.txt' });
  assert.equal(nonMarkdown.ok, false);

  const good = await chatTools.execute('read_note', { path: 'Meetings/Note.md' });
  assert.equal(good.ok, true);
  assert.match(good.content, /Body text/);
});

test('create_task then complete_task round-trips through the task store', async () => {
  const created = await chatTools.execute('create_task', { text: 'Chase the Engineering handover doc', moscow: 'must' });
  assert.equal(created.ok, true);
  assert.ok(created.task_id);

  const listed = await chatTools.execute('get_tasks', { filter: 'must' });
  assert.ok(listed.tasks.some(t => t.id === created.task_id), 'created task should be listed with its id');

  const done = await chatTools.execute('complete_task', { task_id: created.task_id });
  assert.equal(done.ok, true);
  assert.equal(done.completed, true);

  const after = await chatTools.execute('get_tasks', { filter: 'open' });
  assert.ok(!after.tasks.some(t => t.id === created.task_id), 'completed task should leave the open list');
});

test('complete_task refuses an id it has not been given', async () => {
  const missing = await chatTools.execute('complete_task', { task_id: 999999 });
  assert.equal(missing.ok, false);

  const none = await chatTools.execute('complete_task', {});
  assert.equal(none.ok, false);
  assert.match(none.error, /get_tasks/);
});

test('outward-facing tools queue for approval and send nothing', async () => {
  const reply = await chatTools.execute('draft_email_reply', { email_id: 'AAMk-test', body: 'Picking this up now.' });
  assert.equal(reply.ok, true);
  assert.equal(reply.sent, false);
  assert.ok(reply.queued_action_id);

  const booking = await chatTools.execute('schedule_focus_block', { subject: 'Tiered model write-up', minutes: 90 });
  assert.equal(booking.ok, true);
  assert.equal(booking.booked, false);

  const pending = db.getPendingSaraActions(20);
  assert.ok(pending.some(a => a.id === reply.queued_action_id && a.type === 'draft_reply'));
  assert.ok(pending.some(a => a.id === booking.queued_action_id && a.type === 'schedule_focus_block'));
});

test('history normaliser produces a shape the tool API will accept', () => {
  // Opens on assistant, repeats roles, has an empty turn, ends on assistant.
  const messy = [
    { role: 'assistant', content: 'stray opener' },
    { role: 'user', content: 'first' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: '' },
    { role: 'user', content: 'third' },
    { role: 'assistant', content: 'trailing' },
  ];
  const clean = _normaliseHistory(messy);

  assert.equal(clean[0].role, 'user');
  assert.equal(clean[clean.length - 1].role, 'user');
  // The empty assistant turn is dropped, which leaves all three user turns
  // adjacent — so they collapse into one.
  assert.equal(clean[0].content, 'first\n\nsecond\n\nthird');
  assert.equal(clean.length, 1);
  for (let i = 1; i < clean.length; i++) {
    assert.notEqual(clean[i].role, clean[i - 1].role, 'roles must alternate');
  }
});
