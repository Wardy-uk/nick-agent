const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const PLAUD_STATE_KEY = 'plaud_sync_state';
const PLAUD_RUNNING_KEY = 'plaud_sync_running';
const PLAUD_LAST_ERROR_KEY = 'plaud_last_error';
const PLAUD_LAST_SYNC_KEY = 'plaud_last_sync';
const PLAUD_LAST_RUN_KEY = 'plaud_last_run';
const DEFAULT_RETRY_ATTEMPTS = Number(process.env.PLAUD_MCP_RETRY_ATTEMPTS || 4);
const DEFAULT_RETRY_BASE_MS = Number(process.env.PLAUD_MCP_RETRY_BASE_MS || 1500);
const DEFAULT_BETWEEN_RECORDINGS_MS = Number(process.env.PLAUD_MCP_BETWEEN_RECORDINGS_MS || 750);
const DEFAULT_STALE_RUN_MS = Number(process.env.PLAUD_MCP_STALE_RUN_MS || 2 * 60 * 60 * 1000);
const DEFAULT_SUMMARY_STABILIZATION_HOURS = Number(process.env.PLAUD_SUMMARY_STABILIZATION_HOURS || 24);
// How long a recording may be held back waiting for PLAUD to name its speakers,
// and whether to hold at all. The wait is bounded because the deadline is the only
// thing that makes holding safe: on expiry the recording is pulled REGARDLESS, with
// the note stamped to say the speakers were never named.
const DEFAULT_SPEAKER_WAIT_MINUTES = Number(process.env.PLAUD_SPEAKER_WAIT_MINUTES || 60);
function speakerWaitEnabled() {
  return String(process.env.PLAUD_SPEAKER_WAIT_ENABLED || 'true').toLowerCase() !== 'false';
}
function speakerWaitMs() {
  const minutes = Number.isFinite(DEFAULT_SPEAKER_WAIT_MINUTES) && DEFAULT_SPEAKER_WAIT_MINUTES > 0
    ? DEFAULT_SPEAKER_WAIT_MINUTES
    : 60;
  return minutes * 60 * 1000;
}

function getVaultPath() {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  if (!vaultPath) {
    throw new Error('OBSIDIAN_VAULT_PATH is not configured');
  }
  return vaultPath;
}

function getPlaudCommand() {
  return process.env.PLAUD_MCP_COMMAND || 'npx';
}

function getPlaudArgs() {
  return splitCommandLine(process.env.PLAUD_MCP_ARGS || '-y @plaud-ai/mcp@latest');
}

function getSummaryFolder() {
  return process.env.PLAUD_SUMMARY_FOLDER || 'Plaud/Summaries';
}

function getTranscriptFolder() {
  return process.env.PLAUD_TRANSCRIPT_FOLDER || 'Meetings/transcripts';
}

function splitCommandLine(value) {
  const matches = value.match(/"[^"]*"|'[^']*'|[^\s]+/g) || [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ''));
}

function normalizeVaultPath(relativePath) {
  return relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
}

function ensureFolder(relativePath) {
  const vaultPath = getVaultPath();
  const target = path.join(vaultPath, relativePath);
  fs.mkdirSync(target, { recursive: true });
}

function readMarkdownFiles(rootPath) {
  if (!fs.existsSync(rootPath)) return [];

  const results = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(nextPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        results.push(nextPath);
      }
    }
  }

  return results;
}

