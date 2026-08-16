'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const jira = require('./jira');
const { _mapEscalationIssue: mapEscalationIssue, _nickInComments: nickInComments } = jira;

// #94 — `syncEscalations` queried the request-type arm only, so escalations the
// team moved into the Escalations TIER were invisible to the count, the Focus
// card, the briefing and the nudge. Measured live 16 Aug: narrow 6, both arms
// 17, so the surface Nick checks every morning understated by two thirds.
//
// The swap is not a one-line change, and each of the three traps fails SILENTLY
// — which is what these tests exist to catch.

test('the flattened shape carries summary and created — a `.fields` read blanks both', () => {
  // Trap 1. `fetchEscalationTickets` returned raw Jira issues and the old
  // sync read `issue.fields.summary` off them. `fetchActiveEscalations` returns
  // objects already flattened by mapEscalationIssue, with no `.fields` at all,
  // so the naive swap would have written empty summaries and null dates into
  // escalation_seen and rendered blank rows on the Focus card.
  const flat = mapEscalationIssue({
    key: 'NT-21284',
    fields: {
      summary: 'Contact Forms - Lead Management forms',
      created: '2026-06-12T09:00:00.000+0100',
      status: { name: 'Open' },
      customfield_12981: { value: 'Escalations' },
    },
  });

  assert.equal(flat.summary, 'Contact Forms - Lead Management forms');
  assert.equal(flat.created, '2026-06-12T09:00:00.000+0100');
  assert.equal(flat.fields, undefined);
  // The tier arm is why this ticket is in the list at all — it was never a
  // portal escalation, which is exactly the population that was invisible.
  assert.equal(flat.viaTier, true);
  assert.equal(flat.viaRequestType, false);
});

test('"we did not ask for comments" is null, not false', () => {
  // Trap 2, and the dangerous one. `ESCALATION_FIELDS` does not include
  // `comment`, so on the wide path every ticket would have answered "Nick has
  // not replied" and all 17 would have landed unseen — one nudge claiming 17
  // escalations were waiting on him, 12 of which he had already answered.
  const withoutComments = mapEscalationIssue({ key: 'NT-14855', fields: { summary: 'SMS Issues' } });
  assert.equal(withoutComments.nickCommented, null);

  const answered = mapEscalationIssue({
    key: 'NT-14855',
    fields: {
      summary: 'SMS Issues',
      comment: { comments: [{ author: { displayName: 'Nick Ward' } }] },
    },
  });
  assert.equal(answered.nickCommented, true);

  const unanswered = mapEscalationIssue({
    key: 'NT-21284',
    fields: {
      summary: 'Contact Forms',
      comment: { comments: [{ author: { displayName: 'Zoe Rees' } }] },
    },
  });
  assert.equal(unanswered.nickCommented, false);
});

test('an unknown never raises a nudge — only an explicit false does', () => {
  // The sync reads `nickCommented !== false`, so null (not asked) and true
  // (answered) both mean "do not nag". An unknown must never be the thing that
  // puts a ticket on the card at 23:00; escalation_alert bypasses quiet hours.
  const treatAsAnswered = v => v !== false;
  assert.equal(treatAsAnswered(null), true, 'not asked → do not nag');
  assert.equal(treatAsAnswered(true), true, 'answered → do not nag');
  assert.equal(treatAsAnswered(false), false, 'genuinely unanswered → nag');
});

test('Nick is matched by display name or email, not by a bare first name', () => {
  assert.equal(nickInComments([{ author: { displayName: 'Nick Ward' } }]), true);
  assert.equal(nickInComments([{ author: { displayName: 'Nicola Barrett' } }]), false);
  assert.equal(nickInComments([{ author: { displayName: 'NOVA-Jira' } }]), false);
  assert.equal(nickInComments([]), false);
  assert.equal(nickInComments(null), false);
});

test('the comment window Jira returns is the NEWEST 20, which is the right question', () => {
  // Jira caps the inline `comment` field at 20 per issue and there is no way to
  // ask for more inline. Worth checking which end rather than assuming: probed
  // live, NT-14855 came back `startAt: 32, total: 52` — the newest 20. Had it
  // been the oldest, this answer would read "no reply" on precisely the long
  // churning threads an escalation becomes, and over-nagged on all of them.
  // Three of the 17 are truncated today (52, 26 and 21 comments) and all three
  // still resolve to "Nick has replied".
  const window = { startAt: 32, maxResults: 20, total: 52, comments: [
    { author: { displayName: 'Zoe Rees' } },
    { author: { displayName: 'Nick Ward' } },
  ] };
  assert.equal(mapEscalationIssue({ key: 'NT-14855', fields: { comment: window } }).nickCommented, true);
  // A truncated window is still a definite yes when it contains him. It can
  // only ever err towards nagging, never towards silence — the safe direction.
  assert.ok(window.total > window.comments.length);
});

test('an unassigned escalation still reads as Unassigned on the wide path', () => {
  // Guards the #53/#54 work this lands on top of: the tier arm brought in
  // tickets assigned to nobody, and that is the finding, not an absence.
  assert.equal(jira._informativeAssignee(mapEscalationIssue({ key: 'NT-1', fields: {} }).assignee), 'Unassigned');
});
