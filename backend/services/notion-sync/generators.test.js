'use strict';

// Pages NEURO writes from its own state.
//
// Two properties matter more than the wording, and both are failures that would
// be invisible in production: a body that changes on its own (churn), and a
// source that failed reading as "nothing there" (a confident lie to an external
// AI).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notion-gen-'));
process.env.NEURO_DB_PATH = path.join(tmp, 'scratch.db');
process.env.OBSIDIAN_VAULT_PATH = tmp;

const db = require('../../db/database');
const generators = require('./generators');
const vaultLib = require('./vault');
const blocks = require('./blocks');

test.before(async () => { await db.init(); });
test.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ Churn. This runs every 15 minutes.
// ─────────────────────────────────────────────────────────────────────────────

test('generating twice produces the SAME body — no clock in the output', () => {
  // The push decision is a hash of this body. Anything that moves on its own —
  // a timestamp, an "as of", an age in days — rewrites three Notion pages every
  // quarter of an hour for ever.
  return Promise.all([
    generators.generate('current_priorities'),
    generators.generate('current_problems'),
  ]).then(async ([a1, b1]) => {
    const [a2, b2] = await Promise.all([
      generators.generate('current_priorities'),
      generators.generate('current_problems'),
    ]);
    assert.equal(vaultLib.contentHash(a2.markdown), vaultLib.contentHash(a1.markdown),
      'current_priorities is not stable between runs');
    assert.equal(vaultLib.contentHash(b2.markdown), vaultLib.contentHash(b1.markdown),
      'current_problems is not stable between runs');
  });
});

test('no generated body contains a date or time', async () => {
  // A blanket ban rather than a list of known offenders: the next generator
  // someone adds must not be able to reintroduce this quietly.
  for (const name of Object.keys(generators.GENERATORS)) {
    const { markdown } = await generators.generate(name);
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(markdown), `${name} contains an ISO timestamp`);
    assert.ok(!/\b\d{1,2}:\d{2}\b/.test(markdown), `${name} contains a clock time`);
    assert.ok(!/\bas of\b/i.test(markdown), `${name} says "as of"`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ Honesty. This is read by an external AI that will answer from it.
// ─────────────────────────────────────────────────────────────────────────────

test('a source that cannot be read is NAMED on the page, never omitted', async () => {
  // A vanished section reads as "no escalations", which is a confident lie.
  const jira = require('../jira');
  const real = jira.fetchActiveEscalations;
  jira.fetchActiveEscalations = async () => { throw new Error('Jira unreachable'); };
  try {
    const { markdown, gaps } = await generators.generate('current_problems');
    assert.ok(gaps.length, 'the failure must be reported as a gap');
    assert.match(markdown, /Incomplete/, 'and it must appear ON the page');
    assert.match(markdown, /NOT an all-clear/,
      'the section must say it could not be read, not fall silent');
  } finally { jira.fetchActiveEscalations = real; }
});

test('every generated page says it is generated and that editing it does nothing', async () => {
  for (const name of Object.keys(generators.GENERATORS)) {
    const { markdown } = await generators.generate(name);
    assert.match(markdown, /Written by NEURO/, `${name} does not identify itself`);
    assert.match(markdown, /replaced on the next sync/,
      `${name} must warn that a Notion edit is discarded`);
  }
});

test('an unknown generator REFUSES rather than publishing an empty page', async () => {
  const result = await generators.generate('does_not_exist');
  assert.equal(result.ok, false);
  assert.ok(result.gaps.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// It has to survive the converter it will be pushed through.
// ─────────────────────────────────────────────────────────────────────────────

test('generated markdown converts to Notion blocks and round-trips stably', async () => {
  for (const name of Object.keys(generators.GENERATORS)) {
    const { markdown } = await generators.generate(name);
    const asBlocks = blocks.markdownToBlocks(markdown, { keep: [], strict: false });
    assert.ok(asBlocks.length > 0, `${name} produced no blocks`);

    // The same stability property the whole sync rests on.
    const back = blocks.blocksToMarkdown(asBlocks);
    const again = blocks.blocksToMarkdown(
      blocks.markdownToBlocks(back.markdown, { keep: back.keep }),
    ).markdown;
    assert.equal(again, back.markdown, `${name} is not round-trip stable`);
  }
});

test('a generated page is small — it is a briefing, not a database dump', async () => {
  for (const name of Object.keys(generators.GENERATORS)) {
    const { markdown } = await generators.generate(name);
    const asBlocks = blocks.markdownToBlocks(markdown, { keep: [], strict: false });
    assert.ok(asBlocks.length < 200,
      `${name} produced ${asBlocks.length} blocks — too long to be useful context`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ⚠ A preview must not be recorded as a sync.
// ─────────────────────────────────────────────────────────────────────────────

test('a dry run writes to last_preview, never to last_run', () => {
  // It was unconditional, so hitting "Preview changes" replaced "what the sync
  // last did" with "what a preview would have done" — a run that wrote nothing,
  // reported with counts that look like work. Found because a lock held at 12:15
  // sat beside a lastRun stamped 12:17, and a dry run takes no lock, so they
  // could not be the same run.
  const fs2 = require('fs');
  const path2 = require('path');
  const src = fs2.readFileSync(path2.join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /dryRun \? 'notion_sync_last_preview' : 'notion_sync_last_run'/,
    'the run record must be keyed on whether it actually wrote');
});

test('the lock is inspectable and releasable', () => {
  // A run killed mid-flight (a deploy restarting the backend is the normal way
  // here) never reaches its finally, so the lock stays held and every pass is
  // refused for 15 minutes while looking exactly like "nothing to do".
  const sync = require('./index');
  assert.equal(typeof sync.lockStatus, 'function');
  assert.equal(typeof sync.releaseLockManually, 'function');
  const status = sync.lockStatus();
  assert.ok('held' in status && 'stale' in status);
});
