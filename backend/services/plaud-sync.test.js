'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  renderNote,
  renderTranscript,
  extractTranscriptSegments,
  htmlUnescape
} = require('./plaud-sync');

// Sample get_note(file_id) response: a summary item plus a consumer_note that
// carries only an expiring S3 link and must be dropped.
const SAMPLE_GET_NOTE = [
  {
    data_type: 'auto_sum_note',
    data_content:
      '## Meeting Information\n> Participants: Arman Shazad, Nick Ward\n\n## Meeting Notes\n- Reviewed Q3 plan &amp; budget\n- Arman said &quot;we should ship&quot; if &lt;5 blockers remain',
    data_link: ''
  },
  {
    data_type: 'consumer_note',
    data_content: '',
    data_link: 'https://example-bucket.s3.amazonaws.com/audio.mp3?X-Amz-Expires=900&sig=abc'
  }
];

// Sample get_transcript(file_id) response: a transaction item whose data_content
// is a JSON string of segments with real `speaker` names.
const SAMPLE_GET_TRANSCRIPT = [
  {
    data_type: 'transaction',
    data_content: JSON.stringify([
      { start_time: 297020, content: 'Apologize, okay?', speaker: 'Arman Shazad', original_speaker: 'Speaker 5' },
      { start_time: 302000, content: '  No worries at all.  ', speaker: 'Nick Ward', original_speaker: 'Speaker 2' },
      { start_time: 305000, content: '', speaker: 'Nick Ward', original_speaker: 'Speaker 2' }
    ])
  }
];

test('htmlUnescape decodes the five common entities without double-decoding', () => {
  assert.equal(htmlUnescape('a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;'), 'a <b> & "c" \'d\'');
  assert.equal(htmlUnescape('&amp;lt;'), '&lt;'); // &amp; resolved last, so this stays literal
  assert.equal(htmlUnescape(null), '');
});

test('renderNote drops empty consumer_note / S3-link items and unescapes content', () => {
  const out = renderNote(SAMPLE_GET_NOTE);

  // The S3 link and the consumer_note item are gone.
  assert.ok(!out.includes('s3.amazonaws.com'), 'S3 link must be dropped');
  assert.ok(!out.includes('consumer_note'), 'consumer_note must be dropped');

  // No raw JSON object blocks and no escaped newlines leaked through.
  assert.ok(!out.includes('"data_type"'), 'no raw note JSON');
  assert.ok(!out.includes('\\n'), 'no literal escaped newlines');

  // HTML entities are decoded.
  assert.ok(out.includes('Q3 plan & budget'));
  assert.ok(out.includes('"we should ship"'));
  assert.ok(out.includes('if <5 blockers'));
  assert.ok(out.startsWith('## Meeting Information'));
});

test('renderNote joins multiple real summaries with a divider', () => {
  const out = renderNote([
    { data_type: 'auto_sum_note', data_content: 'First' },
    { data_type: 'consumer_note', data_content: '', data_link: 'https://s3/x' },
    { data_type: 'custom_note', data_content: 'Second' }
  ]);
  assert.equal(out, 'First\n\n---\n\nSecond');
});

test('extractTranscriptSegments parses the transaction JSON string', () => {
  const segments = extractTranscriptSegments(SAMPLE_GET_TRANSCRIPT);
  assert.equal(segments.length, 3);
  assert.equal(segments[0].speaker, 'Arman Shazad');
});

test('renderTranscript uses real speaker names, not "Speaker N"', () => {
  const out = renderTranscript(extractTranscriptSegments(SAMPLE_GET_TRANSCRIPT));

  // Real names from `speaker`, never the raw original_speaker labels.
  assert.ok(out.includes('**Arman Shazad**'));
  assert.ok(out.includes('**Nick Ward**'));
  assert.ok(!/Speaker \d/.test(out), 'must not contain raw "Speaker N" labels');

  // mm:ss timestamp formatting (297020ms -> 04:57).
  assert.ok(out.includes('`04:57`'));

  // Empty-content segment is dropped -> only 2 rendered lines.
  assert.equal(out.split('\n\n').length, 2, 'empty segment dropped -> 2 rendered lines');

  // Exact line shape: **speaker** `mm:ss`  content (content trimmed; the two
  // spaces before content are the intentional separator, not stray whitespace).
  assert.equal(out.split('\n\n')[0], '**Arman Shazad** `04:57`  Apologize, okay?');
  assert.equal(out.split('\n\n')[1], '**Nick Ward** `05:02`  No worries at all.');
});

test('renderTranscript and renderNote degrade gracefully on junk input', () => {
  assert.equal(renderTranscript(null), '');
  assert.equal(renderNote(undefined), '');
  assert.equal(extractTranscriptSegments('not an array').length, 0);
});

// ═══════════════════════════════════════════════════════
// The nine days of lost meeting notes (27 Aug 2026)
//
// Two independent bugs, both silent, that between them put 22 of 27 recordings
// from 19-27 Aug nowhere and the other 5 in the vault under wrong names.
// ═══════════════════════════════════════════════════════

