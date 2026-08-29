#!/usr/bin/env node
'use strict';

/**
 * Write the Scriptable scripts into the vault as Markdown notes.
 *
 * Why: they reach the phone by being COPIED AS TEXT, and the QR → Safari →
 * Select All route is both fiddly and lossy (it ate a backslash and produced a
 * syntax error). The vault already syncs to the phone and Obsidian puts a copy
 * button on every code block, so this is one tap instead of five.
 *
 * They land in `Scripts/`, which `vault-exclusions` already treats as a
 * TRANSIENT dir — so a few hundred lines of JavaScript never reach the
 * embeddings index or entity extraction. Putting them anywhere else would make
 * the source outrank real notes on half the vault's queries.
 *
 * ⚠ Exports EVERY Scriptable script, not one named file. The first version
 * knew only about the widget, so when a second script landed in the same
 * directory — reaching the phone the same way, with the same paste hazard — it
 * had no delivery route at all. Same shape as the no-backslash test, which had
 * the same fault for the same reason.
 *
 *   node backend/scripts/export-widget-to-vault.js [--dry-run]
 *
 * OBSIDIAN_VAULT_PATH overrides the vault location.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_VAULT = 'C:\\Users\\NickW\\Documents\\Nicks knowledge base';
const WIDGET_DIR = path.join(__dirname, '..', '..', 'sara', 'widget');

/**
 * One entry per script.
 *
 * ⚠ `selfUpdates` is not decoration. The widget pulls its own latest from GitHub
 * on an in-app run, so a stale export corrects itself; the sync script does NOT,
 * so its exported copy is the only copy and a stale one stays stale. Saying
 * "this file stops mattering" on a note where it is false is how someone ends up
 * running month-old code and believing it is current.
 */
const SCRIPTS = [
  {
    file: 'neuro-attention.js',
    out: path.join('Scripts', 'SARA Widget (Scriptable).md'),
    title: 'SARA Widget (Scriptable)',
    scriptName: 'NEURO',
    tags: '[neuro, sara, widget, scriptable]',
    blurb: [
      'The iOS home-screen and lock-screen widget for NEURO. It lives here so it can',
      'be copied straight into Scriptable on the phone, rather than going via a QR',
      'code and Safari — that route mangles backslashes, which is why the script is',
      'written without a single one.',
    ],
    selfUpdates: true,
    setup: [
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
    ],
  },
  {
    file: 'neuro-apple-sync.js',
    out: path.join('Scripts', 'NEURO Apple Sync (Scriptable).md'),
    title: 'NEURO Apple Sync (Scriptable)',
    scriptName: 'NEURO Sync',
    tags: '[neuro, sara, scriptable, calendar, reminders]',
    blurb: [
      'Pushes Apple Calendar events and Reminders into NEURO. NEURO cannot reach into',
      'iCloud — CalDAV needs an app password and is undocumented, EventKit needs a',
      'Mac, and Reminders has no web API — so the phone does the reaching.',
      '',
      'This is what finally lets NEURO answer "is Nick free" honestly. Until it runs,',
      'it can only see the work diary, so every free/busy answer is wrong outside',
      'working hours and blind to anything personal inside them.',
      '',
      '⚠ Scriptable has **no HealthKit API**. Health is not part of this and cannot',
      'be; it already arrives via the FreeReps app.',
    ],
    selfUpdates: false,
    setup: [
      '1. Paste into Scriptable as a script named **NEURO Sync**.',
      '2. Run it once in the app. It reuses the base URL and API token the NEURO',
      '   widget already stored in the Keychain, and only asks if they are missing.',
      '   Allow **Calendar** and **Reminders** access when iOS asks.',
      '3. It reports what it sent — events, new tasks, and anything already known.',
      '4. Automate it: **Shortcuts → Automation → Time of Day → Run Script**, and',
      '   turn OFF *Ask Before Running*. A few times a day is plenty; this is a',
      '   diary, not a chat.',
      '',
      'Check it landed with `GET /api/apple/status`, which reports how many events',
      'NEURO holds and how long ago the phone last pushed. A push-based feed fails',
      'silently by definition — the phone simply stops calling — so that endpoint is',
      'the only thing that can tell you it has stopped.',
      '',
      'Reminders arrive as **personal** tasks unless their list is named in',
      '`APPLE_WORK_LISTS`. Completing one in NEURO does not tick it off in Apple —',
      'NEURO cannot write to iCloud — but a re-pushed completed reminder folds into',
      'the task that is already done rather than reopening it.',
    ],
  },
];

