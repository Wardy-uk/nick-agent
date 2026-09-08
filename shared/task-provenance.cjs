'use strict';

/**
 * How a task got here, and when — in words Nick can act on.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * A task card said what the task WAS and never how it arrived. Live example
 * (#251, 7 Sep 2026): "Review what happened and explain where the process broke
 * down" — MUST, high priority, due today, and Nick's own reaction was "I've no
 * idea what it is". Everything needed to answer that was already in the row
 * (`source`, `origin_path`, `created_at`) and no surface rendered any of it.
 *
 * A task you cannot trace is one you can only do two things with: work it
 * blindly, or delete it. Both are wrong when the thing was a real commitment.
 *
 * ── Rules ────────────────────────────────────────────────────────────────────
 *
 * 1. **PURE.** No DB, no vault, no network, no clock — `now` is passed. It runs
 *    per row on a list render and pins without a database. `.cjs` in `shared/`
 *    because BOTH frontends render task cards, and two copies of this
 *    vocabulary is how the desktop and the phone come to name one task's origin
 *    two different ways (the `shared/task-domain.cjs` rule).
 *
 * 2. **AN OPAQUE ID IS NEVER A LABEL.** `email:AAMkAGI1MjNl…` identifies the
 *    email to Microsoft Graph and to nobody else. Where the sender was not
 *    recorded this says so — "An email — sender not recorded" is a fact he can
 *    act on; 150 characters of base64 is not. The raw value still travels as
 *    `ref` for matching a row back to its source, but it is never the label.
 *    Same rule, same words, as `candidate-provenance` — which now shares these
 *    primitives rather than keeping a second copy.
 *
 * 3. **AN UNKNOWN SOURCE IS NAMED AS ITSELF, NEVER GUESSED.** A writer this
 *    module has not been taught renders as `Recorded as "<source>"`, which is
 *    true and greppable. Inventing a friendly sentence for an unrecognised
 *    value is how a card comes to assert a provenance nothing recorded.
 *
 * 4. **ONLY `manual` MAY SAY A PERSON TYPED IT.** `unattributed` is the
 *    positive gap value `createTask` stores when a writer forgot to name
 *    itself; it must read as a gap, because the whole reason that value exists
 *    is that `'manual'` used to be a claim rather than a fact.
 *
 * 5. **A MISSING DATE IS "not recorded", NEVER TODAY.** `created_at` has a
 *    default, so absence means something odd happened; rendering it as now
 *    would make the newest-looking task on the screen the one we know least
 *    about.
 */

/** Trim to something, or null. Never the empty string, which renders as a gap. */
function str(v) {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
  return s || null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A date as a person reads it, plus how long ago.
 *
 * ⚠ Parsed off the STRING, never through `new Date()` on a bare `YYYY-MM-DD` —
 * that is read as UTC midnight and renders as the previous day west of here,
 * which is the calendar bug this repo has now had twice. The age is computed
 * from the date parts against the same parts of `now`, so nothing crosses a
 * timezone.
 */
function describeDate(value, now) {
  const raw = str(value);
  if (!raw) return { iso: null, label: null, ageDays: null, known: false };

  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!m) return { iso: null, label: null, ageDays: null, known: false };

  const [, y, mo, d] = m;
  const monthIdx = Number(mo) - 1;
  if (monthIdx < 0 || monthIdx > 11) return { iso: null, label: null, ageDays: null, known: false };

  const iso = `${y}-${mo}-${d}`;
  const label = `${Number(d)} ${MONTHS[monthIdx]} ${y}`;

  let ageDays = null;
  if (now instanceof Date && !Number.isNaN(now.getTime())) {
    // Both sides at UTC noon: the difference is whole days regardless of DST.
    const then = Date.UTC(Number(y), monthIdx, Number(d), 12);
    const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), 12);
    ageDays = Math.round((today - then) / 86400000);
  }

  return { iso, label, ageDays, known: true };
}

