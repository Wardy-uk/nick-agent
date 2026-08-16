'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { _nestedBridgeError, _bridgeKey } = require('./microsoft');

// #65 was filed as "the bridge fallback can't reply — map recipients in the
// bridge branch, ten lines". Probed against the deployed bridge on 16 Aug 2026,
// that branch CANNOT RUN: NOVA serves eight routes and `/mail/{id}` is not one
// of them, so the request falls past its bridge router into app auth and
// answers 401. Same for `/todo/lists`, `/todo/tasks` and `/planner/tasks`.
//
// The quieter failure is the one these tests exist for. A route that DOES
// exist answers **HTTP 200 with the failure nested in `data`** — NOVA's msgraph
// token is currently expired and `/mail` returns:
//   {ok:true, data:{error:"Failed to acquire token for account '…'"}}
// That used to be handed back as a payload. Callers read `.id` off it, got
// undefined, and returned null — so a dead bridge was indistinguishable from an
// empty mailbox, and nothing logged a word.

test('a 200 carrying a nested error is a failure, not a payload', () => {
  assert.equal(
    _nestedBridgeError({ error: "Failed to acquire token for account 'NickW@nurtur.tech'." }),
    "Failed to acquire token for account 'NickW@nurtur.tech'."
  );
});

test('a real payload is not mistaken for an error', () => {
  assert.equal(_nestedBridgeError({ id: 'AAMk', subject: 'Hello' }), null);
  assert.equal(_nestedBridgeError({ value: [] }), null);
});

test('an array payload is never an error — /mail returns collections', () => {
  // An array has no `error` property, but it can carry one at index 0 in some
  // shapes; treating a list as an error object would blank the inbox.
  assert.equal(_nestedBridgeError([{ error: 'nope' }]), null);
  assert.equal(_nestedBridgeError([]), null);
});

test('null, primitives and an empty error string are not errors', () => {
  assert.equal(_nestedBridgeError(null), null);
  assert.equal(_nestedBridgeError('a string'), null);
  assert.equal(_nestedBridgeError({ error: '' }), null);
});

// Health is keyed per path so the status endpoint can say WHICH path is dead.
// `/mail/<graph id>` and `/ticket/NT-123` would otherwise mint an entry per
// message and per ticket, and the map would grow with the mailbox.
test('parameterised paths collapse to one key, not one per message', () => {
  assert.equal(_bridgeKey('/mail/AAMkAGI1MjNlMjY3LTg5NGMtNGFiMC04MTEA'), '/mail/:id');
  assert.equal(_bridgeKey('/mail/AAMkSomethingElseEntirely'), '/mail/:id');
  assert.equal(_bridgeKey('/ticket/NT-27530'), '/ticket/:id');
});

test('static paths keep their own identity', () => {
  assert.equal(_bridgeKey('/mail'), '/mail');
  assert.equal(_bridgeKey('/todo/lists'), '/todo/lists');
  assert.equal(_bridgeKey('/planner/tasks'), '/planner/tasks');
  assert.equal(_bridgeKey('/escalation-reasons'), '/escalation-reasons');
});

test('a query string never forks the key', () => {
  // fetchTodoTasks passes listId, fetchCalendarEvents passes start/end.
  assert.equal(_bridgeKey('/todo/tasks?listId=AAA'), '/todo/tasks');
  assert.equal(_bridgeKey('/calendar?start=2026-08-16'), '/calendar');
});