function extractFrontmatterValue(content, key) {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return null;

  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedKey}:\\s*(.+)$`, 'mi');
  const match = frontmatterMatch[1].match(pattern);
  if (!match) return null;

  return match[1].trim().replace(/^"(.*)"$/, '$1');
}

function buildExistingNoteIndex() {
  const vaultPath = getVaultPath();
  const index = {};

  for (const filePath of readMarkdownFiles(vaultPath)) {
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const plaudId = extractFrontmatterValue(content, 'plaud_id');
    if (!plaudId) continue;

    const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
    if (!index[plaudId]) {
      index[plaudId] = { summaries: [], transcripts: [] };
    }

    const noteType = extractFrontmatterValue(content, 'note_type');
    if (noteType === 'transcript') {
      index[plaudId].transcripts.push(relativePath);
    } else {
      index[plaudId].summaries.push(relativePath);
    }
  }

  for (const value of Object.values(index)) {
    value.summaries.sort();
    value.transcripts.sort();
  }

  return index;
}

function readSyncState() {
  try {
    const raw = db.getState(PLAUD_STATE_KEY);
    return raw
      ? JSON.parse(raw)
      : { syncedRecordings: {}, failedRecordings: {}, pendingSpeakers: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
  } catch {
    return { syncedRecordings: {}, failedRecordings: {}, pendingSpeakers: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
  }
}

function writeSyncState(state) {
  db.setState(PLAUD_STATE_KEY, JSON.stringify(state));
  db.setState(PLAUD_LAST_SYNC_KEY, state.lastSuccessfulSyncAt || '');
  db.setState(PLAUD_LAST_RUN_KEY, state.lastRunAt || '');
}

function readRunningState() {
  try {
    const raw = db.getState(PLAUD_RUNNING_KEY);
    if (!raw || raw === 'false') {
      return { active: false, stale: false, startedAt: null, pid: null };
    }

    if (raw === 'true') {
      return { active: true, stale: true, startedAt: null, pid: null };
    }

    const parsed = JSON.parse(raw);
    const startedAtMs = parsed.startedAt ? new Date(parsed.startedAt).getTime() : NaN;
    let pidAlive = true;
    if (parsed.pid) {
      try {
        process.kill(parsed.pid, 0);
      } catch {
        pidAlive = false;
      }
    }

    const stale =
      !pidAlive || (Number.isFinite(startedAtMs) && Date.now() - startedAtMs > DEFAULT_STALE_RUN_MS);
    return {
      active: Boolean(parsed.active),
      stale,
      startedAt: parsed.startedAt || null,
      pid: parsed.pid || null
    };
  } catch {
    return { active: false, stale: false, startedAt: null, pid: null };
  }
}

function writeRunningState(active) {
  if (!active) {
    db.setState(PLAUD_RUNNING_KEY, 'false');
    return;
  }

  db.setState(
    PLAUD_RUNNING_KEY,
    JSON.stringify({
      active: true,
      startedAt: new Date().toISOString(),
      pid: process.pid
    })
  );
}

async function createClient() {
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/stdio.js')
  ]);

  const transport = new StdioClientTransport({
    command: getPlaudCommand(),
    args: getPlaudArgs(),
    stderr: 'pipe'
  });

  if (transport.stderr) {
    transport.stderr.on('data', (chunk) => {
      console.error(`[Plaud MCP] ${chunk.toString()}`);
    });
  }

  const client = new Client({
    name: 'nuero-plaud-sync',
    version: '1.0.0'
  });

  await client.connect(transport);
  return { client, transport };
}

// PLAUD's `get_file` returns valid JSON followed by a human-readable hint
// paragraph in the SAME text block ("...the body lives behind `data_link`...").
// `JSON.parse` rejects that as "Extra data" and the old fallback returned the raw
// STRING — so `details.id`, `details.name` and `details.start_at` were all
// undefined, and every note written between 19 and 26 Aug 2026 carried
// `plaud_id: "undefined"`, a generic "Summary" title and the SYNC date instead of
// the meeting date. The dedupe pass then correctly read them as duplicates and
// archived the lot. Silent, because a string has properties — they are just
// undefined — so nothing threw.
//
// So parse the LEADING JSON value and discard trailing prose. Only get_file is
// affected today (list_files / get_note / get_transcript parse clean), but the
// tolerance is in the shared helper because the next tool to grow a hint should
// not cost another nine days of notes.
function parseLeadingJson(text) {
  const start = text.search(/[[{]/);
  if (start === -1) return undefined;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content || [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();

  if (result.isError) {
    throw new Error(text || `Plaud MCP tool failed: ${name}`);
  }

  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  if (!text) return '';
  try {
    return JSON.parse(text);
  } catch {
    const leading = parseLeadingJson(text);
    if (leading !== undefined) return leading;
    return text;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('429') || message.includes('rate limit') || message.includes('too many requests');
}

function isRetryableError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    isRateLimitError(error) ||
    message.includes('timeout') ||
    // The MCP SDK phrases its own timeout as "Request timed out" (-32001), which
    // `timeout` does not match — so every one of the 4 recordings in the failed
    // ledger died on its first attempt without a single retry.
    message.includes('timed out') ||
    message.includes('temporar') ||
    message.includes('econnreset') ||
    message.includes('socket hang up')
  );
}

async function withRetry(label, operation, options = {}) {
  const attempts = Number(options.attempts || DEFAULT_RETRY_ATTEMPTS);
  const baseDelayMs = Number(options.baseDelayMs || DEFAULT_RETRY_BASE_MS);

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) {
        throw error;
      }

      // Exponential backoff + jitter (avoids thundering-herd re-tries on 429).
      const delay = baseDelayMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * baseDelayMs);
      console.warn(
        `[PlaudSync] ${label} failed on attempt ${attempt}/${attempts} (${error.message}). Retrying in ${delay}ms...`
      );
      await sleep(delay);
    }
  }

  throw lastError;
}

// ⚠ The incremental window must LAG the last sync, not start at it.
//
// A recording is only ledgered once PLAUD has produced a summary; until then it
// is correctly skipped as "not ready — retry next cycle". But the sync runs every
// 30 minutes and succeeds, so `lastSuccessfulSyncAt` is always TODAY — which made
// the effective window "today only". Anything still processing at midnight fell
// out of the window and was never asked for again. Not theoretical: 22 of the 27
// recordings between 19 and 27 Aug 2026 were stranded that way, including 1-2-1s
// whose summaries PLAUD produced days later.
//
// The ledger (`shouldProcessRecording`) is what prevents rework, so widening the
// window costs one larger `list_files` per sync and nothing else. It is a
// LOOKBACK, not a full re-list — a full list is `{ incremental: false }`.
const DEFAULT_SYNC_LOOKBACK_DAYS = Number(process.env.PLAUD_SYNC_LOOKBACK_DAYS || 14);

/**
 * How long a failed recording keeps being retried. Past this it stays in the ledger as a
 * record of what was lost, but stops widening every sync's window for ever.
 */
const FAILED_RETRY_MAX_AGE_DAYS = Number(process.env.PLAUD_FAILED_RETRY_DAYS || 90);

/**
 * The window an incremental sync lists.
 *
 * ⚠ IT MUST REACH BACK FAR ENOUGH TO INCLUDE OUTSTANDING FAILURES, and until 2026-09-01
 * it did not — which is how 14 recordings went permanently missing while the sync
 * reported success every night.
 *
 * The chain: a recording fails on a transient error (an MCP timeout, a 500 from
 * get_transcript). It is written to `failedRecordings` and NOT ledgered as synced, so it
 * is eligible to be retried. But the next sync lists only the last 14 days, and nothing
 * ever consulted `failedRecordings` when choosing that window — so once the recording
 * aged past the lookback it stopped being listed at all, and the retry it was owed never
 * came. `failedRecordings` was written and never read: a ledger of losses nobody acted on.
 *
 * Two July recordings failed on 12 Aug with "Request timed out" and were simply gone. So
 * the window now stretches back to the oldest outstanding failure.
 */
function incrementalDateFrom(lastSuccessfulSyncAt, incremental, lookbackDays = DEFAULT_SYNC_LOOKBACK_DAYS, failedRecordings = null) {
  if (!incremental || !lastSuccessfulSyncAt) return undefined;

  const last = new Date(lastSuccessfulSyncAt);
  if (Number.isNaN(last.getTime())) return undefined;

  const days = Number.isFinite(lookbackDays) && lookbackDays > 0 ? Math.floor(lookbackDays) : 0;
  last.setUTCDate(last.getUTCDate() - days);
  let from = last;

  const cutoff = Date.now() - FAILED_RETRY_MAX_AGE_DAYS * 86400000;
  for (const entry of Object.values(failedRecordings || {})) {
    // `failedAt` is when the retry was owed, which is at or after the recording's own
    // date — near enough, and the only timestamp the ledger keeps.
    const failedAt = new Date(entry && entry.failedAt);
    if (Number.isNaN(failedAt.getTime())) continue;
    if (failedAt.getTime() < cutoff) continue;
    // A day of margin: the recording is older than the moment its retry failed.
    const reach = new Date(failedAt.getTime() - 86400000);
    if (reach < from) from = reach;
  }

  return from.toISOString().slice(0, 10);
}

async function listRecordings(client, dateFrom) {
  if (dateFrom) {
    const payload = await callTool(client, 'list_files', { date_from: dateFrom });
    return extractRecordingList(payload);
  }

  const all = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const payload = await callTool(client, 'list_files', { page, page_size: pageSize });
    const batch = extractRecordingList(payload);
    all.push(...batch);
    if (batch.length < pageSize) break;
    page += 1;
  }

  return all;
}

function extractRecordingList(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.data)) return payload.data;
  throw new Error('Plaud list_files returned an unexpected response shape');
}

function choosePreferredSummary(notes) {
  if (!Array.isArray(notes) || notes.length === 0) return {};

  const custom = notes.filter((note) => {
    const tab = (note.data_tab_name || '').trim().toLowerCase();
    const title = (note.data_title || '').trim().toLowerCase();
    return tab === 'obsidian meeting template' || title === 'obsidian meeting template';
  });
  if (custom.length > 0) return custom[0];

  const defaults = notes.filter((note) => {
    const type = (note.data_type || '').trim().toLowerCase();
    const tab = (note.data_tab_name || '').trim().toLowerCase();
    const title = (note.data_title || '').trim().toLowerCase();
    return type === 'auto_sum_note' || tab === 'summary' || title === 'summary';
  });
  if (defaults.length > 0) return defaults[0];

  return notes[0];
}

function getSummaryPreferenceRank(note) {
  if (!note) return 0;

  const tab = (note.data_tab_name || '').trim().toLowerCase();
  const title = (note.data_title || '').trim().toLowerCase();
  const type = (note.data_type || '').trim().toLowerCase();

  if (tab === 'obsidian meeting template' || title === 'obsidian meeting template') return 3;
  if (type === 'auto_sum_note' || tab === 'summary' || title === 'summary') return 2;
  return 1;
}

function describeSummaryChoice(note) {
  if (!note) return null;
  return note.data_tab_name || note.data_title || note.data_type || null;
}

function getRecordingTimestamp(recording) {
  const raw = recording.start_at || recording.updated_at || recording.modified_at || recording.created_at || null;
  if (!raw) return null;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function shouldRecheckForPreferredSummary(recording, existing) {
  if (!existing) return false;
  if ((existing.summaryPreferenceRank || 0) >= 3) return false;

  const ts = getRecordingTimestamp(recording);
  if (!ts) return false;

  const ageHours = (Date.now() - ts) / (1000 * 60 * 60);
  return ageHours <= DEFAULT_SUMMARY_STABILIZATION_HOURS;
}

function shouldProcessRecording(recording, syncState, incremental) {
  if (!incremental) return true;

  const existing = syncState.syncedRecordings?.[recording.id];
  if (!existing) return true;

  const currentFingerprint = recording.updated_at || recording.modified_at || recording.created_at || recording.start_at || null;
  if (existing.sourceFingerprint !== currentFingerprint) return true;
  if (shouldRecheckForPreferredSummary(recording, existing)) return true;
  return false;
}

function htmlUnescape(value) {
  return String(value == null ? '' : value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'); // &amp; last so we don't double-decode
}

// get_note returns an array of note objects. Keep only items with real markdown
// content (drops consumer_note items that carry just an expiring S3 link),
// unescape HTML entities, and join multiple summaries with a divider.
function renderNote(noteArray) {
  return (Array.isArray(noteArray) ? noteArray : [])
    .filter((n) => n && n.data_content && n.data_content.trim())
    .map((n) => htmlUnescape(n.data_content))
    .join('\n\n---\n\n');
}

/**
 * Segments out of a get_transcript payload, in either shape PLAUD has used.
 *
 * ⚠ THE SHAPE CHANGED, AND IT FAILED SILENTLY. It used to be an ARRAY of items, one
 * carrying `data_type: 'transaction'` with the segments as a JSON STRING in
 * `data_content`. It is now a single OBJECT — `{ file_id, block, total, offset, limit,
 * returned, next_cursor, segments: [...] }` — with the segments already parsed.
 *
 * The old code opened with `if (!Array.isArray(payload)) return []`, so the new object
 * yielded nothing, `fetchTranscriptBody` retried three times, got nothing three times,
 * and wrote a "No transcript returned by PLAUD" stub. It looked exactly like PLAUD being
 * under load. 103 stub notes had accumulated in the vault by 2026-08-28, every recording
 * since the change, while the transcripts sat in PLAUD perfectly intact.
 *
 * So both shapes are read, and the old one is kept rather than replaced: this has moved
 * once and there is no reason to think it will not move back.
 */
function extractTranscriptSegments(payload) {
  // New shape: the object carries `segments` directly.
  if (payload && !Array.isArray(payload) && Array.isArray(payload.segments)) {
    return payload.segments;
  }

  if (!Array.isArray(payload)) return [];

  const transaction = payload.find((item) => item && item.data_type === 'transaction');
  if (transaction && typeof transaction.data_content === 'string') {
    try {
      const segments = JSON.parse(transaction.data_content);
      if (Array.isArray(segments)) return segments;
    } catch (error) {
      console.error('[PlaudSync] Failed to parse transcript transaction payload:', error.message);
    }
  }
  // An array of bare segments, should it ever arrive that way.
  if (payload.length && payload.every((x) => x && typeof x.content === 'string')) return payload;

  return [];
}

/** How many pages to follow before giving up. 50 segments a page — 40 pages is a very
 *  long meeting, and the cap exists so a broken cursor cannot loop for ever. */
const MAX_TRANSCRIPT_PAGES = 40;

// A label of the "Speaker 3" form is a slot, not a name — matched case-insensitively
// and allowing the bare word, so "speaker" alone is not mistaken for somebody called it.
const GENERIC_SPEAKER_RE = /^speaker[ _-]*[0-9]*$/i;

// Render segments using the real `speaker` name (NOT original_speaker, the raw
// "Speaker N" label) with an mm:ss timestamp.
function renderTranscript(segments) {
  return (Array.isArray(segments) ? segments : [])
    .filter((s) => s && (s.content || '').trim())
    .map((s) => {
      const t = new Date(s.start_time).toISOString().substr(14, 5); // mm:ss
      return `**${s.speaker || 'Speaker'}** \`${t}\`  ${s.content.trim()}`;
    })
    .join('\n\n');
}