/** "Added 7 Sep 2026" / "Added today" / "Added 3 days ago". */
function addedLabel(date) {
  if (!date.known) return 'Added — date not recorded';
  if (date.ageDays === 0) return 'Added today';
  if (date.ageDays === 1) return 'Added yesterday';
  if (date.ageDays != null && date.ageDays > 1 && date.ageDays <= 13) {
    return `Added ${date.ageDays} days ago`;
  }
  return `Added ${date.label}`;
}

/**
 * A vault path as a person would name it: the note, and the folder it is in.
 *
 * The full path is kept as `detail` — it is what you need in order to go and
 * open the thing — but the LABEL is the note name, because
 * `Meetings/2026/08/2026-08-25 – Hope 1-2-1.md` on a card is mostly year and
 * month.
 */
function describeNote(sourcePath, sourceLine) {
  const rel = String(sourcePath);
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const base = parts[parts.length - 1] || rel;
  const name = base.replace(/\.md$/i, '');
  const folder = parts.length > 1 ? parts[0] : null;
  return {
    kind: 'note',
    label: name,
    context: folder ? `${folder} note` : 'Vault note',
    detail: sourceLine ? `${rel}:${sourceLine}` : rel,
    ref: rel,
  };
}

/**
 * An email as a person would name it: who sent it, and what it was called.
 *
 * ⚠ Subject and sender are read from the recorded metadata, NEVER sliced out of
 * the source path — that field holds the Graph id and holds nothing else.
 */
function describeEmail(email, sourcePath) {
  const from = str(email && email.from) || str(email && email.fromEmail);
  const subject = str(email && email.subject);

  if (!from && !subject) {
    // Recorded honestly rather than falling back to the id. "Sender not
    // recorded" tells Nick the row cannot be checked from here; the id tells him
    // nothing at all and looks like a bug.
    return {
      kind: 'email',
      label: 'An email — sender not recorded',
      context: 'Email',
      detail: null,
      ref: str(sourcePath),
    };
  }

  return {
    kind: 'email',
    label: from ? `Email from ${from}` : 'Email',
    context: 'Email',
    // The subject is what he searches Outlook for, so it is the detail.
    detail: subject ? `${String.fromCharCode(8220)}${subject}${String.fromCharCode(8221)}` : null,
    ref: str(sourcePath),
  };
}

/**
 * What each writer means, in Nick's words rather than the column's.
 *
 * `how` completes the sentence "This task …". Every entry is a statement about
 * a route into the store that actually exists — see the `createTask` call sites
 * scanned by `task-attribution.test.js`. A source not in here is NOT guessed at
 * (rule 3).
 */
const SOURCE_HOW = {
  // The only value allowed to say a person typed it — see rule 4.
  manual: 'You typed it in',
  // The positive gap value. It must read as a gap.
  unattributed: 'Not recorded — whatever created this did not say who it was',

  'master-todo-import': 'Imported from your old Master Todo list',
  'meeting-promotion': 'Promoted from a meeting note',
  'email-promotion': 'Promoted from an email that asked you for something',
  'management-log': 'Mirrored from your management log',
  'nova-121': 'An action from a 1-2-1 in NOVA',
  'vantage-finding': 'Raised by VANTAGE from something it spotted on the service desk',
  'vantage-plan': 'From the VANTAGE improvement plan',
  vantage: 'Raised by VANTAGE',
  'jira-assigned': 'A Jira ticket assigned to you',
  chat: 'You asked SARA to add it in chat',
  'chat-marker': 'SARA picked it out of something you said in chat',
  'standup-session': 'Came out of a morning standup',
  'eod-session': 'Came out of an end-of-day session',
  capture: 'Captured on the Capture page',
  'sara-capture': 'Captured on the Capture page',
  'obsidian-capture': 'Dropped into Tasks/Capture.md in Obsidian',
  'neuro-mobile': 'Captured on your phone',
  watch: 'Captured from your Watch',
  mcp: 'Created by a Claude Code session through the MCP server',
  apple: 'Imported from Apple Reminders',
  'apple-reminders': 'Imported from Apple Reminders',
};