const {
  parseLeadingJson,
  assertUsableDetails,
  incrementalDateFrom,
  buildNoteBaseName,
} = require('./plaud-sync')._internal;

// The exact shape PLAUD's get_file returns: valid JSON, then a hint paragraph in
// the SAME text block. JSON.parse rejects the whole thing as "Extra data".
const GET_FILE_WITH_TRAILING_HINT = `{
  "id": "05c90384b8b342d976f683bde0f25eb1",
  "name": "Performance Review: Isabel Busk KPIs, Workflows, and Operational Planning",
  "created_at": "2026-08-25T14:47:45",
  "start_at": "2026-08-25T14:18:56",
  "note_list": [{ "data_type": "auto_sum_note", "data_content": "a } brace { in a string" }]
}

Note: a block with an empty \`data_content\` — the body lives behind \`data_link\`, not missing.`;

test('get_file JSON survives the trailing hint paragraph', () => {
  assert.throws(() => JSON.parse(GET_FILE_WITH_TRAILING_HINT), 'precondition: plain JSON.parse must fail');

  const parsed = parseLeadingJson(GET_FILE_WITH_TRAILING_HINT);
  assert.equal(parsed.id, '05c90384b8b342d976f683bde0f25eb1');
  assert.equal(parsed.start_at, '2026-08-25T14:18:56');
  assert.match(parsed.name, /^Performance Review/);
  // Braces inside strings must not close the object early.
  assert.equal(parsed.note_list[0].data_content, 'a } brace { in a string');
});

test('parseLeadingJson handles arrays and refuses junk', () => {
  assert.deepEqual(parseLeadingJson('[1, 2, 3]\n\nTrailing prose.'), [1, 2, 3]);
  assert.equal(parseLeadingJson('no json here at all'), undefined);
  assert.equal(parseLeadingJson('{ "unterminated": '), undefined, 'an unclosed object is not a value');
});

test('unusable get_file metadata is refused, never written as "undefined"', () => {
  // The raw string is what the old fallback returned. A string has properties;
  // they are just undefined — which is why this failed silently for nine days.
  assert.throws(() => assertUsableDetails(GET_FILE_WITH_TRAILING_HINT, 'abc123'), /expected an object/);
  assert.throws(() => assertUsableDetails(null, 'abc123'), /expected an object/);
  assert.throws(() => assertUsableDetails([], 'abc123'), /an array/);
  assert.throws(() => assertUsableDetails({ name: 'x' }, 'abc123'), /no id/);

  const good = { id: 'abc123', name: 'Weekly Sync' };
  assert.equal(assertUsableDetails(good, 'abc123'), good);
});

test('a string details object would have produced the exact broken filename', () => {
  // Negative test: this is what the vault filled up with. If buildNoteBaseName
  // is ever handed a non-object again the guard above is the only thing between
  // it and "<sync date> – Summary 38.md".
  const fromString = buildNoteBaseName(GET_FILE_WITH_TRAILING_HINT);
  assert.ok(!fromString.includes('Performance-Review'), 'a string yields no title');

  // What it should be, given a real object.
  assert.equal(
    buildNoteBaseName({ id: 'x', name: 'Performance Review: Isabel Busk', start_at: '2026-08-25T14:18:56' }),
    '2026-08-25 Performance-Review-Isabel-Busk'
  );
});

test('the incremental window lags the last sync instead of starting at it', () => {
  // The bug: window == the sync date, so the sync only ever saw "today".
  assert.equal(incrementalDateFrom('2026-08-27T16:03:13.389Z', true, 0), '2026-08-27');

  // The fix: a recording from 19 Aug is still inside a 14-day lookback taken on
  // 27 Aug, so a summary PLAUD finished days late is still collected.
  assert.equal(incrementalDateFrom('2026-08-27T16:03:13.389Z', true, 14), '2026-08-13');
  assert.equal(incrementalDateFrom('2026-08-27T16:03:13.389Z', true, 7), '2026-08-20');

  // Month/year boundaries go through Date, not string maths.
  assert.equal(incrementalDateFrom('2026-01-05T00:00:00.000Z', true, 14), '2025-12-22');
});

test('a full sync and an unusable stamp both mean "no window"', () => {
  assert.equal(incrementalDateFrom('2026-08-27T16:03:13.389Z', false, 14), undefined, 'full sync lists everything');
  assert.equal(incrementalDateFrom(null, true, 14), undefined, 'never synced -> list everything');
  assert.equal(incrementalDateFrom('not a date', true, 14), undefined, 'unparseable stamp must not become NaN');
});

test('an MCP timeout is retryable — "timed out" is not "timeout"', () => {
  const { isRetryableError } = require('./plaud-sync')._internal;

  // The exact string all 4 recordings in the failed ledger died on. `timeout`
  // does not appear in it, so every one failed on its first attempt.
  assert.ok(isRetryableError(new Error('MCP error -32001: Request timed out')));

  assert.ok(isRetryableError(new Error('socket hang up')));
  assert.ok(isRetryableError(new Error('429 Too Many Requests')));
  assert.ok(!isRetryableError(new Error('get_file returned no id for abc123')));
});
