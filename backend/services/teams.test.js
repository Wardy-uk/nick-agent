'use strict';

/**
 * The Teams DM path is an UPGRADE on email, never a precondition for it (Q9).
 * These tests pin the two properties that make that true:
 *
 *  1. every failure comes back as `{ sent: false, reason }` and nothing throws;
 *  2. `getScopedToken` is used, so an unconsented Teams scope can never enter
 *     `GRAPH_SCOPES` and take Calendar/Mail/Tasks down with it.
 *
 * Both were verified live on the Pi on 15 Aug — `ChatMessage.Send` returns
 * AADSTS65001 while `getMailAccessStatus()` stays clean — but the live check is
 * a one-off and this is the thing that catches a regression later.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const MS_PATH = require.resolve('./microsoft');
const TEAMS_PATH = require.resolve('./teams');

/** Load teams.js against a stubbed microsoft.js. */
function loadTeams(microsoftStub, env = {}) {
  const prevEnv = { ...process.env };
  Object.assign(process.env, env);

  delete require.cache[TEAMS_PATH];
  const realMs = require.cache[MS_PATH];
  require.cache[MS_PATH] = { id: MS_PATH, filename: MS_PATH, loaded: true, exports: microsoftStub };

  try {
    return require('./teams');
  } finally {
    if (realMs) require.cache[MS_PATH] = realMs; else delete require.cache[MS_PATH];
    delete require.cache[TEAMS_PATH];
    process.env = prevEnv;
  }
}

test('an unconsented scope is reported, not thrown — and no email path is touched', async () => {
  let askedFor = null;
  const teams = loadTeams({
    getScopedToken: async (scopes) => {
      askedFor = scopes;
      return { token: null, reason: 'consent', error: 'AADSTS65001' };
    },
  });

  const result = await teams.sendDm({ email: 'abdi.mohamed@nurtur.tech', text: 'hello' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'consent');

  // The scope is requested ON ITS OWN. If this ever becomes part of the main
  // GRAPH_SCOPES list, acquireTokenSilent throws for everything.
  assert.deepEqual(askedFor, ['ChatMessage.Send']);
});

test('the kill switch is off-by-explicit-value, so an unset var is not a silent second gate', async () => {
  // ⚠ The switch is read at CALL time now, not captured at require time — that is
  // what lets the Settings toggle work without a pm2 restart. So the environment
  // has to be set around the CALL, not merely around the load; `loadTeams`
  // restores it in a finally.
  const stub = { getScopedToken: async () => ({ token: 'tok' }) };
  const teams = loadTeams(stub);

  const withEnv = async (value) => {
    const prev = process.env.TEAMS_DM_ENABLED;
    if (value === undefined) delete process.env.TEAMS_DM_ENABLED;
    else process.env.TEAMS_DM_ENABLED = value;
    try { return await teams.sendDm({ email: 'a@b.co', text: 'x' }); }
    finally {
      if (prev === undefined) delete process.env.TEAMS_DM_ENABLED;
      else process.env.TEAMS_DM_ENABLED = prev;
    }
  };

  assert.equal((await withEnv('false')).reason, 'disabled');

  // Unset must NOT mean disabled — consent is the real gate, and a second
  // invisible one is how a feature looks broken for reasons nobody can find.
  assert.notEqual((await withEnv(undefined)).reason, 'disabled');
});

test('no existing 1:1 chat falls back rather than trying to create one', async () => {
  // Creating a chat needs Chat.ReadWrite — a SECOND unconsented scope, for a
  // case email already covers. So this must report, not escalate.
  const teams = loadTeams({ getScopedToken: async () => ({ token: 'tok' }) });

  const realFetch = global.fetch;
  global.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ value: [{ chatType: 'oneOnOne', id: 'c1', members: [{ email: 'someone.else@nurtur.tech' }] }] }),
  });
  try {
    const r = await teams.sendDm({ email: 'abdi.mohamed@nurtur.tech', text: 'hi' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'no-chat');
  } finally {
    global.fetch = realFetch;
  }
});

test('a Graph failure mid-send is a reason, never an exception', async () => {
  const teams = loadTeams({ getScopedToken: async () => ({ token: 'tok' }) });

  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('socket hang up'); };
  try {
    const r = await teams.sendDm({ email: 'a@b.co', text: 'hi' });
    assert.equal(r.sent, false);
    assert.equal(r.reason, 'error');
    assert.match(r.error, /socket hang up/);
  } finally {
    global.fetch = realFetch;
  }
});

test('newlines survive into Teams, and the body is escaped', async () => {
  const teams = loadTeams({ getScopedToken: async () => ({ token: 'tok' }) });

  let posted = null;
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!opts || opts.method !== 'POST') {
      return { ok: true, status: 200, json: async () => ({ value: [{ chatType: 'oneOnOne', id: 'c1', members: [{ email: 'a@b.co' }] }] }) };
    }
    posted = JSON.parse(opts.body);
    return { ok: true, status: 201, json: async () => ({ id: 'm1' }) };
  };
  try {
    const r = await teams.sendDm({ email: 'a@b.co', text: 'Hi <Bob> &\nsecond line' });
    assert.equal(r.sent, true);
    // Teams renders HTML: posting raw text loses every line break.
    assert.match(posted.body.content, /second line/);
    assert.match(posted.body.content, /<br>/);
    assert.match(posted.body.content, /&lt;Bob&gt;/);
    assert.doesNotMatch(posted.body.content, /<Bob>/);
  } finally {
    global.fetch = realFetch;
  }
});

test('getSendStatus names what it is waiting on', async () => {
  const waiting = loadTeams({ getScopedToken: async () => ({ token: null, reason: 'consent' }) });
  const s = await waiting.getSendStatus();
  assert.equal(s.available, false);
  assert.equal(s.reason, 'consent');
  assert.match(s.detail, /Admin consent requests/);

  const live = loadTeams({ getScopedToken: async () => ({ token: 'tok' }) });
  assert.equal((await live.getSendStatus()).available, true);
});