/**
 * Whether a source path is an email id rather than a vault path.
 *
 * The producer's own marker wins where there is one; the prefix is the fallback
 * for rows written before anything recorded the kind.
 */
function looksLikeEmail(task, sourcePath) {
  if (task && task.originKind === 'email') return true;
  return Boolean(sourcePath && sourcePath.indexOf('email:') === 0);
}

/**
 * How and when a task arrived.
 *
 * Takes the shape `task-store.toTodoShape` emits (camelCase) and tolerates a raw
 * DB row (snake_case), because the backfill script and the tests read rows
 * straight out of SQLite.
 *
 * Always returns an object — a card must be able to say "I don't know where this
 * came from", which is itself the most useful thing on a card like #251.
 */
function describeTaskProvenance(task = {}, { now = null } = {}) {
  const t = task || {};
  const source = str(t.taskSource != null ? t.taskSource : t.source);
  const sourcePath = str(t.originPath != null ? t.originPath : t.origin_path);
  const sourceLine = t.originLine != null ? t.originLine : (t.origin_line != null ? t.origin_line : null);
  const created = t.createdAt != null ? t.createdAt : t.created_at;
  const date = describeDate(created, now);

  // Detail recorded AT CREATION by the writer, for the sources whose detail
  // cannot be recovered from the path — an email's sender and subject, chiefly.
  // Stored rather than re-derived because the suggestion it was promoted from is
  // prunable and a Graph id resolves to nothing offline.
  const detailField = str(t.originDetail != null ? t.originDetail : t.origin_detail);
  let recorded = null;
  if (detailField) {
    try {
      recorded = JSON.parse(detailField);
    } catch (e) {
      // Not JSON — an older or hand-written value. Kept as a plain note rather
      // than discarded: it is still the only thing recorded about this row.
      recorded = { note: detailField };
    }
  }

  // ── Where it came from ─────────────────────────────────────────────────────
  let from = null;
  if (looksLikeEmail(t, sourcePath)) {
    from = describeEmail(recorded && recorded.email ? recorded.email : recorded, sourcePath);
  } else if (sourcePath) {
    from = describeNote(sourcePath, sourceLine);
  } else if (recorded && str(recorded.note)) {
    from = { kind: 'note', label: str(recorded.note), context: null, detail: null, ref: null };
  }

  // ── How it got here ────────────────────────────────────────────────────────
  // A `capture:<who>` source names the person who captured it on the household
  // page. Handled by prefix rather than listed, because the suffix is an account
  // label and the set of them is Nick's to change.
  let how = null;
  let known = false;
  if (source && source.indexOf('capture:') === 0) {
    const who = str(source.slice('capture:'.length));
    how = who ? `Captured by ${who} on the house page` : 'Captured on the house page';
    known = true;
  } else if (source && Object.prototype.hasOwnProperty.call(SOURCE_HOW, source)) {
    how = SOURCE_HOW[source];
    known = source !== 'unattributed';
  } else if (source) {
    // Rule 3 — named as itself, never invented.
    how = `Recorded as ${String.fromCharCode(8220)}${source}${String.fromCharCode(8221)}`;
    known = false;
  } else {
    how = 'No source recorded';
    known = false;
  }

  return {
    source,
    /** "Added 7 Sep 2026" / "Added today" / "Added — date not recorded". */
    added: addedLabel(date),
    addedDate: date.iso,
    addedAgeDays: date.ageDays,
    addedKnown: date.known,
    /** Completes "This task …". Always a string. */
    how,
    /** The note / email it came out of, or null when nothing was recorded. */
    from,
    /**
     * false when the source is missing, unattributed, or a value this module has
     * not been taught — i.e. when the card is telling Nick that NEURO cannot
     * answer the question, rather than answering it.
     */
    known,
  };
}

module.exports = {
  describeTaskProvenance,
  describeDate,
  describeNote,
  describeEmail,
  SOURCE_HOW,
};
