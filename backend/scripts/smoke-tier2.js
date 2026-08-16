#!/usr/bin/env node
'use strict';

/**
 * Smoke script for Tier 2 services. NOT a test; it asserts nothing. Named
 * `smoke-` so `node --test` does not discover it (see smoke-tier1.js for why).
 * Read-only — does not write anything.
 *
 * Run with: OBSIDIAN_VAULT_PATH="..." node scripts/smoke-tier2.js
 */

if (!process.env.OBSIDIAN_VAULT_PATH) {
  console.error('Refusing to run: set OBSIDIAN_VAULT_PATH explicitly. There is no default.');
  process.exit(1);
}

const personTimeline = require('../services/person-timeline');
const teamHealth = require('../services/team-health');

function section(t) { console.log('\n' + '='.repeat(60) + '\n' + t + '\n' + '='.repeat(60)); }

section('1. getTimeline(Heidi Power, 60d)');
const tl = personTimeline.getTimeline({ person: 'Heidi Power', daysBack: 60 });
console.log(`status=${tl.status} total=${tl.counts?.total}`);
console.log(JSON.stringify(tl.counts, null, 2));
console.log('\nFirst 10 events:');
for (const e of (tl.events || []).slice(0, 10)) {
  console.log(`  ${e.date}  [${e.type}]  ${e.title.substring(0, 70)}`);
}

section('2. teamHealthSnapshot() — all teams');
const th = teamHealth.teamHealthSnapshot();
console.log(`status=${th.status}`);
console.log(JSON.stringify(th.counts, null, 2));
console.log('\nTop 15 issues:');
for (const i of (th.issues || []).slice(0, 15)) {
  const dot = i.severity === 'high' ? '🔴' : i.severity === 'med' ? '🟡' : '⚪';
  console.log(`  ${dot} ${i.person.padEnd(20)} ${i.type.padEnd(22)} ${i.title}`);
}

section('3. teamHealthSnapshot({team: "1st Line Customer Care"})');
const th2 = teamHealth.teamHealthSnapshot({ team: '1st Line Customer Care' });
console.log(`status=${th2.status}  counts:`, JSON.stringify(th2.counts));
console.log('People in team:');
for (const p of th2.perPerson || []) {
  console.log(`  ${p.name.padEnd(22)} — ${p.issues.length} issue(s)`);
}

section('4. Error: unknown person');
console.log(personTimeline.getTimeline({ person: 'Nonexistent Person' }));

section('DONE');
