#!/usr/bin/env node
'use strict';

/**
 * Put the hub link on outcome notes written before the generator did it.
 *
 * `task-blocks` stamps `_Part of [[MOC - Tasks]]_` into every new outcome note
 * (7 Sep 2026). The ones already on disk are orphans — 15 of the vault's 58 on
 * the day this was written, all of them notes NEURO produced itself.
 *
 * ⚠ Dry run by default. `--apply` writes.
 *
 * ⚠ It appends INSIDE the hub fence, which is what keeps it from changing any
 * note's release verdict: `isOutcomeWritten` strips fenced content, so a note
 * still awaiting a write-up stays awaiting one, and a note already written up
 * stays written up. The script asserts that per file rather than trusting it —
 * a backfill that silently marked held work done would be the worst possible
 * outcome of a tidy-up.
 *
 * Idempotent: a note already carrying the fence is skipped.
 */

const fs = require('fs');
const path = require('path');
const tb = require('../services/task-blocks');

const APPLY = process.argv.includes('--apply');
const root = process.env.OBSIDIAN_VAULT_PATH || '';

if (!root) {
  console.error('OBSIDIAN_VAULT_PATH is not set — refusing to guess a vault.');
  process.exit(1);
}
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error(`Vault not readable at ${root} — refusing.`);
  process.exit(1);
}

const HUB_BLOCK = [tb.HUB_OPEN, `_Part of [[${tb.OUTCOME_HUB}]]_`, tb.HUB_CLOSE, ''].join('\n');

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) acc.push(full);
  }
  return acc;
}

const dir = path.join(root, tb.OUTCOMES_DIR);
const files = walk(dir);

let skipped = 0;
const planned = [];
const refused = [];

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const rel = path.relative(root, file).split(path.sep).join('/');

  if (raw.includes(tb.HUB_OPEN)) { skipped++; continue; }

  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const next = (raw.endsWith('\n') ? raw : raw + nl) + nl + HUB_BLOCK.split('\n').join(nl);

  // The whole safety of this script, checked per file rather than assumed.
  const before = tb.isOutcomeWritten(raw);
  const after = tb.isOutcomeWritten(next);
  if (before.written !== after.written || before.chars !== after.chars) {
    refused.push({ rel, before, after });
    continue;
  }

  planned.push({ rel, next, file });
}

console.log(`${files.length} outcome notes · ${skipped} already linked · ${planned.length} to link · ${refused.length} refused`);
for (const p of planned) console.log(`  + ${p.rel}`);
for (const r of refused) {
  console.log(`  ! ${r.rel} — REFUSED: the hub would change its verdict (${r.before.chars} -> ${r.after.chars} chars)`);
}

if (!APPLY) {
  console.log('\nDry run. Re-run with --apply to write.');
  process.exit(refused.length ? 1 : 0);
}

let written = 0;
for (const p of planned) {
  try {
    fs.writeFileSync(p.file, p.next, 'utf8');
    written++;
  } catch (e) {
    console.error(`  x ${p.rel} — ${e.message}`);
  }
}
console.log(`\nWrote ${written} of ${planned.length}.`);
process.exit(refused.length ? 1 : 0);