/**
 * Whether PLAUD has finished putting real names to the voices in a recording. PURE —
 * takes segments, no clock, no network, no DB (the `pi-health.assess()` split).
 *
 * Every segment carries BOTH `speaker` and `original_speaker`. The raw diarisation
 * label ("Speaker 1") lands in `original_speaker` and stays there; `speaker` is where
 * a real name appears once one has been assigned. So an unnamed voice is one whose
 * `speaker` still equals its raw label — verified against live recordings, where a
 * named 1-2-1 reads `speaker: "Nick Ward" / original_speaker: "Speaker 1"` and an
 * unnamed one reads `"Speaker 2" / "Speaker 2"`.
 *
 * ⚠ A slot counts as named if ANY of its segments names it. Attribution is per
 * utterance and PLAUD is not perfectly consistent across a long recording; requiring
 * every line to agree would hold a fully named meeting on one stray label for ever.
 *
 * ⚠ This says names were ASSIGNED, never that they are CORRECT. Live data has a
 * segment labelled "Nick Ward" whose raw label is "Speaker 2" — two voices merged.
 * Nothing here can see that, and nothing here should claim to.
 */
function assessSpeakerNaming(segments) {
  const list = Array.isArray(segments) ? segments : [];
  const slots = new Map();

  for (const segment of list) {
    if (!segment || typeof segment !== 'object') continue;
    // Fall back to `speaker` for the slot identity only when there is no raw label —
    // an older payload shape, not the normal case.
    const label = String(segment.original_speaker || segment.speaker || '').trim();
    if (!label) continue;
    const name = String(segment.speaker || '').trim();
    const named = Boolean(name) && name !== label && !GENERIC_SPEAKER_RE.test(name);

    const slot = slots.get(label) || { label, name: null, named: false };
    if (named && !slot.named) {
      slot.named = true;
      slot.name = name;
    }
    slots.set(label, slot);
  }

  const speakers = [...slots.values()];
  if (!speakers.length) {
    // No segments is NOT "nobody is named" — it is "there is nothing to judge yet",
    // and the two license opposite behaviour. Holding on an absence would wait out
    // the full deadline on every recording whose transcript never arrives.
    return {
      known: false,
      complete: false,
      solo: false,
      speakers: [],
      total: 0,
      namedCount: 0,
      unnamed: [],
      reason: 'no transcript segments to judge speakers on'
    };
  }

  const unnamed = speakers.filter((slot) => !slot.named).map((slot) => slot.label);
  const namedCount = speakers.length - unnamed.length;

  return {
    known: true,
    complete: unnamed.length === 0,
    // A recording with one voice has nothing to disambiguate, so PLAUD never names it.
    // Holding one would burn the whole deadline on every solo memo, every time.
    solo: speakers.length === 1,
    speakers,
    total: speakers.length,
    namedCount,
    unnamed,
    reason: unnamed.length === 0
      ? `all ${speakers.length} speaker${speakers.length === 1 ? '' : 's'} named`
      : `${unnamed.length} of ${speakers.length} still unnamed (${unnamed.join(', ')})`
  };
}

/**
 * Whether to hold a recording back for another cycle. PURE — `now` and `firstSeenAt`
 * are passed in, never read from the clock.
 *
 * ⚠ The deadline is what makes holding safe, so every path that cannot measure it
 * PULLS. A hold that can outlive its own clock is a recording that never arrives, and
 * a transcript nobody can find is a far worse failure than an unattributed one.
 */
function decideSpeakerHold({ naming, firstSeenAt, now, maxHoldMs = 60 * 60 * 1000, enabled = true } = {}) {
  if (!enabled) return { hold: false, outcome: 'disabled', waitedMs: null, reason: 'speaker wait is switched off' };
  if (!naming || !naming.known) {
    return { hold: false, outcome: 'unjudgeable', waitedMs: null, reason: naming ? naming.reason : 'no naming assessment' };
  }
  if (naming.complete) return { hold: false, outcome: 'named', waitedMs: null, reason: naming.reason };
  if (naming.solo) return { hold: false, outcome: 'solo', waitedMs: null, reason: 'single speaker — PLAUD has nobody to tell apart' };

  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const seenMs = firstSeenAt instanceof Date ? firstSeenAt.getTime() : Date.parse(firstSeenAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(seenMs)) {
    return { hold: false, outcome: 'unmeasurable', waitedMs: null, reason: 'cannot measure how long this has waited — pulling rather than holding blind' };
  }

  // A stamp in the future (clock skew, a restored backup) reads as no wait at all
  // rather than as a negative one, so it can still expire normally.
  const waitedMs = Math.max(0, nowMs - seenMs);
  if (waitedMs >= maxHoldMs) {
    return { hold: false, outcome: 'timeout', waitedMs, reason: `waited ${Math.round(waitedMs / 60000)} min — pulling with ${naming.reason}` };
  }

  return { hold: true, outcome: 'waiting', waitedMs, reason: naming.reason };
}

