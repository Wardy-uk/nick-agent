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
      : { syncedRecordings: {}, failedRecordings: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
  } catch {
    return { syncedRecordings: {}, failedRecordings: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
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

function incrementalDateFrom(lastSuccessfulSyncAt, incremental, lookbackDays = DEFAULT_SYNC_LOOKBACK_DAYS) {
  if (!incremental || !lastSuccessfulSyncAt) return undefined;

  const last = new Date(lastSuccessfulSyncAt);
  if (Number.isNaN(last.getTime())) return undefined;

  const days = Number.isFinite(lookbackDays) && lookbackDays > 0 ? Math.floor(lookbackDays) : 0;
  last.setUTCDate(last.getUTCDate() - days);
  return last.toISOString().slice(0, 10);
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

// get_transcript returns a `transaction` item whose data_content is a JSON string
// of segments. Pull those out, ignoring any non-transaction items.
function extractTranscriptSegments(payload) {
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

  return [];
}

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

function renderTranscriptNote(recording, summaryRelativePath, transcriptBody) {
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
    '---',
    '',
    `# ${recording.name || recording.id}`,
    '',
    `Summary: [[${summaryRelativePath.replace(/\.md$/i, '')}]]`,
    '',
    '## Transcript',
    ''
  ];

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
      const dateFrom = incrementalDateFrom(syncState.lastSuccessfulSyncAt, incremental);

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
          const transcriptBody = await fetchTranscriptBody(client, recording.id);

          // Not ready: PLAUD has produced neither transcript nor summary yet (a premature
          // pull mid-processing). Skip WITHOUT writing a stub or marking it synced, so the
          // next sync cycle re-pulls it once PLAUD has finished — no orphan stub is created.
          if (!summaryBody.trim() && !transcriptBody.trim()) {
            skipped += 1;
            console.log(`[PlaudSync] ${recording.id} not ready (no transcript/summary yet) — retry next cycle`);
            continue;
          }

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
            renderTranscriptNote(details, summaryRelativePath, transcriptBody)
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
          syncState.failedRecordings[recording.id] = {
            failedAt: new Date().toISOString(),
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
  let syncState = { syncedRecordings: {}, failedRecordings: {}, lastSuccessfulSyncAt: null, lastRunAt: null };
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
    failedCount
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
  const transcriptBody = await fetchTranscriptBody(client, recording.id);

  const baseName = buildNoteBaseName(details);
  const summaryRelativePath = `${normalizeVaultPath(getSummaryFolder())}/${baseName}.md`;
  const transcriptRelativePath = `${normalizeVaultPath(getTranscriptFolder())}/${baseName}.md`;

  const summaryWrite = writeFile(summaryRelativePath, renderSummaryNote(details, preferredSummary, summaryBody, transcriptRelativePath));
  const transcriptWrite = writeFile(transcriptRelativePath, renderTranscriptNote(details, summaryRelativePath, transcriptBody));

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
async function fetchTranscriptBody(client, id, { emptyRetries = 3, emptyDelayMs = 2500 } = {}) {
  for (let attempt = 0; attempt <= emptyRetries; attempt += 1) {
    const payload = await withRetry(`get_transcript ${id}`, () => callTool(client, 'get_transcript', { file_id: id }));
    const body = renderTranscript(extractTranscriptSegments(payload));
    if (body && body.trim()) return body;
    if (attempt < emptyRetries) await sleep(emptyDelayMs * (attempt + 1));
  }
  return '';
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
