'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSemanticSignature, extractActionCandidates, shouldSkipPath } = require('./action-candidates');

test('extractActionCandidates finds explicit note actions and auto-promotes clear checkboxes', () => {
  const text = [
    '# Meeting',
    '',
    '## Actions',
    '- [ ] Send Willem the probation draft',
    '- Review SLA exceptions before lunch',
    '',
    'Follow up: chase finance for approval',
  ].join('\n');

  const actions = extractActionCandidates(text, 'Meetings/2026-07-10-probation.md');
  assert.equal(actions.length, 3);
  assert.equal(actions[0].text, 'Send Willem the probation draft');
  assert.equal(actions[0].autoPromote, true);
  assert.equal(actions[1].text, 'Review SLA exceptions before lunch');
  assert.equal(actions[1].autoPromote, false);
  assert.equal(actions[2].text, 'chase finance for approval');
});

test('shouldSkipPath avoids task files and daily notes to prevent duplicate extraction', () => {
  assert.equal(shouldSkipPath('Tasks/Master Todo.md'), true);
  assert.equal(shouldSkipPath('Daily/2026-07-10.md'), true);
  assert.equal(shouldSkipPath('Meetings/2026-07-10.md'), false);
});

test('buildSemanticSignature stays stable across minor wording changes', () => {
  const a = buildSemanticSignature('Follow up with finance for approval');
  const b = buildSemanticSignature('Follow-up with finance for approval.');
  assert.equal(a, b);
});
