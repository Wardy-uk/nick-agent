'use strict';

/**
 * "All health data" — the document-shaped sections that were counted and
 * discarded until 5 Sep 2026.
 *
 * ECG, audiograms, activity summaries, medications, vision prescriptions,
 * state of mind, and every non-sleep category sample. Same caveat as the
 * workouts parser: no captured HAE payload for any of these exists in the repo,
 * so the documents are stored LOSSLESSLY and the columns beside them are an
 * index, not a replacement. A wrong guess about a field name costs a query, not
 * data.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const ah = require('./apple-health');

test('every document section is parsed, not counted and binned', () => {
  const r = ah.parsePayload({ data: {
    metrics: [],
    ecg_recordings: [{ id: 'e1', start: '2026-08-16 09:00:00 +0100', classification: 'sinusRhythm' }],
    audiograms: [{ id: 'a1', date: '2026-05-02 11:00:00 +0100' }],
    activity_summaries: [{ date: '2026-08-16 00:00:00 +0100', activeEnergyBurned: 520 }],
    medications: [{ id: 'm1', name: 'Sertraline' }],
    vision_prescriptions: [{ id: 'v1', dateIssued: '2025-11-01 10:00:00 +0000' }],
    state_of_mind: [{ id: 's1', start: '2026-08-16 20:00:00 +0100', valence: 0.4, labels: ['calm'] }],
  } });

  assert.equal(r.recordsReceived, 6);
  assert.equal(r.records.length, 6);
  // ⚠ The old behaviour: these were named in `unstored` and thrown away.
  assert.deepEqual(r.unstored, {});
  assert.deepEqual(ah.UNSTORED_SECTIONS, []);

  const byKind = Object.fromEntries(r.records.map((x) => [x.kind, x]));
  assert.deepEqual(Object.keys(byKind).sort(), [
    'activity_summary', 'audiogram', 'ecg', 'medication', 'state_of_mind', 'vision_prescription',
  ]);
  // Dates are found across the several spellings HAE uses per section.
  assert.equal(byKind.ecg.startedAt, '2026-08-16 08:00:00');
  assert.equal(byKind.audiogram.startedAt, '2026-05-02 10:00:00');       // `date`
  assert.equal(byKind.vision_prescription.startedAt, '2025-11-01 10:00:00'); // `dateIssued`
});

test('the document is kept verbatim, and the columns only index it', () => {
  const r = ah.parsePayload({ data: { ecg_recordings: [
    { id: 'e1', start: '2026-08-16 09:00:00 +0100', classification: 'afib', voltages: [1, 2, 3], averageHeartRate: 88 },
  ] } });
  const rec = r.records[0];
  // Everything survives, including fields nothing models.
  assert.deepEqual(rec.document.voltages, [1, 2, 3]);
  assert.equal(rec.document.classification, 'afib');
  assert.equal(rec.document.averageHeartRate, 88);
});

test('a record with NO parseable date is stored, and the gap is reported', () => {
  // The opposite call from parseWorkouts, deliberately: a run with no time is
  // meaningless as a run, but a medication with no date still carries the
  // medication. Losing it to a date-format guess is the silent discarding this
  // whole change exists to end.
  const r = ah.parsePayload({ data: { medications: [{ id: 'm1', name: 'Sertraline' }] } });
  assert.equal(r.records.length, 1);                  // stored...
  assert.equal(r.records[0].startedAt, null);
  assert.equal(r.recordsWithoutDate.medication, 1);   // ...and said out loud
  assert.equal(r.records[0].document.name, 'Sertraline');
});

test('non-sleep category samples are stored as documents, sleep still becomes samples', () => {
  const r = ah.parsePayload({ data: { category_samples: [
    { id: 'sleep-1', type: 'HKCategoryTypeIdentifierSleepAnalysis', value: 3, value_label: 'Deep',
      start_date: '2026-08-16 01:00:00 +0100', end_date: '2026-08-16 02:30:00 +0100' },
    { id: 'mind-1', type: 'HKCategoryTypeIdentifierMindfulSession',
      start_date: '2026-08-16 07:00:00 +0100', end_date: '2026-08-16 07:10:00 +0100' },
    { id: 'sym-1', type: 'HKCategoryTypeIdentifierHeadache', value: 2, value_label: 'Moderate',
      start_date: '2026-08-16 15:00:00 +0100', end_date: '2026-08-16 16:00:00 +0100' },
  ] } });

  // Sleep still takes the numeric route — it IS a scalar and has consumers.
  assert.equal(r.samples.length, 1);
  assert.equal(r.samples[0].metric, 'sleep_deep_hours');
  assert.equal(r.samples[0].value, 1.5);

  // The other two are now documents rather than a discarded count.
  assert.equal(r.records.length, 2);
  assert.equal(r.recordsReceived, 2);
  const types = r.records.map((x) => x.recordType).sort();
  assert.deepEqual(types, ['HKCategoryTypeIdentifierHeadache', 'HKCategoryTypeIdentifierMindfulSession']);
  // `ignoredCategory` survives as the COUNT that took the document route, so
  // the response still says what happened to them.
  assert.equal(r.ignoredCategory, 2);
  // The category enum is indexed as a scalar without leaving the document.
  const headache = r.records.find((x) => x.recordType.endsWith('Headache'));
  assert.equal(headache.numericValue, 2);
  assert.equal(headache.label, 'Moderate');
  assert.equal(headache.kind, 'category_sample');
});

test('a re-sent record hashes to the same key, a different one does not', () => {
  // Idempotency for sections HAE gives no id. The same document IS the same
  // observation; key order must not change the hash.
  const a = { date: '2026-08-16 00:00:00 +0100', activeEnergyBurned: 520, steps: 9000 };
  const b = { steps: 9000, activeEnergyBurned: 520, date: '2026-08-16 00:00:00 +0100' };
  assert.equal(ah.recordDedupeKey(a), ah.recordDedupeKey(b));
  assert.match(ah.recordDedupeKey(a), /^sha256:/);
  // Paired negative: a genuinely different day is a different key.
  assert.notEqual(ah.recordDedupeKey(a), ah.recordDedupeKey({ ...a, steps: 9001 }));
  // And a uuid, when present, wins over the hash — it is the stabler key.
  assert.equal(ah.recordDedupeKey({ id: 'e1', foo: 1 }), 'e1');
});

test('unstored now means "we have never heard of this", not "we bin this"', () => {
  // The inversion is the point: an inventory of deliberate omissions is one
  // nobody rereads. This is an alarm for a section Apple or HAE has ADDED.
  const r = ah.parsePayload({ data: {
    metrics: [],
    ecg_recordings: [{ id: 'e1' }],
    sleep_apnea_events: [{ id: 'x1' }, { id: 'x2' }],   // invented — not a section we know
  } });
  assert.deepEqual(r.unstored, { sleep_apnea_events: 2 });
  // Paired positive: the section we DO know was stored rather than listed.
  assert.equal(r.records.length, 1);
  assert.equal(r.records[0].kind, 'ecg');
});

test('an empty section is absent from unstored, never reported as zero', () => {
  const r = ah.parsePayload({ data: { metrics: [], ecg_recordings: [], mystery_section: [] } });
  assert.deepEqual(r.unstored, {});
  assert.equal(r.records.length, 0);
});
