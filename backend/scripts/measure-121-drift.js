'use strict';

// Read-only measurement for #30: do the stored 1-2-1 dates still agree with the
// calendar? Answers the question before anything is built, per the tracker rule.
//
// Prints one row per person carrying a `1-2-1-booked` date, and what
// findOneToOne actually finds for them right now.

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');
const booking = require('../services/one-to-one-booking');

const VAULT = process.env.OBSIDIAN_VAULT_PATH;
if (!VAULT) {
  console.error('OBSIDIAN_VAULT_PATH is required — this script reads People notes.');
  process.exit(1);
}

function field(raw, key) {
  const m = raw.match(new RegExp(`^${key}:\\s*(\\d{4}-\\d{2}-\\d{2})`, 'm'));
  return m ? m[1] : null;
}

(async () => {
  const dir = path.join(VAULT, 'People');
  const people = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_'));

  const rows = [];
  for (const file of people) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf-8').replace(/\r\n/g, '\n');
    const booked = field(raw, '1-2-1-booked');
    const due = field(raw, 'next-1-2-1-due');
    if (!booked && !due) continue;
    rows.push({ name: file.replace(/\.md$/, ''), booked, due });
  }

  console.log(`People notes carrying a 1-2-1 date: ${rows.length}\n`);

  let agree = 0; let drifted = 0; let missing = 0; let noBooked = 0;

  for (const r of rows) {
    if (!r.booked) { noBooked++; continue; }
    const found = await booking.findOneToOne(r.name);
    if (!found.ok) {
      missing++;
      console.log(`GONE     ${r.name.padEnd(22)} booked=${r.booked} due=${r.due || '-'}  → ${found.error}`);
      continue;
    }
    const actual = found.event.date || String(found.event.start).slice(0, 10);
    if (actual === r.booked) {
      agree++;
      console.log(`ok       ${r.name.padEnd(22)} booked=${r.booked} → ${actual} (${found.matchedBy})`);
    } else {
      drifted++;
      console.log(`MOVED    ${r.name.padEnd(22)} booked=${r.booked} → ${actual} (${found.matchedBy}) "${found.event.subject}"`);
    }
  }

  console.log(`\nagree ${agree} | moved ${drifted} | no matching event ${missing} | due-only (never booked by NEURO) ${noBooked}`);
})().catch((e) => { console.error(e); process.exit(1); });
