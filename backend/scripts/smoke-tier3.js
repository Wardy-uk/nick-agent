#!/usr/bin/env node
'use strict';

/**
 * Tier 3 smoke script — read-only + tmp-vault writes only. NOT a test; it
 * asserts nothing. Named `smoke-` so `node --test` does not discover it (see
 * smoke-tier1.js for why that mattered).
 *
 * Evidence Register and 90 Day Plan sections read the caller's vault. Person
 * profile and KB article writes go to a throwaway mkdtemp vault.
 *
 * Run with: OBSIDIAN_VAULT_PATH="..." node scripts/smoke-tier3.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.OBSIDIAN_VAULT_PATH) {
  console.error('Refusing to run: set OBSIDIAN_VAULT_PATH explicitly. There is no default.');
  process.exit(1);
}

const REAL_VAULT = process.env.OBSIDIAN_VAULT_PATH;

function section(t) { console.log('\n' + '='.repeat(60) + '\n' + t + '\n' + '='.repeat(60)); }

// ── Read-only tests against real vault ─────────────────────
process.env.OBSIDIAN_VAULT_PATH = REAL_VAULT;

const evidence = require('../services/evidence-register');
const checkpoint = require('../services/checkpoint-progress');
const weekly = require('../services/weekly-summary');
const gaps = require('../services/knowledge-gaps');

section('1. listEvidence()');
const ev = evidence.listEvidence();
console.log(`status=${ev.status}, outcomes=${ev.outcomes?.length}`);
for (const o of (ev.outcomes || []).slice(0, 3)) {
  console.log(`  ${o.title} — ${o.rowCount} rows`);
}

section('2. compareCheckpoint({day-30})');
const cp = checkpoint.compareCheckpoint({ checkpoint: 'day-30' });
console.log(`status=${cp.status}`);
if (cp.status === 'ok') {
  console.log(`  ${cp.checkpoint} (${cp.plan.date}) — ${cp.analysis.completionPct}% complete`);
  console.log(`  ${cp.analysis.covered}/${cp.analysis.total} deliverables covered`);
  console.log(`  Evidence entries: ${cp.evidence.count}`);
  console.log(`  Gaps:`);
  for (const g of (cp.analysis.gaps || []).slice(0, 3)) console.log(`    - ${g}`);
}

section('3. summarizeWeek() — this week');
const ws = weekly.summarizeWeek();
console.log(`status=${ws.status}, week ${ws.weekStart}..${ws.weekEnd}`);
console.log(`  counts:`, JSON.stringify(ws.counts));
console.log(`  markdown preview (first 400 chars):`);
console.log(ws.markdown.substring(0, 400));

section('4. findKnowledgeGaps()');
const kg = gaps.findKnowledgeGaps({ daysBack: 90 });
console.log(`status=${kg.status}`);
console.log(`  counts:`, JSON.stringify(kg.counts));
console.log(`  top 5 suggestions:`);
for (const s of (kg.suggestions || []).slice(0, 5)) {
  console.log(`    [${s.count}] ${s.topic.substring(0, 80)}`);
}

// ── Write tests against tmp vault ────────────────────────────
const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-tier3-'));
process.env.OBSIDIAN_VAULT_PATH = tmpVault;
// Invalidate require cache so services pick up new env
delete require.cache[require.resolve('../services/person-profile')];
delete require.cache[require.resolve('../services/kb-article')];
const personProfile = require('../services/person-profile');
const kb = require('../services/kb-article');

section('5. createPerson (tmp) → add_meeting → add_task → update');
let r = personProfile.managePersonProfile({
  action: 'create',
  person: 'Test Person',
  frontmatter: { role: 'Test Agent', team: 'QA', cadence: 'weekly' },
});
console.log(`  create: ${r.status} ${r.path}`);
r = personProfile.managePersonProfile({
  action: 'add_meeting',
  person: 'Test Person',
  meetingType: '1-2-1',
  notes: 'First check-in',
});
console.log(`  add_meeting: ${r.status} — ${(r.changes || []).join('; ')}`);
r = personProfile.managePersonProfile({
  action: 'add_task',
  person: 'Test Person',
  task: 'Review QA dashboard',
  accepted: true,
});
console.log(`  add_task: ${r.status} — ${(r.changes || []).join('; ')}`);
r = personProfile.managePersonProfile({
  action: 'update',
  person: 'Test Person',
  frontmatter: { 'next-1-2-1-due': '2026-05-01' },
});
console.log(`  update: ${r.status} — ${(r.changes || []).join('; ')}`);

console.log('\n--- resulting file ---');
console.log(fs.readFileSync(path.join(tmpVault, 'People', 'Test Person.md'), 'utf-8'));

section('6. createArticle + updateArticle (tmp)');
r = kb.manageKbArticle({ action: 'create', title: 'Feed Diagnostics', category: 'Feeds', tags: ['feeds', 'diagnostics'] });
console.log(`  create: ${r.status} ${r.path}`);
r = kb.manageKbArticle({ action: 'update', title: 'Feed Diagnostics', category: 'Feeds', tags: ['feeds', 'diagnostics', 'troubleshooting'] });
console.log(`  update tags: ${r.status} — ${(r.changes || []).join('; ')}`);
r = kb.manageKbArticle({ action: 'create', title: 'Feed Diagnostics', category: 'Feeds' });
console.log(`  create again (should refuse): ${r.status} ${r.error ? '— ' + r.error.substring(0, 80) : ''}`);

const kbFile = path.join(tmpVault, 'KB', 'Feeds', 'Feed Diagnostics.md');
console.log('\n--- KB file frontmatter ---');
console.log(fs.readFileSync(kbFile, 'utf-8').split('---').slice(0, 2).join('---') + '---');

section('7. manageEvidence (tmp) — with a synthetic register file');
// Seed a fake register
const fakeDir = path.join(tmpVault, 'Projects', '90 Day Plan');
fs.mkdirSync(fakeDir, { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'Evidence Register.md'), `# Evidence Register

> Updated: 2026-04-01

## Outcome 1 — Visibility

| Evidence | Location | Checkpoint |
|---|---|---|
| Baseline dashboard | https://example/dash | Day 15 |

## Outcome 2 — Tiered Model

| Evidence | Location | Checkpoint |
|---|---|---|
`, 'utf-8');

delete require.cache[require.resolve('../services/evidence-register')];
const evTmp = require('../services/evidence-register');
r = evTmp.manageEvidence({ action: 'add', outcome: '2', evidence: 'SOP — Technical Support', location: '[[SOP-001]]', checkpoint: 'Day 30' });
console.log(`  add: ${r.status} — ${(r.changes || []).join('; ')}`);
r = evTmp.manageEvidence({ action: 'add', outcome: '1', evidence: 'Trends panel', location: 'https://nova/#trends', checkpoint: 'Day 30' });
console.log(`  add #2: ${r.status} — ${(r.changes || []).join('; ')}`);
r = evTmp.manageEvidence({ action: 'update', outcome: '1', evidence: 'Baseline', location: 'https://example/dash-v2' });
console.log(`  update: ${r.status} — ${(r.changes || []).join('; ')}`);

console.log('\n--- resulting register ---');
console.log(fs.readFileSync(path.join(fakeDir, 'Evidence Register.md'), 'utf-8'));

// Cleanup
fs.rmSync(tmpVault, { recursive: true, force: true });
console.log(`\n[cleanup] removed ${tmpVault}`);

section('DONE');