// The wait is measured from when NEURO FIRST SAW the recording, and that stamp is
// persisted. An in-memory timer would be wrong twice over: the backend restarts several
// times a day on deploys, so the hour would reset on each one and a recording could be
// held indefinitely, never reaching the deadline that makes holding safe.
function noteSpeakerHold(syncState, recordingId, nowIso, naming) {
  if (!syncState.pendingSpeakers) syncState.pendingSpeakers = {};
  const existing = syncState.pendingSpeakers[recordingId];
  syncState.pendingSpeakers[recordingId] = {
    firstSeenAt: existing?.firstSeenAt || nowIso,
    lastCheckedAt: nowIso,
    attempts: (existing?.attempts || 0) + 1,
    unnamed: naming?.unnamed || [],
    total: naming?.total || 0
  };
  return syncState.pendingSpeakers[recordingId];
}

function clearSpeakerHold(syncState, recordingId) {
  if (syncState.pendingSpeakers && syncState.pendingSpeakers[recordingId]) {
    delete syncState.pendingSpeakers[recordingId];
    return true;
  }
  return false;
}

function escapeYaml(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function yamlScalar(value) {
  return value ? `"${escapeYaml(value)}"` : 'null';
}

function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// The metadata from `get_file` is what names the note, dates it and keys it to a
// PLAUD recording. If it arrives unusable, the note that gets written is still a
// perfectly valid file — just titled "Summary", dated today and carrying
// `plaud_id: "undefined"` — which is indistinguishable from a real note until you
// go looking for a meeting by name. Refusing costs one recording and a loud line
// in the log; writing costs a note nobody can find and a ledger entry saying the
// work is done.
function assertUsableDetails(details, recordingId) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) {
    throw new Error(
      `get_file returned ${Array.isArray(details) ? 'an array' : typeof details} for ${recordingId} — expected an object`
    );
  }
  if (!details.id) {
    throw new Error(`get_file returned no id for ${recordingId} — refusing to write a note with unknown metadata`);
  }
  return details;
}

function buildNoteBaseName(recording) {
  const stamp = recording.start_at || recording.created_at || new Date().toISOString();
  const datePrefix = new Date(stamp);
  const prefix = Number.isNaN(datePrefix.getTime()) ? 'undated' : datePrefix.toISOString().slice(0, 10);
  const title = slugify(recording.name || recording.id) || recording.id;
  return `${prefix} ${title}`;
}

// PLAUD's data_title names the summary TAB, not the meeting — it is almost always
// the literal "Summary". Because it came first in the fallback chain it beat
// recording.name (the actual meeting title), so every routed meeting note landed
// as "<date> – Summary.md", then "Summary 3", "Summary 4" as collisions piled up.
// The vault ended up full of notes Nick couldn't find by name. recording.name is
// the same source the transcript filenames use, which is why those read properly.
const GENERIC_NOTE_TITLES = new Set([
  'summary', 'summaries', 'note', 'notes', 'transcript',
  'obsidian meeting template', 'auto summary', 'ai summary', 'meeting',
]);

function pickNoteTitle(recording, note) {
  for (const candidate of [note.data_title, note.data_tab_name]) {
    const value = String(candidate || '').trim();
    if (value && !GENERIC_NOTE_TITLES.has(value.toLowerCase())) return value;
  }
  const recordingName = String(recording.name || '').trim();
  if (recordingName) return recordingName;
  return String(note.data_title || note.data_tab_name || recording.id || '').trim();
}