function build(entry, src, version, stamp) {
  // Four backticks, because the scripts contain template literals. Neither has a
  // triple-backtick run today, and a wider fence means it never matters if one
  // is added later.
  const fence = '`'.repeat(4);

  const staleness = entry.selfUpdates
    ? [
      '## After the first paste, this file stops mattering',
      '',
      'The script updates itself. Open it in Scriptable and it pulls the latest from',
      'GitHub, then says whether it **updated**, was **already current**, or',
      '**failed**. So this copy only has to be good enough to bootstrap once — if it',
      'goes stale, the first run corrects it.',
    ]
    : [
      '## ⚠ This copy does NOT update itself',
      '',
      'Unlike the widget, this script has no self-update — it executes nothing it',
      'fetched, which is the right call for something that runs unattended on a',
      'timer holding an API token. So the copy below is the only copy, and a stale',
      'one stays stale. Re-run the exporter after any change and paste it again.',
    ];

  return [
    '---',
    'type: reference',
    `tags: ${entry.tags}`,
    `updated: ${stamp}`,
    `script-version: ${version}`,
    '---',
    '',
    `# ${entry.title}`,
    '',
    ...entry.blurb,
    '',
    '> [!tip] Copying it',
    '> Switch to **Reading view** and tap the copy button at the top-right of the',
    `> code block. Paste it over the existing **${entry.scriptName}** script in`,
    '> Scriptable (select all first), then run it once.',
    '',
    ...staleness,
    '',
    '## Setup',
    '',
    ...entry.setup,
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

  if (!fs.existsSync(vault)) {
    console.error(`[ExportWidget] Vault not found at ${vault} — set OBSIDIAN_VAULT_PATH`);
    process.exit(1);
  }

  // Normalise to LF. The repo is checked out CRLF on Windows, and a fenced
  // block full of stray carriage returns copies badly.
  const CR = String.fromCharCode(13);
  const LF = String.fromCharCode(10);
  const stamp = new Date().toISOString().slice(0, 10);
  let failed = 0;

  for (const entry of SCRIPTS) {
    const source = path.join(WIDGET_DIR, entry.file);
    if (!fs.existsSync(source)) {
      console.error(`[ExportWidget] Missing ${entry.file} at ${source}`);
      failed++;
      continue;
    }

    const src = fs.readFileSync(source, 'utf8').split(CR + LF).join(LF);
    const version = (src.match(/VERSION = '(v[0-9]+)'/) || [])[1] || 'unknown';
    if (version === 'unknown') {
      // The version is what makes "did my paste land?" answerable on the phone.
      console.warn(`[ExportWidget] ${entry.file}: no VERSION constant — exporting anyway.`);
    }

    const doc = build(entry, src, version, stamp);
    const out = path.join(vault, entry.out);

    if (dryRun) {
      console.log(`[ExportWidget] DRY RUN — ${entry.file} ${version} → ${out}`);
      console.log(`  ${doc.split(LF).length} lines (${src.split(LF).length} of source)`);
      continue;
    }

    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, doc, 'utf8');
    console.log(`[ExportWidget] Wrote ${entry.file} ${version} → ${out}`);
  }

  // Loud, and a non-zero exit. A partial export that reports success is how a
  // script silently stops being delivered.
  if (failed) {
    console.error(`[ExportWidget] ${failed} script(s) could not be exported`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { build, SCRIPTS };
