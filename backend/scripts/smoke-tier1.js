#!/usr/bin/env node
'use strict';

/**
 * Smoke script for Tier 1 services. NOT a test — it asserts nothing and passes
 * by not throwing.
 *
 * It is named `smoke-` rather than `test-` deliberately. `node --test` globs
 * `test-*.js`, so under the old name all four of these scripts were discovered
 * and counted in the suite total (4 of 435) while proving nothing — and this one
 * ran against the REAL vault, creating and deleting notes in it on every
 * `npm test`. Two consequences, both silent: Nick's live Syncthing-replicated
 * vault churned on every run, and a throw between create and unlink left a stray
 * note behind. It also made the suite count differ by machine, depending on
 * whether the hardcoded vault path resolved.
 *
 * Run with:
 *   OBSIDIAN_VAULT_PATH="..." node scripts/smoke-tier1.js
 *   OBSIDIAN_VAULT_PATH="..." node scripts/smoke-tier1.js --allow-writes
 *
 * There is deliberately NO default vault path. Defaulting to the real vault is
 * how this went unnoticed; an explicit path means the writes are always somewhere
 * the caller chose. Writes are off unless --allow-writes is passed, so pointing
 * this at the live vault reads it but never modifies it.
 */

if (!process.env.OBSIDIAN_VAULT_PATH) {
  console.error(
    'Refusing to run: set OBSIDIAN_VAULT_PATH explicitly.\n' +
    'There is no default — see the header. Point it at a scratch vault if you\n' +
    'intend to pass --allow-writes.'
  );
  process.exit(1);
}

const ALLOW_WRITES = process.argv.includes('--allow-writes');

const fs = require('fs');
const path = require('path');
const devPlan = require('../services/development-plan');
const actionItems = require('../services/action-items');
const meetingNote = require('../services/meeting-note');

const PERSON = 'Heidi Power';

function section(title) {
  console.log('\n' + '='.repeat(60));
  console.log(title);
  console.log('='.repeat(60));
}

async function run() {
  console.log('Vault:', process.env.OBSIDIAN_VAULT_PATH);
  console.log('Writes:', ALLOW_WRITES ? 'ENABLED (--allow-writes)' : 'disabled');

  section('1. readPlan(Heidi Power)');
  const plan = devPlan.readPlan(PERSON);
  console.log(JSON.stringify(plan, null, 2).substring(0, 1500));

  section('2. findActionItems(Heidi Power, open)');
  const actions = actionItems.findActionItems({ person: PERSON, status: 'open', daysBack: 90 });
  console.log(`Found ${actions.length} open actions`);
  for (const a of actions.slice(0, 5)) {
    console.log(`- ${a.text.substring(0, 80)} | assignee=${a.assignee || '-'} due=${a.dueDate || '-'} file=${a.file}`);
  }

  // The one-to-one-prep sections that used to sit here are gone. That service has
  // been unrouted since 14 Aug (NOVA's one21-service owns prep now), so smoke
  // coverage of it proved nothing about production — and generating a prep note
  // was one of the two writes landing in the real vault. This script was the last
  // thing in the repo that still required it; see #21.

  section('3. manageMeetingNote(create)');
  if (!ALLOW_WRITES) {
    console.log('[skipped] needs --allow-writes — this section creates a note.');
  } else {
    const testTitle = `NEURO Smoke Test ${Date.now()}`;
    const createResult = meetingNote.manageMeetingNote({
      action: 'create',
      title: testTitle,
      type: '1-1',
      people: [PERSON],
    });
    console.log(JSON.stringify(createResult, null, 2));
    if (createResult.status === 'created') {
      const full = path.join(process.env.OBSIDIAN_VAULT_PATH, createResult.path);
      fs.unlinkSync(full);
      console.log(`[cleanup] Deleted ${createResult.path}`);
    }
  }

  section('4. readPlan → updateProgress (parse only, never writes)');
  if (plan.status === 'ok' && plan.goals.length) {
    const g = plan.goals[0];
    console.log(`Would update Goal ${g.number}: "${g.title}" — progress entries before: ${g.progress.length}`);
  }

  section('DONE');
}

run().catch(e => { console.error('FAIL:', e); process.exit(1); });