function renderSummaryNote(recording, note, summaryBody, transcriptRelativePath) {
  const noteTitle = pickNoteTitle(recording, note);
  const lines = [
    '---',
    `plaud_id: "${escapeYaml(recording.id)}"`,
    `title: "${escapeYaml(noteTitle)}"`,
    `created_at: ${yamlScalar(recording.created_at)}`,
    `start_at: ${yamlScalar(recording.start_at)}`,
    `duration_ms: ${recording.duration != null ? recording.duration : 'null'}`,
    `serial_number: ${yamlScalar(recording.serial_number)}`,
    `note_type: "summary"`,
    `plaud_summary_type: ${yamlScalar(note.data_type)}`,
    `plaud_summary_tab: ${yamlScalar(note.data_tab_name || note.data_title || 'Summary')}`,
    'source: plaud-mcp',
    '---',
    '',
    `# ${noteTitle}`,
    '',
    '## Recording',
    '',
    `- Plaud ID: \`${recording.id}\``,
    `- Created: ${recording.created_at || 'Unknown'}`,
    `- Started: ${recording.start_at || 'Unknown'}`,
    `- Duration: ${formatDuration(recording.duration)}`,
    `- Device: ${recording.serial_number || 'Unknown'}`,
    `- Transcript: [[${transcriptRelativePath.replace(/\.md$/i, '')}]]`,
    '',
    '## Summary',
    '',
    summaryBody || 'No summary content returned by Plaud for this recording.'
  ];

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderTranscriptNote(recording, summaryRelativePath, transcriptBody, naming = null) {
  const meetingDate = new Date(recording.start_at || recording.created_at || Date.now()).toISOString().slice(0, 10);
  const lines = [
    '---',
    `plaud_id: "${escapeYaml(recording.id)}"`,
    `date: ${meetingDate}`,
    `title: "${escapeYaml(recording.name || recording.id)}"`,
    `created_at: ${yamlScalar(recording.created_at)}`,
    `start_at: ${yamlScalar(recording.start_at)}`,
    'type: transcript',
    'note_type: "transcript"',
    'source: PLAUD',
    // Three-valued on purpose: null is "never judged" (no transcript to judge on, or a
    // note written before this existed), which is NOT the same fact as "judged, and the
    // speakers were never named". A reader must be able to tell those apart.
    `speakers_named: ${naming && naming.known ? String(naming.complete) : 'null'}`,
    '---',
    '',
    `# ${recording.name || recording.id}`,
    '',
    `Summary: [[${summaryRelativePath.replace(/\.md$/i, '')}]]`,
    '',
    '## Transcript',
    ''
  ];

  // Say it in the body as well as the frontmatter. This note is read by a person
  // looking for who said what, and an unattributed transcript that looks exactly like
  // an attributed one is how a "Speaker 2" quote gets put in somebody's mouth.
  if (naming && naming.known && !naming.complete) {
    lines.push(`> ⚠ Speakers were never named in PLAUD — ${naming.reason}. Attribution below is unreliable.`, '');
  }

  if (transcriptBody && transcriptBody.trim()) {
    lines.push(transcriptBody.trim());
  } else {
    lines.push('No transcript returned by Plaud for this recording.');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function formatDuration(durationMs) {
  if (!durationMs || Number.isNaN(durationMs)) return 'Unknown';
  const totalSeconds = Math.floor(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function writeFile(relativePath, content) {
  const fullPath = path.join(getVaultPath(), relativePath);
  const existed = fs.existsSync(fullPath);
  const previous = existed ? fs.readFileSync(fullPath, 'utf-8') : null;
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf-8');
  try {
    require('./vault-hooks').onVaultWrite(fullPath, 'plaud-sync');
  } catch {}
  return {
    fullPath,
    existed,
    changed: !existed || previous !== content
  };
}

function getExistingNoteTargets(existingNotes, summaryCount, defaultSummaryPath, defaultTranscriptPath) {
  const summaries = existingNotes?.summaries?.length ? existingNotes.summaries.slice(0, summaryCount) : [];
  while (summaries.length < summaryCount) {
    const fallback = summaries.length === 0 ? defaultSummaryPath : defaultSummaryPath.replace(/\.md$/i, ` ${summaries.length + 1}.md`);
    summaries.push(fallback);
  }

  return {
    summaryPaths: summaries,
    transcriptPath: existingNotes?.transcripts?.[0] || defaultTranscriptPath
  };
}

async function syncPlaudRecordings({ incremental = true } = {}) {
  const runningState = readRunningState();
  if (runningState.active && !runningState.stale) {
    return { started: false, skipped: true, reason: 'Sync already running' };
  }
  if (runningState.active && runningState.stale) {
    console.warn('[PlaudSync] Clearing stale running state from previous interrupted sync');
  }

  writeRunningState(true);
  const syncState = readSyncState();
  const startedAt = new Date();
  syncState.lastRunAt = startedAt.toISOString();
  writeSyncState(syncState);

  try {
    ensureFolder(normalizeVaultPath(getSummaryFolder()));
    ensureFolder(normalizeVaultPath(getTranscriptFolder()));
    const existingNotesByPlaudId = buildExistingNoteIndex();

    const { client, transport } = await createClient();
    try {
      // The failure ledger widens the window — see incrementalDateFrom.
      const dateFrom = incrementalDateFrom(
        syncState.lastSuccessfulSyncAt, incremental, DEFAULT_SYNC_LOOKBACK_DAYS, syncState.failedRecordings
      );
      const outstandingFailures = Object.keys(syncState.failedRecordings || {}).length;
      if (outstandingFailures) {
        console.log(`[PlaudSync] ${outstandingFailures} outstanding failure(s) — listing from ${dateFrom} to retry them`);
      }

      const recordings = await listRecordings(client, dateFrom);
      recordings.sort((a, b) => {
        const aTime = new Date(a.start_at || a.created_at || 0).getTime();
        const bTime = new Date(b.start_at || b.created_at || 0).getTime();
        return aTime - bTime;
      });

      let imported = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;
      const failures = [];

      for (const recording of recordings) {
        if (!shouldProcessRecording(recording, syncState, incremental)) {
          skipped += 1;
          continue;
        }

        try {
          const details = assertUsableDetails(
            await withRetry(`get_file ${recording.id}`, () =>
              callTool(client, 'get_file', { file_id: recording.id })
            ),
            recording.id
          );
          const noteList = await withRetry(`get_note ${recording.id}`, () =>
            callTool(client, 'get_note', { file_id: recording.id })
          );
          const preferredSummary = choosePreferredSummary(Array.isArray(noteList) ? noteList : []);
          const summaryBody = renderNote(noteList);
          // Retry on empty — PLAUD returns nothing while a recording is still transcribing.
          const transcriptSegments = await fetchTranscriptSegments(client, recording.id);
          const transcriptBody = renderTranscript(transcriptSegments);

          // Not ready: PLAUD has produced neither transcript nor summary yet (a premature
          // pull mid-processing). Skip WITHOUT writing a stub or marking it synced, so the
          // next sync cycle re-pulls it once PLAUD has finished — no orphan stub is created.
          if (!summaryBody.trim() && !transcriptBody.trim()) {
            skipped += 1;
            console.log(`[PlaudSync] ${recording.id} not ready (no transcript/summary yet) — retry next cycle`);
            continue;
          }

          // Ready, but are the speakers named? PLAUD assigns real names some minutes
          // after the transcript itself lands, so pulling the moment a transcript exists
          // reliably captures it at its least useful — "Speaker 2" throughout, permanently,
          // because nothing re-pulls a recording once it is ledgered.
          //
          // ⚠ Holding costs a re-fetch per cycle and is bounded by a persisted deadline.
          // On expiry the recording is pulled ANYWAY, stamped as unattributed: a late
          // transcript is a nuisance, a transcript that never arrives is a lost meeting.
          const speakerNaming = assessSpeakerNaming(transcriptSegments);
          const pending = syncState.pendingSpeakers?.[recording.id] || null;
          const speakerHold = decideSpeakerHold({
            naming: speakerNaming,
            firstSeenAt: pending?.firstSeenAt || new Date().toISOString(),
            now: new Date(),
            maxHoldMs: speakerWaitMs(),
            enabled: speakerWaitEnabled()
          });

          if (speakerHold.hold) {
            const held = noteSpeakerHold(syncState, recording.id, new Date().toISOString(), speakerNaming);
            // Persisted PER RECORDING, never batched to the end of the run: a crash or a
            // deploy mid-pass would otherwise lose the stamp and restart the clock.
            writeSyncState(syncState);
            skipped += 1;
            console.log(
              `[PlaudSync] ${recording.id} held for speaker naming — ${speakerHold.reason}; ` +
              `waited ${Math.round((speakerHold.waitedMs || 0) / 60000)}/${Math.round(speakerWaitMs() / 60000)} min, attempt ${held.attempts}`
            );
            // NOT ledgered, so `shouldProcessRecording` re-offers it next cycle.
            continue;
          }

          if (speakerHold.outcome === 'timeout') {
            console.warn(`[PlaudSync] ${recording.id} pulled UNATTRIBUTED — ${speakerHold.reason}`);
          }
          if (clearSpeakerHold(syncState, recording.id)) writeSyncState(syncState);

          const baseName = buildNoteBaseName(details);
          const defaultSummaryRelativePath = `${normalizeVaultPath(getSummaryFolder())}/${baseName}.md`;
          const defaultTranscriptRelativePath = `${normalizeVaultPath(getTranscriptFolder())}/${baseName}.md`;
          const targets = getExistingNoteTargets(
            existingNotesByPlaudId[recording.id],
            1,
            defaultSummaryRelativePath,
            defaultTranscriptRelativePath
          );
          const summaryRelativePath = targets.summaryPaths[0];
          const transcriptRelativePath = targets.transcriptPath;

          const hadExistingSync = Boolean(syncState.syncedRecordings[recording.id]);
          const summaryWrite = writeFile(
            summaryRelativePath,
            renderSummaryNote(details, preferredSummary, summaryBody, transcriptRelativePath)
          );
          const transcriptWrite = writeFile(
            transcriptRelativePath,
            renderTranscriptNote(details, summaryRelativePath, transcriptBody, speakerNaming)
          );

          let transcriptResult = null;
          try {
            transcriptResult = await require('./transcript-processor').processTranscript(transcriptWrite.fullPath);
          } catch (error) {
            console.error('[PlaudSync] Transcript enrichment failed:', error.message);
          }

          let finalSummaryRelativePath = summaryRelativePath;
          try {
            const routeResult = await require('./imports').routePlaudSummary(summaryWrite.fullPath, {
              transcriptPath: transcriptWrite.fullPath,
              transcriptInsight: transcriptResult
            });
            if (routeResult.status === 'ok' && routeResult.relativePath) {
              finalSummaryRelativePath = routeResult.relativePath;
            } else if (routeResult.error) {
              console.warn(`[PlaudSync] PLAUD route skipped for ${recording.id}: ${routeResult.error}`);
            }
          } catch (error) {
            console.error(`[PlaudSync] PLAUD route failed for ${recording.id}:`, error.message);
          }

          if (hadExistingSync) updated += 1;
          else imported += 1;

          syncState.syncedRecordings[recording.id] = {
            summaryRelativePath: finalSummaryRelativePath,
            transcriptRelativePath,
            syncedAt: new Date().toISOString(),
            sourceCreatedAt: details.created_at || null,
            sourceStartAt: details.start_at || null,
            sourceFingerprint: details.updated_at || details.modified_at || details.created_at || details.start_at || null,
            summaryPreferenceRank: getSummaryPreferenceRank(preferredSummary),
            summaryPreferenceLabel: describeSummaryChoice(preferredSummary)
          };
          existingNotesByPlaudId[recording.id] = {
            summaries: [finalSummaryRelativePath],
            transcripts: [transcriptRelativePath]
          };
          delete syncState.failedRecordings[recording.id];
          writeSyncState(syncState);

          if (DEFAULT_BETWEEN_RECORDINGS_MS > 0) {
            await sleep(DEFAULT_BETWEEN_RECORDINGS_MS);
          }
        } catch (error) {
          failed += 1;
          const message = error.message || String(error);
          console.error(`[PlaudSync] Recording ${recording.id} failed:`, message);
          const prior = syncState.failedRecordings[recording.id] || {};
          syncState.failedRecordings[recording.id] = {
            // `firstFailedAt` is kept so a recording failing every night is distinguishable
            // from one that failed once — the first is a broken recording, the second is a
            // blip, and they want different attention.
            firstFailedAt: prior.firstFailedAt || new Date().toISOString(),
            failedAt: new Date().toISOString(),
            attempts: (prior.attempts || 0) + 1,
            message,
            title: recording.name || recording.id
          };
          writeSyncState(syncState);
          failures.push({
            id: recording.id,
            title: recording.name || recording.id,
            error: message
          });
        }
      }

      if (failed === 0) {
        syncState.lastSuccessfulSyncAt = startedAt.toISOString();
      }
      writeSyncState(syncState);
      db.setState(PLAUD_LAST_ERROR_KEY, failed > 0 ? failures[0].error : '');

      // Phase 2: auto-link newly imported meetings so they arrive already connected
      // (contextual-link scans Meetings/Plaud; already-linked notes are skipped).
      if (imported + updated > 0) {
        try {
          const linked = require('./vault-hygiene').contextualLinkApply(getVaultPath(), { roots: ['Meetings', 'Plaud'] });
          if (linked.totalLinks) console.log(`[PlaudSync] auto-linked ${linked.totalLinks} links across ${linked.notesDone} new notes`);
        } catch (e) { console.error('[PlaudSync] auto contextual-link failed:', e.message); }
      }

      return {
        started: true,
        imported,
        updated,
        skipped,
        failed,
        total: recordings.length,
        lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt,
        failures
      };
    } finally {
      await transport.close();
    }
  } catch (error) {
    db.setState(PLAUD_LAST_ERROR_KEY, error.message);
    throw error;
  } finally {
    writeRunningState(false);
  }
}

function getStatus() {
  let syncState = { syncedRecordings: {}, failedRecordings: {}, pendingSpeakers: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
  let running = false;
  let stale = false;
  let lastError = null;

  try {
    syncState = readSyncState();
    const runningState = readRunningState();
    running = runningState.active && !runningState.stale;
    stale = runningState.stale;
    lastError = db.getState(PLAUD_LAST_ERROR_KEY) || null;
  } catch {
    // DB not initialized yet — return static config/status only.
  }

  const syncedCount = Object.keys(syncState.syncedRecordings || {}).length;
  const failedCount = Object.keys(syncState.failedRecordings || {}).length;
  // A held recording is one NEURO has deliberately not written yet, so it must be
  // visible: silently absent from the vault while everything reports healthy is exactly
  // how nine days of missing meetings went unnoticed before.
  const pendingSpeakers = Object.entries(syncState.pendingSpeakers || {}).map(([id, held]) => ({
    id,
    firstSeenAt: held?.firstSeenAt || null,
    lastCheckedAt: held?.lastCheckedAt || null,
    attempts: held?.attempts || 0,
    unnamed: held?.unnamed || [],
    total: held?.total || 0
  }));
  const vaultConfigured = Boolean(process.env.OBSIDIAN_VAULT_PATH);
  return {
    configured: vaultConfigured,
    command: getPlaudCommand(),
    args: getPlaudArgs(),
    summaryFolder: getSummaryFolder(),
    transcriptFolder: getTranscriptFolder(),
    running,
    staleRun: stale,
    lastRunAt: syncState.lastRunAt || null,
    lastSuccessfulSyncAt: syncState.lastSuccessfulSyncAt || null,
    lastError,
    syncedCount,
    failedCount,
    speakerWait: {
      enabled: speakerWaitEnabled(),
      maxHoldMinutes: Math.round(speakerWaitMs() / 60000),
      pendingCount: pendingSpeakers.length,
      pending: pendingSpeakers
    }
  };
}

// ═══════════════════════════════════════════════════════
// Reconcile + targeted re-pull (build handoff §9)
//
// The 23 Jun reset binned ~178 recordings' notes into Archive, so they have no
// ACTIVE note even though the ledger still lists them as synced. Incremental sync
// would skip them. Reconcile finds recordings with no active note (by date +
// title-token match, NOT filename equality); repull fetches those FRESH from
// PLAUD (never restores from Archive) through the same throttled/retried/ledgered
// pipeline as syncPlaudRecordings.
// ═══════════════════════════════════════════════════════

const REPORT_FOLDER = 'Documents/System/Vault Audit';
// Active scan skips Archive (the whole point) + non-note/system dirs.
const RECONCILE_EXCLUDE = new Set(['Archive', '.obsidian', '.git', '.trash', '.stfolder', '.stversions', '.sync', '.claude', 'Templates', 'Scripts', 'node_modules', 'Conflicts']);

function titleTokens(str) {
  return new Set(
    String(str || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function recordingDateStr(recording) {
  const raw = recording.start_at || recording.created_at || recording.updated_at || null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Read every ACTIVE note (Archive excluded) and index it by date + title tokens,
// plus the set of plaud_ids that resolve to an active note.
function buildActiveNoteIndex() {
  const vaultPath = getVaultPath();
  const byDate = new Map();   // 'YYYY-MM-DD' -> [ Set<token> ]
  const plaudIds = new Set();

  for (const filePath of readMarkdownFiles(vaultPath)) {
    const relParts = path.relative(vaultPath, filePath).split(path.sep);
    if (relParts.some((seg) => RECONCILE_EXCLUDE.has(seg))) continue;

    let content = '';
    try { content = fs.readFileSync(filePath, 'utf-8'); } catch { continue; }

    const pid = extractFrontmatterValue(content, 'plaud_id');
    if (pid) plaudIds.add(pid);

    const base = path.basename(filePath, '.md');
    const fnDate = base.match(/(\d{4}-\d{2}-\d{2})/);
    const date = (fnDate && fnDate[1])
      || extractFrontmatterValue(content, 'date')
      || (extractFrontmatterValue(content, 'start_at') || '').slice(0, 10)
      || null;
    if (!date) continue;

    // Tokens from the filename minus its date prefix (the human title).
    const titlePart = base.replace(/\d{4}-\d{2}-\d{2}/g, ' ');
    const tokens = titleTokens(titlePart);
    if (!byDate.has(date)) byDate.set(date, []);
    byDate.get(date).push(tokens);
  }
  return { byDate, plaudIds };
}

/**
 * Read-only. List every PLAUD recording and find those with no ACTIVE vault note.
 * Match: plaud_id in an active note (strong) OR same date + title-token Jaccard ≥0.5;
 * recordings with no descriptive title match by date alone. Writes a report.
 * @returns {{ total, present, missing: Array<{id,date,title}>, reportPath }}
 */
async function reconcilePlaudRecordings({ minJaccard = 0.5, write = true } = {}) {
  const index = buildActiveNoteIndex();
  const { client, transport } = await createClient();
  let recordings;
  try {
    recordings = await listRecordings(client);
  } finally {
    await transport.close();
  }

  const missing = [];
  for (const rec of recordings) {
    const id = rec.id;
    const title = rec.name || '';
    if (index.plaudIds.has(id)) continue;                 // active note carries the id

    const date = recordingDateStr(rec);
    const sameDate = date ? (index.byDate.get(date) || []) : [];
    const tokens = titleTokens(title);

    let present;
    if (tokens.size === 0) {
      present = sameDate.length > 0;                       // unnamed/timestamp → date match
    } else {
      present = sameDate.some((noteTokens) => jaccard(tokens, noteTokens) >= minJaccard);
    }
    if (!present) missing.push({ id, date: date || 'undated', title: title || '(unnamed)' });
  }

  missing.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  let reportPath = null;
  if (write) {
    const lines = [
      '---', 'type: reference', `created: ${new Date().toISOString().slice(0, 10)}`, 'tags: [plaud, reconcile, audit]', 'author: NEURO plaud-sync', '---',
      `# PLAUD Reconciliation — ${new Date().toISOString().slice(0, 10)}`, '',
      `**${recordings.length}** PLAUD recordings · **${recordings.length - missing.length}** have an active note · **${missing.length}** missing.`, '',
      'Missing recordings have no active vault note (notes may be in Archive). Re-pull fetches these FRESH from PLAUD — never restore from Archive.', '',
      '| Date | PLAUD ID | Title |', '|---|---|---|',
      ...missing.map((m) => `| ${m.date} | \`${m.id}\` | ${m.title.replace(/\|/g, '\\|')} |`),
    ];
    const dir = path.join(getVaultPath(), REPORT_FOLDER);
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `PLAUD Missing Reconciliation ${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(outPath, lines.join('\n') + '\n\n_Part of [[Logs]]_\n', 'utf-8');
    reportPath = path.relative(getVaultPath(), outPath).replace(/\\/g, '/');
  }

  return { total: recordings.length, present: recordings.length - missing.length, missing, reportPath };
}

// Fetch + render + stage + route a single recording FRESH. Mirrors the inner body
// of syncPlaudRecordings but always writes to default (new) paths and updates the
// shared ledger so a crash resumes. Returns the routed summary path.
async function processRecordingFresh(client, recording, syncState) {
  const details = assertUsableDetails(
    await withRetry(`get_file ${recording.id}`, () => callTool(client, 'get_file', { file_id: recording.id })),
    recording.id
  );
  const noteList = await withRetry(`get_note ${recording.id}`, () => callTool(client, 'get_note', { file_id: recording.id }));

  const preferredSummary = choosePreferredSummary(Array.isArray(noteList) ? noteList : []);
  const summaryBody = renderNote(noteList);
  // get_transcript returns empty intermittently under load even when a transcript
  // exists; fetchTranscriptBody retries on empty before giving up (prevents stubs).
  const transcriptSegments = await fetchTranscriptSegments(client, recording.id);
  const transcriptBody = renderTranscript(transcriptSegments);
  // ⚠ Repull is a deliberate manual recovery for a recording that is MISSING, so it
  // never waits for naming — it pulls and stamps what it found. Holding here would make
  // the one route back from a lost meeting refuse to run for an hour.
  const speakerNaming = assessSpeakerNaming(transcriptSegments);

  const baseName = buildNoteBaseName(details);
  const summaryRelativePath = `${normalizeVaultPath(getSummaryFolder())}/${baseName}.md`;
  const transcriptRelativePath = `${normalizeVaultPath(getTranscriptFolder())}/${baseName}.md`;

  const summaryWrite = writeFile(summaryRelativePath, renderSummaryNote(details, preferredSummary, summaryBody, transcriptRelativePath));
  const transcriptWrite = writeFile(transcriptRelativePath, renderTranscriptNote(details, summaryRelativePath, transcriptBody, speakerNaming));

  let transcriptResult = null;
  try { transcriptResult = await require('./transcript-processor').processTranscript(transcriptWrite.fullPath); }
  catch (error) { console.error('[PlaudSync] Transcript enrichment failed:', error.message); }

  let finalSummaryRelativePath = summaryRelativePath;
  try {
    const routeResult = await require('./imports').routePlaudSummary(summaryWrite.fullPath, {
      transcriptPath: transcriptWrite.fullPath,
      transcriptInsight: transcriptResult,
    });
    if (routeResult.status === 'ok' && routeResult.relativePath) finalSummaryRelativePath = routeResult.relativePath;
    else if (routeResult.error) console.warn(`[PlaudSync] PLAUD route skipped for ${recording.id}: ${routeResult.error}`);
  } catch (error) { console.error(`[PlaudSync] PLAUD route failed for ${recording.id}:`, error.message); }

  syncState.syncedRecordings[recording.id] = {
    summaryRelativePath: finalSummaryRelativePath,
    transcriptRelativePath,
    syncedAt: new Date().toISOString(),
    sourceCreatedAt: details.created_at || null,
    sourceStartAt: details.start_at || null,
    sourceFingerprint: details.updated_at || details.modified_at || details.created_at || details.start_at || null,
    summaryPreferenceRank: getSummaryPreferenceRank(preferredSummary),
    summaryPreferenceLabel: describeSummaryChoice(preferredSummary),
  };
  delete syncState.failedRecordings[recording.id];
  writeSyncState(syncState);
  return finalSummaryRelativePath;
}

/**
 * Targeted, throttled, resumable re-pull of specific recordings (default: the
 * reconcile "missing" set). Force-processes each id (bypassing the incremental
 * skip), persisting the ledger after every recording so a crash resumes.
 * @param {object} opts
 * @param {string[]} [opts.ids]   Recording ids to pull. Omit to reconcile first.
 * @param {number}   [opts.limit] Cap recordings this run (for safe batched runs).
 */
async function repullPlaudRecordings({ ids = null, limit = null } = {}) {
  const runningState = readRunningState();
  if (runningState.active && !runningState.stale) {
    return { started: false, skipped: true, reason: 'PLAUD sync/repull already running' };
  }

  let targetIds = ids;
  if (!targetIds) {
    const recon = await reconcilePlaudRecordings({ write: false });
    targetIds = recon.missing.map((m) => m.id);
  }
  if (limit && targetIds.length > limit) targetIds = targetIds.slice(0, limit);

  writeRunningState(true);
  const syncState = readSyncState();
  const startedAt = new Date();
  syncState.lastRunAt = startedAt.toISOString();
  writeSyncState(syncState);

  let pulled = 0, failed = 0;
  const failures = [];
  try {
    ensureFolder(normalizeVaultPath(getSummaryFolder()));
    ensureFolder(normalizeVaultPath(getTranscriptFolder()));
    const { client, transport } = await createClient();
    try {
      // Index the live recording list once so we have each id's metadata.
      const recordings = await listRecordings(client);
      const byId = new Map(recordings.map((r) => [r.id, r]));

      for (const id of targetIds) {
        const recording = byId.get(id) || { id };
        try {
          await processRecordingFresh(client, recording, syncState);
          pulled += 1;
        } catch (error) {
          failed += 1;
          const message = error.message || String(error);
          console.error(`[PlaudSync] Re-pull ${id} failed:`, message);
          syncState.failedRecordings[id] = { failedAt: new Date().toISOString(), message, title: recording.name || id };
          writeSyncState(syncState);
          failures.push({ id, title: recording.name || id, error: message });
        }
        if (DEFAULT_BETWEEN_RECORDINGS_MS > 0) await sleep(DEFAULT_BETWEEN_RECORDINGS_MS);
      }

      if (failed === 0) syncState.lastSuccessfulSyncAt = startedAt.toISOString();
      writeSyncState(syncState);
      db.setState(PLAUD_LAST_ERROR_KEY, failed > 0 ? failures[0].error : '');

      // Phase 2: auto-link the freshly re-pulled meetings.
      if (pulled > 0) {
        try { require('./vault-hygiene').contextualLinkApply(getVaultPath(), { roots: ['Meetings', 'Plaud'] }); }
        catch (e) { console.error('[PlaudSync] auto contextual-link failed:', e.message); }
      }

      return { started: true, requested: targetIds.length, pulled, failed, remaining: targetIds.length - pulled - failed, failures, resumable: true };
    } finally {
      await transport.close();
    }
  } catch (error) {
    db.setState(PLAUD_LAST_ERROR_KEY, error.message);
    throw error;
  } finally {
    writeRunningState(false);
  }
}

// ═══════════════════════════════════════════════════════
// Stub transcript recovery
//
// get_transcript returns empty intermittently (under load) even when PLAUD holds
// a full transcript — proven by re-fetching: a "No transcript returned" note's
// transcript comes back in full on a clean call. The old plugin + early repulls
// wrote those empties as "No transcript returned by Plaud" stubs. This recovers
// them: re-fetch each stub's transcript and rewrite the note (backed up).
// ═══════════════════════════════════════════════════════

const STUB_MARKER = 'No transcript returned by Plaud';
const PLAUD_BACKUP_REL = ['Scripts', '.lint-backups'];

// Fetch + render a transcript, retrying on EMPTY (not just on thrown errors).
/**
 * The whole transcript, following PLAUD's pagination to the end.
 *
 * ⚠ IT PAGES, AND A SINGLE CALL IS NOT THE MEETING. One request returns 50 segments of
 * a `total` that is routinely far higher — 50 of 94 on the recording this was found on.
 * Rendering just the first page would write a transcript that stops halfway through the
 * conversation with nothing to say it had, which is worse than the stub it replaced: a
 * stub is visibly empty, half a meeting reads as the whole one.
 *
 * The empty-retry stays for the case it was written for — PLAUD genuinely returning
 * nothing under load — but it now only fires when page ONE is empty.
 */
/**
 * The transcript SEGMENTS, paginated. Split out of `fetchTranscriptBody` so the
 * speaker-naming gate can read the structured fields it needs without a second,
 * identical download — the sync already pays for this fetch before it decides
 * anything, so checking whether the speakers are named costs no extra API calls.
 */
async function fetchTranscriptSegments(client, id, { emptyRetries = 3, emptyDelayMs = 2500 } = {}) {
  for (let attempt = 0; attempt <= emptyRetries; attempt += 1) {
    const segments = [];
    let offset = 0;

    for (let page = 0; page < MAX_TRANSCRIPT_PAGES; page += 1) {
      const args = offset ? { file_id: id, offset } : { file_id: id };
      const payload = await withRetry(`get_transcript ${id}@${offset}`, () => callTool(client, 'get_transcript', args));
      const batch = extractTranscriptSegments(payload);
      if (!batch.length) break;
      segments.push(...batch);

      // Stop on the totals rather than on the cursor alone: a server that stops sending
      // `next_cursor` but still has rows would silently truncate, and one that repeats a
      // cursor would loop.
      const total = Number(payload && payload.total);
      const next = offset + batch.length;
      if (!Number.isFinite(total) || next >= total) break;
      offset = next;
    }

    // ⚠ Retry on an empty RENDER, not an empty segment list: a page of segments that all
    // render blank is the same "still transcribing" state, and was the original bug here.
    if (renderTranscript(segments).trim()) return segments;
    if (attempt < emptyRetries) await sleep(emptyDelayMs * (attempt + 1));
  }
  return [];
}

async function fetchTranscriptBody(client, id, options = {}) {
  return renderTranscript(await fetchTranscriptSegments(client, id, options));
}

// Find every note carrying the stub marker that has a plaud_id to re-fetch.
function findStubTranscriptNotes() {
  const vaultPath = getVaultPath();
  const out = [];
  for (const fp of readMarkdownFiles(vaultPath)) {
    const relParts = path.relative(vaultPath, fp).split(path.sep);
    if (relParts.some((seg) => RECONCILE_EXCLUDE.has(seg))) continue;
    let content = '';
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.includes(STUB_MARKER)) continue;
    const pid = extractFrontmatterValue(content, 'plaud_id');
    if (!pid) continue;
    out.push({ path: fp, rel: path.relative(vaultPath, fp).replace(/\\/g, '/'), plaud_id: pid, content });
  }
  return out;
}

/**
 * Recover stub transcript notes: re-fetch each "No transcript returned" note's
 * transcript and rewrite its ## Transcript section in place. Append/overwrite is
 * surgical (frontmatter + everything before ## Transcript preserved), backed up,
 * throttled and resumable (a recovered note no longer carries the marker).
 * @param {object} opts  { limit?: number }
 */
async function repullStubTranscripts({ limit = null } = {}) {
  const runningState = readRunningState();
  if (runningState.active && !runningState.stale) {
    return { started: false, skipped: true, reason: 'PLAUD sync/repull already running' };
  }
  let stubs = findStubTranscriptNotes();
  const totalStubs = stubs.length;
  if (limit && stubs.length > limit) stubs = stubs.slice(0, limit);
  if (!stubs.length) return { started: true, totalStubs, scanned: 0, recovered: 0, stillEmpty: 0, failed: 0, results: [] };

  writeRunningState(true);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(getVaultPath(), ...PLAUD_BACKUP_REL, `stub-refetch-${stamp}`);
  let recovered = 0, stillEmpty = 0, failed = 0;
  const results = [];
  try {
    const { client, transport } = await createClient();
    try {
      for (const s of stubs) {
        try {
          const body = await fetchTranscriptBody(client, s.plaud_id);
          if (!body) { stillEmpty += 1; results.push({ rel: s.rel, status: 'still-empty' }); }
          else {
            const bk = path.join(backupDir, s.rel);
            fs.mkdirSync(path.dirname(bk), { recursive: true });
            fs.copyFileSync(s.path, bk);
            const idx = s.content.indexOf('## Transcript');
            const head = idx >= 0 ? s.content.slice(0, idx) : s.content.replace(/\n*$/, '') + '\n\n';
            fs.writeFileSync(s.path, `${head}## Transcript\n\n${body.trim()}\n`, 'utf-8');
            try { require('./vault-hooks').onVaultWrite(s.path, 'plaud-stub-refetch'); } catch {}
            recovered += 1; results.push({ rel: s.rel, status: 'recovered', chars: body.length });
          }
        } catch (error) {
          failed += 1; results.push({ rel: s.rel, status: 'failed', error: error.message });
        }
        if (DEFAULT_BETWEEN_RECORDINGS_MS > 0) await sleep(DEFAULT_BETWEEN_RECORDINGS_MS);
      }
    } finally {
      await transport.close();
    }
    return { started: true, totalStubs, scanned: stubs.length, recovered, stillEmpty, failed, backupDir: path.relative(getVaultPath(), backupDir).replace(/\\/g, '/'), results };
  } finally {
    writeRunningState(false);
  }
}

module.exports = {
  getStatus,
  syncPlaudRecordings,
  reconcilePlaudRecordings,
  repullPlaudRecordings,
  repullStubTranscripts,
  renderNote,
  renderTranscript,
  extractTranscriptSegments,
  assessSpeakerNaming,
  decideSpeakerHold,
  htmlUnescape,
  // exported for tests / reuse
  _internal: {
    titleTokens,
    jaccard,
    recordingDateStr,
    buildActiveNoteIndex,
    parseLeadingJson,
    assertUsableDetails,
    incrementalDateFrom,
    buildNoteBaseName,
    isRetryableError,
  },
};
