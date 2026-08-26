'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Scratch DB, never the live one (mistakes.md, 13 Aug).
const DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-triage-')), 'scratch.db');
process.env.NEURO_DB_PATH = DB_PATH;

const db = require('../db/database');
const emailTriage = require('./email-triage');
const nudges = require('./nudges');

test.before(async () => { await db.init(); });

function email(over = {}) {
  return {
    id: 'AAMk-1',
    subject: 'RE: Urgent: Tracy Welham — source of contact data',
    from: 'Phillipa Legg',
    fromEmail: 'phillipa@example.com',
    preview: 'Just to add to this —',
    lane: 'urgent',
    category: 'ACTION',
    urgency: 'high',
    reason: 'urgent language · unread',
    dismissed: false,
    ...over,
  };
}

function seed(items) {
  db.setState('email_triage', JSON.stringify(items));
}

test('urgent means the urgent lane, and only what is still outstanding', () => {
  seed([
    email(),
    email({ id: 'AAMk-2' }),
    email({ id: 'AAMk-3', lane: 'reply', urgency: 'medium' }),
    email({ id: 'AAMk-4', lane: 'fyi', urgency: 'low', category: 'FYI' }),
    email({ id: 'AAMk-5', dismissed: true }),
  ]);

  assert.equal(emailTriage.getUrgentEmails().length, 2);
});

// The regression this file exists for. The count that interrupted Nick was
// computed over a SECOND store (`inbox_items`) that his dismissals never
// reached, so actioning the whole panel left the notification saying 37. If
// these two ever read different places again, this fails.
test('the banner and the panel are the same mail — a dismissal moves both', () => {
  seed([email(), email({ id: 'AAMk-2' })]);

  assert.equal(nudges.getUrgentEmails().length, 2);
  emailTriage.dismissEmail('AAMk-1', 'done');

  assert.equal(emailTriage.getUrgentEmails().length, 1, 'panel must drop it');
  assert.equal(nudges.getUrgentEmails().length, 1, 'and so must the nudge');
});

test('nothing outstanding says nothing at all', () => {
  seed([email({ dismissed: true })]);
  assert.equal(nudges.getUrgentEmails().length, 0);
  // A null message is what clears the banner rather than raising an empty one.
  assert.equal(nudges.buildEmailMessage(nudges.getUrgentEmails()), null);
});

test('the message names the sender off the triage record, not a DB column', () => {
  seed([email(), email({ id: 'AAMk-2' })]);
  const msg = nudges.buildEmailMessage(nudges.getUrgentEmails());
  // `from_name`/`from_email` were the retired table's columns; reading those
  // off a triage record yields "undefined" in a push notification.
  assert.match(msg, /^2 urgent emails need a reply — including one from Phillipa Legg\.$/);
});

test('the chat context feed can tell "not looked yet" from "inbox clear"', () => {
  seed([]);
  db.setState('email_triage_time', '');
  assert.equal(emailTriage.getFlaggedItems().lastScan, null);

  seed([email({ lane: 'ignore', category: 'IGNORE' }), email({ id: 'AAMk-2' })]);
  db.setState('email_triage_time', String(Date.UTC(2026, 7, 26, 12, 0, 0)));
  const flagged = emailTriage.getFlaggedItems();
  assert.equal(flagged.items.length, 1, 'ignored mail is not context');
  assert.equal(flagged.items[0].emailId, 'AAMk-2');
  assert.ok(flagged.lastScan, 'a run that happened must be datable');
});
