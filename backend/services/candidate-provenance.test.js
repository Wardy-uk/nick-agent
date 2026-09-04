'use strict';

/**
 * The bug this pins: the review card rendered `sourcePath` raw, so an
 * email-sourced suggestion showed a Graph message id. The negatives are the
 * point — a base64 blob must never reach a label, and a missing sender must not
 * silently fall back to one.
 */

const test = require('node:test');
const assert = require('node:assert');
const { describeCandidateSource } = require('./candidate-provenance');

const EMAIL_ID = 'email:AAMkAGI1MjN1MjY3LTg5NGMtNGE4Ny1hMDU5LWFiYzEyMwAAAA==';

test('an email candidate is named by sender and subject, never by its id', () => {
  const d = describeCandidateSource({
    extractedFrom: 'email',
    sourcePath: EMAIL_ID,
    email: { from: 'Chris Middleton', subject: 'Headcount for Q4' },
  });
  assert.equal(d.kind, 'email');
  assert.match(d.label, /Chris Middleton/);
  assert.match(d.detail, /Headcount for Q4/);
  // NEGATIVE: the id may travel as a ref, but never as anything rendered.
  assert.ok(!d.label.includes('AAMk'), 'the message id must not reach the label');
  assert.ok(!String(d.detail).includes('AAMk'), 'the message id must not reach the detail');
  assert.equal(d.ref, EMAIL_ID);
});

test('an email with no sender recorded SAYS so rather than showing the id', () => {
  const d = describeCandidateSource({ extractedFrom: 'email', sourcePath: EMAIL_ID });
  assert.match(d.label, /not recorded/i);
  assert.ok(!d.label.includes('AAMk'));
  assert.equal(d.detail, null);
});

test('the email shape is recognised from the path prefix on rows written before extractedFrom', () => {
  const d = describeCandidateSource({ sourcePath: EMAIL_ID, email: { from: 'Naomi' } });
  assert.equal(d.kind, 'email');
  assert.match(d.label, /Naomi/);
});

test('a note candidate is named by the note, with the full path as detail', () => {
  const d = describeCandidateSource({
    sourcePath: 'Meetings/2026/08/2026-08-25 - Hope 1-2-1.md',
    sourceLine: 12,
  });
  assert.equal(d.kind, 'note');
  assert.equal(d.label, '2026-08-25 - Hope 1-2-1');
  assert.equal(d.context, 'Meetings note');
  assert.match(d.detail, /Meetings\/2026\/08\/.*:12$/);
});

test('nothing recorded is null, so a card renders nothing rather than asserting a source', () => {
  assert.equal(describeCandidateSource({}), null);
  assert.equal(describeCandidateSource(), null);
});

test('the Actions approval card describes a row through the same describer', () => {
  const presenter = require('./action-presenter');
  const out = presenter.describe({
    id: 1,
    type: 'capture_todo',
    payload: {
      text: 'Send Chris the headcount numbers',
      extractedFrom: 'email',
      sourcePath: EMAIL_ID,
      email: { from: 'Chris Middleton', subject: 'Headcount for Q4' },
    },
  });
  const from = out.fields.find((f) => f.label === 'From');
  assert.ok(from, 'the card must say where the suggestion came from');
  assert.match(from.value, /Chris Middleton/);
  assert.ok(!from.value.includes('AAMk'), 'the approval card must not show the message id either');
});
