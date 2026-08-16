'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Against a real scratch DB, not a stub — the point of #69 is that a reply
// leaves a durable record, and a mocked writer proves nothing about that.
// NEVER point this at the live agent.db: moving a live DB aside for a test is
// how the local dev copy was destroyed once already (mistakes.md, 13 Aug).
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-replies-')), 'scratch.db');
process.env.NEURO_DB_PATH = DB_PATH;

const db = require('../db/database');
const sentReplies = require('./sent-replies');

test.before(async () => { await db.init(); });

function reply(over = {}) {
  return {
    emailId: 'AAMk-1',
    subject: 'Integration Partner Escalation Contacts',
    fromName: 'Stephen Mitchell',
    fromEmail: 'stephen@nurtur.tech',
    recipients: [{ name: 'Stephen Mitchell', email: 'stephen@nurtur.tech' }],
    recipientsSource: 'explicit',
    body: 'Adding Riannah as the second contact — will confirm Friday.',
    ...over,
  };
}

test('a sent reply is recorded and readable back', () => {
  sentReplies.record(reply());
  const { replies, total } = sentReplies.list();
  assert.equal(total, 1);
  assert.equal(replies[0].emailId, 'AAMk-1');
  assert.equal(replies[0].subject, 'Integration Partner Escalation Contacts');
  // The body verbatim is the whole point — it is what makes "what did I say?"
  // answerable, and what a later extraction pass would read.
  assert.match(replies[0].body, /Riannah/);
  assert.ok(replies[0].sentAt, 'a reply with no timestamp cannot answer "when"');
});

test('recipients keep their provenance', () => {
  // On a plain reply/replyAll GRAPH picks the recipients, not NEURO. Storing an
  // inferred list as fact is how "who did I copy?" gets answered wrongly.
  sentReplies.record(reply({ emailId: 'AAMk-2', recipientsSource: 'inferred' }));
  const found = sentReplies.forEmail('AAMk-2');
  assert.equal(found.length, 1);
  assert.equal(found[0].recipientsSource, 'inferred');
  assert.equal(found[0].recipients[0].email, 'stephen@nurtur.tech');
});

test('an unrecognised provenance degrades to unknown, never to a claim', () => {
  sentReplies.record(reply({ emailId: 'AAMk-3', recipientsSource: 'probably-right' }));
  assert.equal(sentReplies.forEmail('AAMk-3')[0].recipientsSource, 'unknown');
});

test('no recipients at all is recorded rather than refused', () => {
  // The mail has already left. A record with a gap beats no record.
  sentReplies.record(reply({ emailId: 'AAMk-4', recipients: null, recipientsSource: 'unknown' }));
  const r = sentReplies.forEmail('AAMk-4')[0];
  assert.deepEqual(r.recipients, []);
  assert.equal(r.recipientsSource, 'unknown');
});

test('a thread answered twice keeps both replies', () => {
  sentReplies.record(reply({ emailId: 'AAMk-5', body: 'first answer' }));
  sentReplies.record(reply({ emailId: 'AAMk-5', body: 'second answer' }));
  assert.equal(sentReplies.forEmail('AAMk-5').length, 2, 'a resend is a separate reply, not a duplicate');
});

test('a reply with no body or no email id is not recorded', () => {
  const before = sentReplies.count();
  sentReplies.record(reply({ body: '   ' }));
  sentReplies.record(reply({ emailId: '' }));
  assert.equal(sentReplies.count(), before, 'an empty row is worse than no row');
});

test('recording never throws — the mail has already been sent', () => {
  // A bookkeeping failure must not be reported to Nick as a failed send.
  assert.doesNotThrow(() => sentReplies.record(undefined));
  assert.doesNotThrow(() => sentReplies.record({ emailId: 'x', body: 'y', recipients: 'not-an-array' }));
});

test('list is newest first and its total is not the capped count', () => {
  // getPendingSaraActions defaulted to 10 and reported a queue of 930 as 10.
  const total = sentReplies.count();
  const page = sentReplies.list({ limit: 1 });
  assert.equal(page.replies.length, 1);
  assert.equal(page.total, total, 'total must count the table, not the page');
  assert.ok(page.total > 1);
});

test('limit is bounded rather than trusted', () => {
  assert.equal(sentReplies.list({ limit: 99999 }).limit, 200);
  assert.equal(sentReplies.list({ limit: -5 }).limit, 50);
});
