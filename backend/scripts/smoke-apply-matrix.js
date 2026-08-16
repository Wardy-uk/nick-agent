#!/usr/bin/env node
'use strict';

/**
 * Smoke test for applyMatrixToVault — simulates the payload n8n will POST
 * to /api/training/apply-matrix. Writes to a throwaway vault under /tmp so
 * it never touches the real one.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-vault-'));
fs.mkdirSync(path.join(tmpVault, 'People'), { recursive: true });
fs.writeFileSync(
  path.join(tmpVault, 'People', 'Heidi Power.md'),
  `---\ntype: person\nrole: CSA\n---\n\n## Notes\n- Probation passed.\n`,
  'utf-8'
);
process.env.OBSIDIAN_VAULT_PATH = tmpVault;

const { applyMatrixToVault } = require('../services/training-sync');

const payload = {
  categories: [
    { id: 1, name: 'Hub', sort_order: 0 },
    { id: 2, name: 'Valuation', sort_order: 1 },
  ],
  items: [
    { id: 10, category_id: 1, section: '', name: 'Hub Overview', tech_lead: 'Chris', max_score: 5, sort_order: 0 },
    { id: 11, category_id: 1, section: '', name: 'Hub Advanced', tech_lead: 'Chris', max_score: 5, sort_order: 1 },
    { id: 20, category_id: 2, section: 'IVT', name: 'Basics', tech_lead: null, max_score: 5, sort_order: 0 },
  ],
  scores: [
    { item_id: 10, user_id: 505, score: 4, updated_at: '2026-04-10T00:00:00Z' },
    { item_id: 11, user_id: 505, score: 2, updated_at: '2026-04-10T00:00:00Z' },
    { item_id: 20, user_id: 505, score: 3, updated_at: '2026-04-10T00:00:00Z' },
  ],
  memberIds: [505],
  users: [
    { id: 505, username: 'heidip', display_name: 'Heidi Power', email: 'h@x', role: 'agent' },
  ],
};

const result = applyMatrixToVault(payload);
console.log(JSON.stringify(result, null, 2));

console.log('\n--- Training Matrix.md ---');
console.log(fs.readFileSync(path.join(tmpVault, 'Documents', 'Training', 'Training Matrix.md'), 'utf-8'));

console.log('\n--- People/Heidi Power.md ---');
console.log(fs.readFileSync(path.join(tmpVault, 'People', 'Heidi Power.md'), 'utf-8'));

console.log('\n--- Validation ---');
const errorCases = [
  { label: 'missing categories',  bad: { items: [], scores: [], users: [] } },
  { label: 'empty users',         bad: { categories: [], items: [], scores: [], users: [] } },
  { label: 'null payload',        bad: null },
];
for (const c of errorCases) {
  const r = applyMatrixToVault(c.bad);
  console.log(`  ${c.label}: ${r.status} — ${r.error || '(no error)'}`);
}

// Cleanup
fs.rmSync(tmpVault, { recursive: true, force: true });
console.log(`\n[cleanup] removed ${tmpVault}`);
