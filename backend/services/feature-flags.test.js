'use strict';

// The switches that are Nick's decision, and the precedence between the three
// places an answer can come from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-flags-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');

const db = require('../db/database');
const flags = require('./feature-flags');

const ENV_VARS = flags.FLAGS.map((f) => f.env);

test.before(async () => { await db.init(); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

test.beforeEach(() => {
  for (const v of ENV_VARS) delete process.env[v];
  for (const f of flags.FLAGS) db.setState(`${flags.STATE_PREFIX}${f.key}`, '');
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ The two default polarities. Getting either backwards silently changes live
// behaviour the moment this ships.
// ─────────────────────────────────────────────────────────────────────────────

test('an opt-in switch defaults OFF — it writes to the outside world', () => {
  // The day planner books real calendar events on a timer.
  assert.equal(flags.isEnabled('day_planner'), false);
  assert.equal(flags.isEnabled('day_planner_health'), false);
  assert.equal(flags.isEnabled('dnd_vault_read_only'), false);
  // Creates real tasks in the list Nick uses to decide what to do next, and
  // closes them when the ticket closes. Deliberately opt-in.
  assert.equal(flags.isEnabled('jira_assigned_sync'), false);
});

test('the Jira assigned-sync switch is offered in Settings, env-named and impact-labelled', () => {
  // The switch existed as an env var only, so turning it on meant an SSH
  // session, an .env edit and a pm2 restart. It is a menu option now, and the
  // panel needs the env name to say WHY a locked switch cannot be changed.
  const row = flags.list().find((f) => f.key === 'jira_assigned_sync');
  assert.ok(row, 'jira_assigned_sync must appear in the switch list');
  assert.equal(row.envVar, 'JIRA_ASSIGNED_SYNC_ENABLED');
  assert.equal(row.default, false);
  assert.ok(row.impact, 'a switch that writes tasks must declare an impact');
  assert.equal(row.requires, null);
});

test('a KILL SWITCH defaults ON — flipping it would disable working behaviour', () => {
  // These guard behaviour that is already live and wanted; defaulting them off
  // would silently switch a working feature off the day this shipped.
  assert.equal(flags.isEnabled('capture_dedupe'), true);
  assert.equal(flags.isEnabled('teams_dm'), true);
});

// ─────────────────────────────────────────────────────────────────────────────
// Precedence: env, then stored, then default.
// ─────────────────────────────────────────────────────────────────────────────

test('a stored value overrides the default, in both directions', () => {
  flags.setEnabled('day_planner', true);
  assert.equal(flags.isEnabled('day_planner'), true);

  flags.setEnabled('capture_dedupe', false);
  assert.equal(flags.isEnabled('capture_dedupe'), false);
});

test('the ENVIRONMENT wins over a stored value', () => {
  // A deployment that pins behaviour must never be silently overridden by
  // something toggled in a browser.
  flags.setEnabled('day_planner', true);
  process.env.DAY_PLANNER_ENABLED = 'false';
  assert.equal(flags.isEnabled('day_planner'), false);
});

test('an env-pinned switch REFUSES the toggle and says why', () => {
  process.env.DAY_PLANNER_ENABLED = 'true';
  const result = flags.setEnabled('day_planner', false);
  assert.equal(result.ok, false);
  assert.match(result.error, /DAY_PLANNER_ENABLED/);
  assert.equal(flags.isEnabled('day_planner'), true, 'and the refusal must not have changed it');
});

test('⚠ an EMPTY env var is "not set", not an explicit false', () => {
  // The kill switches read `!== "false"`, so an empty string reading as an
  // explicit choice would flip a default-on switch off for no stated reason.
  process.env.CAPTURE_DEDUPE_ENABLED = '';
  assert.equal(flags.isEnabled('capture_dedupe'), true);

  process.env.DAY_PLANNER_ENABLED = '';
  flags.setEnabled('day_planner', true);
  assert.equal(flags.isEnabled('day_planner'), true, 'an empty var must not block the toggle');
});

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies.
// ─────────────────────────────────────────────────────────────────────────────

test('a dependent switch is OFF while its parent is, whatever it says itself', () => {
  // Otherwise the panel shows "lighter plan on a low-recovery day" as ON while
  // the planner that would act on it is not running — a claim about behaviour
  // that cannot happen.
  flags.setEnabled('day_planner_health', true);
  assert.equal(flags.isEnabled('day_planner'), false);
  assert.equal(flags.isEnabled('day_planner_health'), false);

  flags.setEnabled('day_planner', true);
  assert.equal(flags.isEnabled('day_planner_health'), true);
});

test('list() names WHY a dependent switch is off, rather than just showing it off', () => {
  flags.setEnabled('day_planner_health', true);
  const health = flags.list().find((f) => f.key === 'day_planner_health');
  assert.equal(health.enabled, false);
  assert.equal(health.blockedBy, 'day_planner');
});

// ─────────────────────────────────────────────────────────────────────────────
// The panel's payload.
// ─────────────────────────────────────────────────────────────────────────────

test('list() reports lockedByEnv so the UI disables the control instead of lying', () => {
  process.env.TEAMS_DM_ENABLED = 'false';
  const teams = flags.list().find((f) => f.key === 'teams_dm');
  assert.equal(teams.lockedByEnv, true);
  assert.equal(teams.enabled, false);
  assert.equal(teams.envVar, 'TEAMS_DM_ENABLED');
});

test('every flag carries a label and a description', () => {
  for (const f of flags.list()) {
    assert.ok(f.label && f.label.length > 3, `${f.key} has no label`);
    assert.ok(f.description && f.description.length > 20, `${f.key} has no description`);
  }
});

test('an unknown switch is false and cannot be set', () => {
  assert.equal(flags.isEnabled('does_not_exist'), false);
  assert.equal(flags.setEnabled('does_not_exist', true).ok, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ The reason this exists at all.
// ─────────────────────────────────────────────────────────────────────────────

test('the value is read at CALL time, so a toggle needs no restart', () => {
  // Every one of these used to be a module-level const captured at require time,
  // which is why changing one meant an SSH session and a pm2 restart. Moving the
  // value to the DB without moving the READ would have changed nothing.
  assert.equal(flags.isEnabled('day_planner'), false);
  flags.setEnabled('day_planner', true);
  assert.equal(flags.isEnabled('day_planner'), true, 'no reload happened between these two lines');
});
