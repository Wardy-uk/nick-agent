'use strict';

/**
 * Document-shaped health records landing in a real database.
 *
 * The parser test proves the rules; this proves the documents survive the round
 * trip intact and that a re-sent backfill folds. Storage is where "lossless"
 * either holds or quietly stops holding.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-records-'));
process.env.NEURO_DB_PATH = path.join(root, 'records.db');

const db = require('../db/database');
const ah = require('./apple-health');

const PAYLOAD = { data: {
  metrics: [],
  ecg_recordings: [{ id: 'e1', start: '2026-08-16 09:00:00 +0100', classification: 'sinusRhythm',
    voltages: [0.1, 0.2, 0.3], averageHeartRate: 88 }],
  medications: [{ id: 'm1', name: 'Sertraline', dose: '50mg' }],
  activity_summaries: [{ date: '2026-08-16 00:00:00 +0100', activeEnergyBurned: 520, moveGoal: 600 }],
  state_of_mind: [{ id: 's1', start: '2026-08-16 20:00:00 +0100', valence: 0.4, labels: ['calm', 'content'] }],
  category_samples: [
    { id: 'mind-1', type: 'HKCategoryTypeIdentifierMindfulSession',
      start_date: '2026-08-16 07:00:00 +0100', end_date: '2026-08-16 07:10:00 +0100' },
  ],
} };

test.before(async () => { await db.init(); });
test.beforeEach(() => { db.run('DELETE FROM health_records', []); });

test('every kind lands, and the document survives intact', () => {
  const parsed = ah.parsePayload(PAYLOAD);
  assert.equal(db.insertHealthRecords(parsed.records), 5);

  const counts = Object.fromEntries(db.getHealthRecordCounts().map((r) => [r.kind, r.n]));
  assert.deepEqual(counts, {
    ecg: 1, medication: 1, activity_summary: 1, state_of_mind: 1, category_sample: 1,
  });

  // ⚠ The paired POSITIVE that matters: "lossless" is a claim about the blob,
  // and every count assertion above would pass on five rows of empty documents.
  const ecg = db.getHealthRecords('ecg', '2026-08-16 00:00:00', '2026-08-16 23:59:59')[0];
  const doc = JSON.parse(ecg.document);
  assert.deepEqual(doc.voltages, [0.1, 0.2, 0.3]);
  assert.equal(doc.classification, 'sinusRhythm');
  assert.equal(doc.averageHeartRate, 88);
  assert.equal(ecg.started_at, '2026-08-16 08:00:00');

  // Nested structure survives too — a labels array is the shape most likely to
  // be flattened by a careless encode.
  const som = db.getHealthRecords('state_of_mind', '2026-08-16 00:00:00', '2026-08-16 23:59:59')[0];
  assert.deepEqual(JSON.parse(som.document).labels, ['calm', 'content']);
  assert.equal(som.numeric_value, 0.4);
});

test('a re-sent backfill folds rather than doubling the table', () => {
  const parsed = ah.parsePayload(PAYLOAD);
  assert.equal(db.insertHealthRecords(parsed.records), 5);
  // Re-parsed from the identical payload — including the two sections with no
  // id, which fold on their content hash.
  assert.equal(db.insertHealthRecords(ah.parsePayload(PAYLOAD).records), 0);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM health_records').n, 5);
});

test('a genuinely new record still inserts alongside the folded ones', () => {
  db.insertHealthRecords(ah.parsePayload(PAYLOAD).records);
  const second = JSON.parse(JSON.stringify(PAYLOAD));
  second.data.activity_summaries = [{ date: '2026-08-17 00:00:00 +0100', activeEnergyBurned: 610, moveGoal: 600 }];
  assert.equal(db.insertHealthRecords(ah.parsePayload(second).records), 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM health_records').n, 6);
});

test('a record with no date is stored and findable by kind', () => {
  const parsed = ah.parsePayload({ data: { medications: [{ id: 'm9', name: 'Vitamin D' }] } });
  assert.equal(db.insertHealthRecords(parsed.records), 1);
  const row = db.get("SELECT * FROM health_records WHERE kind = 'medication'");
  assert.equal(row.started_at, null);
  assert.equal(JSON.parse(row.document).name, 'Vitamin D');
  // ⚠ And the known consequence, pinned so it cannot surprise anyone:
  // getHealthRecords() filters on started_at, so a dateless record is NOT in a
  // windowed read. The counts view is how you find it.
  assert.equal(db.getHealthRecords('medication', '1970-01-01 00:00:00', '2099-01-01 00:00:00').length, 0);
  assert.equal(db.getHealthRecordCounts().find((c) => c.kind === 'medication').n, 1);
});

test('two kinds sharing a dedupe key do not collide', () => {
  // UNIQUE is (kind, dedupe_key), not dedupe_key alone — an id is only unique
  // within its own section.
  const parsed = ah.parsePayload({ data: {
    medications: [{ id: 'shared', name: 'A' }],
    audiograms: [{ id: 'shared' }],
  } });
  assert.equal(db.insertHealthRecords(parsed.records), 2);
});
