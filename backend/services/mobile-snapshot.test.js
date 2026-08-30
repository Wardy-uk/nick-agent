'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-snap-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-snap-vault-'));

const db = require('../db/database');
const snapshot = require('./mobile-snapshot');

test.before(async () => { await db.init(); });

// ── Rule 2: an unread section is {known:false}, NEVER an empty list ──────────

test('an unreadable calendar gives known:false, not an empty agenda', () => {
  const a = snapshot.agendaSection({ agenda: { known: false, events: [] } });
  assert.equal(a.known, false);
  assert.ok(a.why, 'and it names why — "I could not look" must be sayable');
  assert.equal(a.next, null);
});

test('a readable but empty diary is known:true with no items — a different fact', () => {
  const a = snapshot.agendaSection({ agenda: { known: true, scope: 'today', events: [] } });
  assert.equal(a.known, true);
  assert.deepEqual(a.items, []);
  assert.equal(a.next, null);
});

test('an unavailable decision pool is NOT rendered as "nothing pending"', () => {
  const f = snapshot.followUpsSection({ poolAvailable: false, primary: null, secondary: [] });
  assert.equal(f.known, false);
  assert.match(f.why, /NOT an all-clear/);
});

test('a readable pool with nothing in it is known:true and quiet', () => {
  const f = snapshot.followUpsSection({
    poolAvailable: true, poolSize: 0, primary: null, secondary: [], dropped: [], quiet: true,
    generatedAt: '2026-08-30T09:00:00.000Z',
  });
  assert.equal(f.known, true);
  assert.equal(f.quiet, true);
  assert.deepEqual(f.items, []);
});

test('dropped items are surfaced as a count, never swallowed', () => {
  const f = snapshot.followUpsSection({
    poolAvailable: true, poolSize: 4, primary: null, secondary: [],
    dropped: [{ id: 'a' }, { id: 'b' }], generatedAt: '2026-08-30T09:00:00.000Z',
  });
  assert.equal(f.dropped, 2);
});

// ── Rule 1: every item carries id / source / updatedAt ───────────────────────

test('every agenda item carries a stable canonical id and a source', () => {
  const payload = {
    agenda: {
      known: true,
      scope: 'today',
      events: [
        { start: '2026-08-30T14:00:00', subject: '1-2-1 Hope Goodall', minutesAway: 45, attendeesOther: true },
      ],
    },
  };
  const a = snapshot.agendaSection(payload);
  const item = a.items[0];
  assert.ok(item.id.startsWith('event:derived:'));
  assert.equal(item.source, 'microsoft.calendar');
  assert.ok('updatedAt' in item);
  // Deterministic: the same meeting keeps the same id across refreshes.
  assert.equal(snapshot.agendaSection(payload).items[0].id, item.id);
});

test('minutesAway stays NULL rather than becoming a confident 0m', () => {
  // 28 Aug: `Number(null)` is 0 and `isFinite(0)` is true, so a deliberate
  // "no answer" rendered as the most urgent possible answer.
  const a = snapshot.agendaSection({
    agenda: { known: true, scope: 'monday', events: [{ start: '2026-09-01T09:00:00', subject: 'Standup' }] },
  });
  assert.equal(a.items[0].minutesAway, null);
  assert.notEqual(a.items[0].minutesAway, 0);
});

test('scope is carried verbatim so no client is a second opinion about which day', () => {
  const a = snapshot.agendaSection({ agenda: { known: true, scope: 'monday', events: [] } });
  assert.equal(a.scope, 'monday');
});

test('follow-up items carry an id, a source and the time they were generated', () => {
  const f = snapshot.followUpsSection({
    poolAvailable: true,
    poolSize: 1,
    generatedAt: '2026-08-30T09:00:00.000Z',
    primary: { kind: 'item', id: 'todo-overdue-top', type: 'todo', title: 'Sign the risk assessment', say: 'This is 3 days late.', tab: 'tasks' },
    secondary: [],
    dropped: [],
  });
  assert.equal(f.items[0].id, 'attention:todo-overdue-top');
  assert.equal(f.items[0].source, 'neuro.decision-engine');
  assert.equal(f.items[0].updatedAt, '2026-08-30T09:00:00.000Z');
  assert.equal(f.items[0].tab, 'tasks', 'routing is the brain\'s answer, not re-derived on device');
});

// ── Rule 3: retrieval is pointers, not bulk content ─────────────────────────

test('retrieval returns pointers — title, path, updated — and no note bodies', () => {
  const captures = {
    known: true,
    items: [{
      id: 'capture:Imports/x.md',
      source: 'vault.imports',
      updatedAt: '2026-08-30T09:00:00.000Z',
      title: 'A thought',
      preview: 'PRIVATE BODY TEXT THAT MUST NOT TRAVEL',
      path: 'Imports/x.md',
    }],
  };
  const tasks = { known: true, items: [{ id: 'task:1', source: 'neuro.tasks', updatedAt: null, text: 'Do the thing' }] };
  const r = snapshot.retrievalSection(captures, tasks);
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes('PRIVATE BODY TEXT'), 'a pointer is not the content');
  assert.ok(r.items.every((p) => p.id && p.source && 'updatedAt' in p));
  assert.match(r.note, /pointers only/);
});

test('the retrieval set is bounded', () => {
  const many = { known: true, items: Array.from({ length: 50 }, (_, i) => ({ id: `capture:${i}`, source: 'vault.imports', updatedAt: null, title: `t${i}`, path: `p${i}` })) };
  const r = snapshot.retrievalSection(many, { known: true, items: [] });
  assert.ok(r.items.length <= snapshot.LIMITS.retrieval);
});

// ── People: full-name matching only ─────────────────────────────────────────

test('an unreadable calendar means people is known:false, not an empty roster', () => {
  const p = snapshot.peopleSection({ known: false });
  assert.equal(p.known, false);
});

// ── Focus ───────────────────────────────────────────────────────────────────

test('no running session and no primary card is a valid, quiet answer', () => {
  const f = snapshot.focusSection({ primary: null });
  assert.equal(f.known, true);
  assert.equal(f.item, null);
  assert.equal(f.nextStep, null);
});

test('the primary card supplies the next step when no session is running', () => {
  const f = snapshot.focusSection({
    primary: { id: 'esc-1', title: 'NT-14855 has had no reply', say: 'Six days, no reply.', actionHint: 'Reply to the customer', tab: 'today' },
  });
  assert.equal(f.nextStep, 'Reply to the customer');
  assert.equal(f.item.id, 'attention:esc-1');
});

// ── The whole snapshot ──────────────────────────────────────────────────────

test('build() returns a versioned payload whose every section names its own state', async () => {
  const snap = await snapshot.build({ now: new Date('2026-08-30T09:00:00Z') });
  assert.equal(snap.schema, 'neuro.mobile.nick-now/1');
  assert.ok(snap.generatedAt);
  assert.ok(Array.isArray(snap.sources));
  // Not a single section may be silent about whether it was read.
  for (const s of snap.sources) {
    assert.ok(['live', 'unavailable'].includes(s.state), `${s.id} must declare live or unavailable`);
    if (s.state === 'unavailable') assert.ok(s.why, `${s.id} must say why it is unavailable`);
  }
  assert.ok(Array.isArray(snap.gaps));
});

test('build() never presents an unreadable pool as a calm day', async () => {
  const snap = await snapshot.build({ now: new Date('2026-08-30T09:00:00Z') });
  if (snap.poolAvailable === false) {
    assert.equal(snap.followUps.known, false);
    assert.match(snap.followUps.why, /NOT an all-clear/);
  }
});
