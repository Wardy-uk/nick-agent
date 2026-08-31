// What changed, and what the numbers were when it did.
//
// Written because reconstructing one afternoon's room changes took three
// separate journals plus my own memory of which services I had restarted — and
// "was it right this evening?" is the question that actually gets asked the
// next morning. It should be one request, not an archaeology exercise.
//
// ⚠ EVERY ENTRY CARRIES THE RSSI OF EVERY ROOM AT THAT MOMENT, not just the
// winner. A change is only judgeable against the margin it was decided by: a
// switch at 15 dB is the system working and a switch at 1 dB is a coin toss,
// and after the fact those are indistinguishable if only the outcome was kept.
// This is the whole reason the log exists — without the losing rooms' numbers
// it records that something happened, which nobody can act on.
//
// In memory, capped. It is a diagnostic for the last few hours, not a record to
// keep: a restart losing it is fine, and it also goes to stdout, where PM2
// persists and rotates it for anything longer.

'use strict';

const MAX_ENTRIES = 500;

const entries = [];

function note(kind, from, to, rooms, extra = {}) {
  const at = new Date().toISOString();
  const snapshot = (rooms || []).map(r => ({
    room: r.room,
    status: r.status,
    rssi: r.rssi,
    rate: r.rate,
    readable: r.readable,
  }));

  entries.push({ at, kind, from, to, rooms: snapshot, ...extra });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  // One line, everything on it. Whoever is reading PM2's log at 2am should not
  // have to correlate it with a second source to understand what happened.
  const margins = snapshot
    .filter(r => r.rssi !== null)
    .sort((a, b) => b.rssi - a.rssi)
    .map(r => `${r.room}=${r.rssi}`)
    .join(' ');
  console.log(`[presence] ${kind}: ${from || 'none'} -> ${to || 'none'}  [${margins}]`
    + (extra.note ? `  ${extra.note}` : ''));
}

function all(limit = MAX_ENTRIES) {
  return entries.slice(-Math.max(1, Math.min(limit, MAX_ENTRIES)));
}

function reset() {
  entries.length = 0;
}

module.exports = { note, all, reset, MAX_ENTRIES };
