'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const triage = require('./meeting-triage');

const NOW = new Date(2026, 7, 14, 9, 0);
const IN_3_DAYS = new Date(2026, 7, 17, 10, 0).toISOString();

function meeting(over = {}) {
  return {
    id: 'evt-1',
    subject: 'Catch up',
    bodyPreview: '',
    start: IN_3_DAYS,
    isOrganizer: false,
    isCancelled: false,
    type: 'singleInstance',
    responseStatus: 'notResponded',
    organizer: { name: 'Chris Middleton', address: 'chris@nurtur.tech' },
    attendees: [
      { email: 'nick@nurtur.tech' }, { email: 'chris@nurtur.tech' }, { email: 'sam@nurtur.tech' },
    ],
    ...over,
  };
}

test('a vague invite with no body gets chased', () => {
  const v = triage.assess(meeting(), { now: NOW });
  assert.equal(v.chase, true);
  assert.match(v.reason, /no body/);
});

test('a body that states the purpose is left alone', () => {
  const v = triage.assess(meeting({
    bodyPreview: 'Agenda: review Q3 SLA performance, decide whether we change the tiering, and agree owners for the follow-up actions before month end.',
  }), { now: NOW });
  assert.equal(v.chase, false);
});

test('a Teams join blurb is not an agenda', () => {
  // This is the failure that would make the feature untrustworthy: every Teams
  // invite carries hundreds of characters of boilerplate.
  const v = triage.assess(meeting({
    bodyPreview: '________________________________________ Microsoft Teams meeting Join the meeting now Meeting ID: 123 456 789 Passcode: abcdef Dial in by phone +44 20 1234 5678 Find a local number For organizers: Meeting options',
  }), { now: NOW });
  assert.equal(v.chase, true, 'boilerplate must be stripped before judging length');
});

test('a subject that carries the purpose needs no chaser', () => {
  const v = triage.assess(meeting({ subject: 'Decide Q4 pricing for the Guild accounts' }), { now: NOW });
  assert.equal(v.chase, false);
  assert.match(v.reason, /subject/);
});

test('the cases that must never be chased', () => {
  const cases = [
    ['your own meeting', { isOrganizer: true }],
    ['a cancelled meeting', { isCancelled: true }],
    ['one already accepted', { responseStatus: 'accepted' }],
    ['an occurrence of a recurring series', { type: 'occurrence' }],
    ['a one-to-one', { attendees: [{ email: 'nick@nurtur.tech' }, { email: 'chris@nurtur.tech' }] }],
    ['one starting within two hours', { start: new Date(2026, 7, 14, 10, 0).toISOString() }],
    ['one more than a fortnight out', { start: new Date(2026, 8, 30, 10, 0).toISOString() }],
  ];
  for (const [label, over] of cases) {
    assert.equal(triage.assess(meeting(over), { now: NOW }).chase, false, `should not chase ${label}`);
  }
});

test('the chaser asks for the outcome, not for a document', () => {
  const text = triage.buildChaser(meeting());
  assert.match(text, /what would you like to get out of it/i);
  // "Send me an agenda" reads as process for its own sake and gets ignored.
  assert.doesNotMatch(text, /provide an agenda|send (me )?an agenda/i);
});

test('the chaser never implies the meeting is unnecessary, and always offers the out', () => {
  const text = triage.buildChaser(meeting());
  assert.match(text, /happy to join either way/i);
  const dismissive = /do (i|we) (really )?need|is this necessary|why am i|waste|pointless|decline unless|before i accept/i;
  assert.doesNotMatch(text, dismissive);
});

test('the wording is the same whoever it goes to — it only swaps the name', () => {
  // The policy applies to everyone, so the words must be defensible sent to
  // anyone. Two very different recipients should differ by first name alone.
  const toCeo = triage.buildChaser(meeting({ organizer: { name: 'Chris Middleton', address: 'c@x' } }));
  const toReport = triage.buildChaser(meeting({ organizer: { name: 'Heidi Power', address: 'h@x' } }));
  assert.equal(toCeo.replace('Chris', 'NAME'), toReport.replace('Heidi', 'NAME'));
});

test('boilerplate stripping leaves real words behind', () => {
  const stripped = triage.stripBoilerplate('<p>Review the&nbsp;numbers</p> https://teams.microsoft.com/l/x Meeting ID: 1');
  assert.match(stripped, /Review the numbers/);
  assert.doesNotMatch(stripped, /teams\.microsoft\.com|Meeting ID/);
});
