'use strict';

// The credential: stored in the DB so it can be pasted into the panel, and never
// readable back out.
//
// This exists because the first cut required an SSH session, a `read -rsp`, an
// append to .env and a pm2 restart to set one value — six steps of friction on
// the system whose stated premise is that Nick's bottleneck is initiation.
// NEURO already stored the OpenRouter key in `agent_state` and pasted it into a
// panel; this follows that rather than inventing a second, worse way.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-token-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
delete process.env.NOTION_TOKEN;

const db = require('../../db/database');
const notion = require('./notion-api');
const config = require('./config');

test.before(async () => { await db.init(); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test.beforeEach(() => {
  delete process.env.NOTION_TOKEN;
  delete process.env.NOTION_SYNC_ENABLED;
  db.setState(notion.TOKEN_KEY, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// Storage and precedence.
// ─────────────────────────────────────────────────────────────────────────────

test('with nothing set, it is not configured and names no source', () => {
  assert.equal(notion.isConfigured(), false);
  assert.equal(notion.credentialSource(), null);
});

test('a token pasted into the panel configures it with no restart', () => {
  // Read at CALL time, not bootstrapped into process.env at startup — that is
  // what makes the paste take effect immediately.
  assert.equal(notion.setStoredToken('ntn_abc123').ok, true);
  assert.equal(notion.isConfigured(), true);
  assert.equal(notion.credentialSource(), 'stored');
});

test('the environment WINS over a stored token', () => {
  // A deployment that pins the credential must never be silently overridden by
  // something typed into a browser.
  notion.setStoredToken('ntn_stored');
  process.env.NOTION_TOKEN = 'ntn_from_env';
  assert.equal(notion.credentialSource(), 'env');
});

test('clearing a stored token reports whether the environment still supplies one', () => {
  notion.setStoredToken('ntn_stored');
  process.env.NOTION_TOKEN = 'ntn_from_env';
  const result = notion.clearStoredToken();
  assert.equal(result.stillInEnv, true, 'a UI claiming "disconnected" here would be lying');
  assert.equal(notion.isConfigured(), true);
});

test('a malformed token is refused with a reason, not stored', () => {
  const result = notion.setStoredToken('hunter2');
  assert.equal(result.ok, false);
  assert.match(result.error, /Notion integration token/);
  assert.equal(notion.isConfigured(), false);
});

test('an empty token is refused rather than storing a blank that reads as configured', () => {
  assert.equal(notion.setStoredToken('').ok, false);
  assert.equal(notion.setStoredToken('   ').ok, false);
});

test('whitespace around a pasted token is trimmed', () => {
  // Copying from a browser routinely brings a trailing newline.
  assert.equal(notion.setStoredToken('  ntn_abc123\n').ok, true);
  assert.equal(db.getState(notion.TOKEN_KEY), 'ntn_abc123');
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ The token must never come back out.
// ─────────────────────────────────────────────────────────────────────────────

test('nothing the module exports returns the token itself', () => {
  notion.setStoredToken('ntn_SUPERSECRET');
  const exposed = JSON.stringify({
    configured: notion.isConfigured(),
    credentialSource: notion.credentialSource(),
    cleared: notion.clearStoredToken(),
  });
  assert.ok(!exposed.includes('SUPERSECRET'), 'the credential leaked through a status field');
});

// ─────────────────────────────────────────────────────────────────────────────
// The cron switch — same friction, same fix.
// ─────────────────────────────────────────────────────────────────────────────

test('automatic sync defaults OFF', () => {
  assert.equal(config.autoSyncEnabled(), false);
});

test('the toggle turns it on without a restart', () => {
  // Checked inside the tick rather than when the cron is registered, so this is
  // live at the next quarter hour.
  config.setAutoSync(true);
  assert.equal(config.autoSyncEnabled(), true);
  config.setAutoSync(false);
  assert.equal(config.autoSyncEnabled(), false);
});

test('NOTION_SYNC_ENABLED forces it on and the toggle cannot override it', () => {
  process.env.NOTION_SYNC_ENABLED = 'true';
  config.setAutoSync(false);
  assert.equal(config.autoSyncEnabled(), true, 'the environment must win');
  assert.equal(config.autoSyncForcedByEnv(), true, 'and the panel must be able to SAY so');
});

test('a non-"true" env value does not enable it', () => {
  for (const v of ['1', 'yes', 'TRUE', '']) {
    process.env.NOTION_SYNC_ENABLED = v;
    assert.equal(config.autoSyncForcedByEnv(), false, `"${v}" should not force it on`);
  }
});
