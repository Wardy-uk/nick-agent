#!/usr/bin/env node
'use strict';

/**
 * Write the Scriptable widget into the vault as a Markdown note.
 *
 * Why: the widget reaches the phone by being COPIED AS TEXT, and the QR →
 * Safari → Select All route is both fiddly and lossy (it ate a backslash and
 * produced a syntax error). The vault already syncs to the phone and Obsidian
 * puts a copy button on every code block, so this is one tap instead of five.
 *
 * It lands in `Scripts/`, which `vault-exclusions` already treats as a
 * TRANSIENT dir — so a few hundred lines of JavaScript never reach the
 * embeddings index or entity extraction. Putting it anywhere else would make
 * the widget's source outrank real notes on half the vault's queries.
 *
 * The copy only has to be good enough to bootstrap once: the script
 * self-updates from GitHub on its first in-app run, so a stale export corrects
 * itself rather than persisting.
 *
 *   node backend/scripts/export-widget-to-vault.js [--dry-run]
 *
 * OBSIDIAN_VAULT_PATH overrides the vault location.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_VAULT = 'C:\\Users\\NickW\\Documents\\Nicks knowledge base';
const REL_OUT = path.join('Scripts', 'SARA Widget (Scriptable).md');

function build(src, version, stamp) {
  // Four backticks, because the script itself contains template literals. It
  // has no triple-backtick run today, and a wider fence means it never matters
  // if one is added later.
  const fence = '`'.repeat(4);

  return [
    '---',
    'type: reference',
    'tags: [neuro, sara, widget, scriptable]',
    `updated: ${stamp}`,
    `widget-version: ${version}`,
    '---',
    '',
    '# SARA Widget (Scriptable)',
    '',
    'The iOS home-screen and lock-screen widget for NEURO. It lives here so it can',
    'be copied straight into Scriptable on the phone, rather than going via a QR',
    'code and Safari — that route mangles backslashes, which is why the script is',
    'written without a single one.',
    '',
    '> [!tip] Copying it',
    '> Switch to **Reading view** and tap the copy button at the top-right of the',
    '> code block. Paste it over the existing NEURO script in Scriptable (select',
    '> all first), then run it once.',
    '',
    '## After the first paste, this file stops mattering',
    '',
    'The script updates itself. Open it in Scriptable and it pulls the latest from',
    'GitHub, then says whether it **updated**, was **already current**, or',
    '**failed**. So this copy only has to be good enough to bootstrap once — if it',
    'goes stale, the first run corrects it.',
    '',
    '## Setup',
    '',
    '1. Paste into Scriptable as a script named **NEURO**.',
    '2. Run it once in the app. It asks for the base URL (press Save to take the',
    '   default) and the API token, and keeps both in the iOS Keychain — never in',
    '   the script, because the repo is public.',
    '3. Allow **Location** when asked. That is for the weather strip and nothing',
    '   else; the coordinates are cached so widget refreshes never wait on GPS.',
    '4. Long-press the home screen, add a **Scriptable** widget, choose **NEURO**,',
    '   and set *When Interacting* to *Run Script*.',
    '',
    'Lock-screen widgets come from the same script — add one above the clock.',
    '',
    `## Source — ${version}, exported ${stamp}`,
    '',
    fence + 'javascript',
    src.trimEnd(),
    fence,
    '',
    '## Related',
    '',
    '- [[NEURO Feature Tracker]]',
    '',
  ].join('\n');
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const vault = process.env.OBSIDIAN_VAULT_PATH || DEFAULT_VAULT;
  const widget = path.join(__dirname, '..', '..', 'sara', 'widget', 'neuro-attention.js');

  if (!fs.existsSync(widget)) {
    console.error(`[ExportWidget] Widget not found at ${widget}`);
    process.exit(1);
  }
  if (!fs.existsSync(vault)) {
    console.error(`[ExportWidget] Vault not found at ${vault} — set OBSIDIAN_VAULT_PATH`);
    process.exit(1);
  }

  // Normalise to LF. The repo is checked out CRLF on Windows, and a fenced
  // block full of stray carriage returns copies badly.
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const src = fs.readFileSync(widget, 'utf8').split(CR + LF).join(LF);

  const version = (src.match(/VERSION = '(v[0-9]+)'/) || [])[1] || 'unknown';
  if (version === 'unknown') {
    // The version is what makes "did my paste land?" answerable on the phone.
    console.warn('[ExportWidget] No VERSION constant found — exporting anyway.');
  }

  const stamp = new Date().toISOString().slice(0, 10);
  const doc = build(src, version, stamp);
  const out = path.join(vault, REL_OUT);

  if (dryRun) {
    console.log(`[ExportWidget] DRY RUN — would write ${doc.split(LF).length} lines to:`);
    console.log(`  ${out}`);
    console.log(`  widget ${version}, ${src.split(LF).length} lines of source`);
    return;
  }

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, doc, 'utf8');
  console.log(`[ExportWidget] Wrote ${version} to ${out}`);
  console.log(`[ExportWidget] ${doc.split(LF).length} lines (${src.split(LF).length} of source)`);
}

if (require.main === module) main();

module.exports = { build };
