'use strict';

/**
 * Wins — the derived ledger of finished work.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Measured on the live DB before a line was written. Over thirty days NEURO
 * recorded FOUR completions. In the same window: 271 commits, 57 executed SARA
 * actions, a full diary, 2,229 vault writes. The `Momentum` card on the Today
 * tab — `doneToday`, `streakDays`, the seven-day sparkline, "Done today" — was
 * opened NINE times and showed 0, no streak, and "Nothing logged yet" on every
 * one of them.
 *
 * The reward surface was not missing. It was starved, and it was starved for
 * one reason: the only thing feeding it was self-report. A tickbox. And a
 * tickbox is precisely the thing that stops happening on the days it matters.
 *
 * So a win is DETECTED, not declared — the rule the rest of the system already
 * follows everywhere else. Who reports to Nick is READ, not typed. 1-2-1s are
 * detected, not declared. The 1-2-1 tracker is generated. This ledger was the
 * last hand-typed thing in NEURO, and it was the one where hand-typing hurt
 * most, because the cost of the gap was not a wrong number on a report — it
 * was NEURO telling Nick he had finished four things in a month he shipped 271
 * commits in.
 *
 * ── The three refusals ──────────────────────────────────────────────────────
 *
 * 1. A FAILED SOURCE IS A GAP, NEVER A ZERO. `collect()` returns `gaps`, and a
 *    source that could not be read is named. This is weekly-risk's rule and it
 *    is load-bearing here specifically: the bug being fixed IS a wins count
 *    that read zero while the work was happening. A feed that silently reads 0
 *    when git is unreachable reproduces it exactly.
 *
 * 2. NO POINTS, NO SCORE. A count of finished things, each with evidence. A
 *    weighted score is a claim that a commit and a 1-2-1 are commensurable,
 *    which is false, and it is gameable by the one person it is meant to
 *    serve. The number has exactly one job: to be TRUE.
 *
 * 3. EVERY ROW NAMES ITS EVIDENCE. A commit sha, a sara_action id, an
 *    activity_log id. A win without evidence is an assertion, and an assertion
 *    is what the tickbox already was. `manual` is the single source allowed a
 *    null, because "I had a hard conversation" has no artefact and excluding
 *    it would be its own kind of dishonesty.
 *
 * ── Deliberately NOT sourced ────────────────────────────────────────────────
 *
 * MEETINGS. `calendar_cache` carries no attendees column (the same absence
 * people-gap works around by falling back to organizer), so nothing here can
 * tell a real meeting from one of the focus blocks that fill half the diary.
 * plaud-admin-blocks solved that with `attendeesOther()` against the signed-in
 * address, and that filter cannot reach this table. Counting every past
 * calendar entry as a win would inflate the number with time Nick blocked out
 * to work alone — and an inflated wins feed is worse than no feed at all,
 * because it destroys the only property the number has.
 *
 * VAULT WRITES. 2,229 in thirty days, overwhelmingly Syncthing and the import
 * pipeline rather than Nick. There is no signal in the row that separates the
 * two.
 *
 * Both are gaps by decision, not oversight, and `KNOWN_GAPS` says so out loud.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const db = require('../db/database');

// ── Sources ──────────────────────────────────────────────────────────────────

/**
 * Events in activity_log that represent FINISHED work.
 *
 * Deliberately not captures, chat messages or tab opens — adhd-dashboard's
 * `_momentum` already made that call and it was the right one: capturing a
 * thought is valuable but it is not progress, and counting it would let a day
 * of pure input read as a productive one. This list is that set, plus the
 * completions that have landed since it was written.
 */
const DONE_EVENTS = new Map([
  ['task_done', 'task'],
  ['plan_task_done', '90-day plan'],
  ['standup_done', 'ritual'],
  ['eod_done', 'ritual'],
  ['one_two_one_done', '1-2-1'],
  ['escalation_resolved', 'escalation'],
  ['focus_session_done', 'focus session'],
]);

/**
 * Executed SARA actions worth counting, with how each reads back.
 *
 * `capture_todo` is excluded on purpose: approving one CREATES a task, it does
 * not finish anything, and it is bulk-generated nightly in the hundreds. It
 * would be the single loudest source in the ledger while representing no
 * completed work whatsoever — the same reasoning that puts it last in the
 * Actions queue ordering.
 */
const ACTION_LABELS = new Map([
  ['reply_email', 'Replied to'],
  ['complete_task', 'Finished'],
  ['schedule_focus_block', 'Booked focus time for'],
  ['chase_commitment', 'Chased'],
  ['draft_reply', 'Drafted a reply to'],
]);

const KNOWN_GAPS = Object.freeze([
  'meetings — calendar_cache has no attendees column, so a meeting and a solo focus block are indistinguishable here',
  'vault writes — 2,229 in 30 days, overwhelmingly Syncthing and the import pipeline rather than Nick',
]);

// ── Time ─────────────────────────────────────────────────────────────────────

/** Local date key. Never toISOString() — the Pi may run UTC. */
function dateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/**
 * Parse a timestamp out of the DB.
 *
 * SQLite's CURRENT_TIMESTAMP writes 'YYYY-MM-DD HH:MM:SS' in **UTC** with no
 * marker, so a bare string of that shape is read as UTC and converted. Anything
 * carrying its own offset (sent_replies writes toISOString()) is left alone.
 * Getting this wrong shifts a win an hour either side of midnight into the
 * wrong day, which is how a streak breaks for no reason a human can see.
 */
function parseDbTime(value) {
  if (!value) return null;
  const s = String(value).trim();
  const bare = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/;
  const d = new Date(bare.test(s) ? `${s.replace(' ', 'T')}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ── git ──────────────────────────────────────────────────────────────────────

function gitRepos() {
  const configured = (process.env.WINS_GIT_REPOS || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
  return configured.length ? configured : [path.resolve(__dirname, '..', '..')];
}

/**
 * Commits, folded to ONE ROW PER REPO PER DAY carrying the count.
 *
 * Not one row per commit, and this is the whole judgement in the source. At
 * ~9 commits a day git would be 90% of the ledger, and the feed would stop
 * being a record of Nick's day and become a git mirror — with the admin work,
 * the half that actually needs the reward, buried underneath it again. Same
 * species as one long transcript filling every search result until
 * semanticSearch folded to the best chunk per file.
 *
 * No author filter by default. Filtering on a name that has drifted returns
 * zero rows and no error, which is the exact silent-zero this module exists to
 * stop; set WINS_GIT_AUTHOR only if a repo genuinely has other committers.
 */
function foldCommits(commits) {
  const byRepoDay = new Map();
  for (const c of commits) {
    const key = `${c.repo} ${c.dateKey}`;
    const entry = byRepoDay.get(key) || { repo: c.repo, dateKey: c.dateKey, count: 0, latest: c.at, subjects: [] };
    entry.count++;
    if (c.at > entry.latest) entry.latest = c.at;
    if (entry.subjects.length < 3) entry.subjects.push(c.subject);
    byRepoDay.set(key, entry);
  }

  return [...byRepoDay.values()].map(e => ({
    dateKey: e.dateKey,
    occurredAt: e.latest,
    source: 'git',
    kind: 'commit',
    text: `${e.count} commit${e.count === 1 ? '' : 's'} to ${e.repo} — ${e.subjects[0]}`,
    evidence: `${e.repo}@${e.dateKey}`,
    count: e.count,
    dedupeKey: `git:${e.repo}:${e.dateKey}`,
  }));
}

function readCommits(since) {
  const commits = [];
  const failed = [];

  for (const repo of gitRepos()) {
    const name = path.basename(repo);
    try {
      const args = ['-C', repo, 'log', `--since=${since}`, '--pretty=format:%H %aI %s'];
      if (process.env.WINS_GIT_AUTHOR) args.push(`--author=${process.env.WINS_GIT_AUTHOR}`);
      const out = execFileSync('git', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });

      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const sp1 = line.indexOf(' ');
        const sp2 = line.indexOf(' ', sp1 + 1);
        if (sp1 < 0 || sp2 < 0) continue;
        const sha = line.slice(0, sp1);
        const iso = line.slice(sp1 + 1, sp2);
        const subject = line.slice(sp2 + 1);
        const at = new Date(iso);
        if (Number.isNaN(at.getTime())) continue;
        commits.push({ repo: name, sha, at, dateKey: dateKey(at), subject: subject || '' });
      }
    } catch (e) {
      // Not a repo, git missing, or a checkout mid-pull. Named, never counted
      // as zero — a day with no commits and a day we could not ask are
      // different facts, and only one of them is about Nick.
      failed.push(`${name}: ${e.message.split('\n')[0]}`);
    }
  }

  return { commits, failed };
}

// ── Collection ───────────────────────────────────────────────────────────────

/**
 * Read every source over [since, until] and return candidate win rows.
 *
 * Pure-ish: it reads, it does not write. `gaps` names each source that could
 * not be read, so a caller can say "23 wins, git unavailable" rather than
 * quietly reporting a smaller number as if it were the whole truth.
 */
function collect({ since, until } = {}) {
  const from = since || dateKey(addDays(new Date(), -30));
  const to = until || dateKey();
  const rows = [];
  const gaps = [];

  // 1. activity_log — completions, rituals, focus sessions.
  //
  // Sorted by id, not left in query order. getActivityForRange orders by
  // created_at, which has only second precision, and several wins routinely
  // land inside the same second — SQLite then returns the tie in no guaranteed
  // order. The wins rows are inserted in this order and the feed breaks its own
  // ties on wins.id, so an unstable read here would shuffle "what you did
  // today" on the one axis the list is supposed to be sorted by. The original
  // _winsToday had already learned this and said so.
  try {
    const activityRows = [...db.getActivityForRange(from, to)].sort((a, b) => a.id - b.id);
    for (const row of activityRows) {
      const label = DONE_EVENTS.get(row.event_type);
      if (!label) continue;
      let data = {};
      try { data = row.event_data ? JSON.parse(row.event_data) : {}; } catch { data = {}; }

      let text;
      switch (row.event_type) {
        case 'task_done': text = data.text || 'Task completed'; break;
        case 'plan_task_done': text = `90-day plan: ${data.text || data.taskText || 'task'}`; break;
        case 'standup_done': text = 'Standup done'; break;
        case 'eod_done': text = 'End of day done'; break;
        case 'one_two_one_done': text = `1-2-1 with ${data.person || data.personName || 'a report'}`; break;
        case 'escalation_resolved': text = `Escalation resolved: ${data.key || data.ticketKey || ''}`.trim(); break;
        case 'focus_session_done': text = `Focus session: ${data.text || 'finished'}`; break;
        default: text = label;
      }

      const at = parseDbTime(row.created_at) || new Date(`${row.date_key}T12:00:00`);
      const key = row.date_key || dateKey(at);

      // A ritual is at most ONE win per day, keyed on the day rather than the
      // activity row. `standup_done` is logged from four separate call sites
      // (routes/standup.js three times, nudges.js, standup-session.js) and a
      // single standup routinely writes more than one row — the live ledger
      // showed "Standup done" twice on its first afternoon. Counting each is
      // how the number stops being true, which is the only property it has.
      const isRitual = row.event_type === 'standup_done' || row.event_type === 'eod_done';
      const dedupeKey = isRitual ? `ritual:${row.event_type}:${key}` : `activity:${row.id}`;

      rows.push({
        // row.date_key is the DAY OF RECORD and wins follows it, rather than
        // re-deriving the day from created_at. Two reasons: it is the key every
        // other consumer of activity_log already uses (nudges, daily_summary),
        // and it is the only field a caller can backdate — created_at is always
        // "now", so deriving would silently collapse any backdated event onto
        // the day it was written.
        //
        // Known edge, stated rather than papered over: logActivity stamps
        // date_key with toISOString(), i.e. the UTC date, so under BST work
        // done between midnight and 1am local is keyed to the previous day.
        // That is activity_log's convention system-wide, and one ledger
        // agreeing with it beats a second convention that disagrees.
        dateKey: key,
        occurredAt: at,
        source: isRitual ? 'ritual' : 'activity',
        kind: row.event_type,
        text,
        evidence: `activity:${row.id}`,
        count: 1,
        dedupeKey,
      });
    }
  } catch (e) {
    gaps.push(`activity log unreadable — ${e.message}`);
  }

  // 2. sara_actions that actually executed. Real outbound work, and currently
  //    invisible to every count in the system.
  try {
    const actions = db.all(
      `SELECT id, type, payload, resolved_at FROM sara_actions
        WHERE status = 'executed' AND resolved_at IS NOT NULL
          AND date(resolved_at) BETWEEN ? AND ?`,
      [from, to]
    );
    for (const a of actions) {
      const label = ACTION_LABELS.get(a.type);
      if (!label) continue;
      let payload = {};
      try { payload = a.payload ? JSON.parse(a.payload) : {}; } catch { payload = {}; }
      const subject = payload.subject || payload.text || payload.person || payload.to?.name || payload.to?.email || '';
      const at = parseDbTime(a.resolved_at);
      if (!at) continue;
      rows.push({
        dateKey: dateKey(at),
        occurredAt: at,
        source: 'action',
        kind: a.type,
        text: `${label}${subject ? ` ${subject}` : ''}`.trim(),
        evidence: `action:${a.id}`,
        count: 1,
        dedupeKey: `action:${a.id}`,
      });
    }
  } catch (e) {
    gaps.push(`SARA actions unreadable — ${e.message}`);
  }

  // 3. Sent replies. Already recorded since #69, never once counted.
  try {
    const replies = db.all(
      `SELECT id, subject, from_name, sent_at FROM sent_replies
        WHERE date(sent_at) BETWEEN ? AND ?`,
      [from, to]
    );
    for (const r of replies) {
      const at = parseDbTime(r.sent_at);
      if (!at) continue;
      rows.push({
        dateKey: dateKey(at),
        occurredAt: at,
        source: 'reply',
        kind: 'sent_reply',
        text: `Replied to ${r.from_name || 'an email'}${r.subject ? ` — ${r.subject}` : ''}`,
        evidence: `reply:${r.id}`,
        count: 1,
        dedupeKey: `reply:${r.id}`,
      });
    }
  } catch (e) {
    gaps.push(`sent replies unreadable — ${e.message}`);
  }

  // 4. Decisions logged (#28 made the parser fire again).
  try {
    const decisions = db.all(
      `SELECT id, decision_text, created_at FROM decisions
        WHERE date(created_at) BETWEEN ? AND ?`,
      [from, to]
    );
    for (const d of decisions) {
      const at = parseDbTime(d.created_at);
      if (!at) continue;
      rows.push({
        dateKey: dateKey(at),
        occurredAt: at,
        source: 'decision',
        kind: 'decision',
        text: `Decision: ${d.decision_text}`,
        evidence: `decision:${d.id}`,
        count: 1,
        dedupeKey: `decision:${d.id}`,
      });
    }
  } catch (e) {
    gaps.push(`decisions unreadable — ${e.message}`);
  }

  // 5. 1-2-1s actually held. Sourced from one-to-one-detect rather than the
  //    `one_two_one_done` event, because that tracker has no callers anywhere
  //    in the codebase — while the detector reads them off the meeting notes
  //    and has attribution rules that have already been argued out.
  //
  //    ⚠ The first cut called `getRecent()` with NO ARGUMENTS. Its signature is
  //    `getRecent(name, limit)` and it returns `index.byPerson[name]`, so it was
  //    reading `byPerson[undefined]` and returning [] on every run — this source
  //    produced ZERO wins from the day it was written and reported that as "no
  //    1-2-1s happened" rather than "we never asked". Exactly the failure this
  //    whole module exists to remove, reintroduced inside it.
  //
  //    The shape-tolerant reading around it (`recent?.recent || recent?.items`)
  //    was the smell: code written to accept any shape cannot notice it got the
  //    wrong one. It now uses the real API, `getIndex()`, and reads the index
  //    it actually returns.
  try {
    const index = require('./one-to-one-detect').getIndex();
    if (!index || index.ok === false) {
      // scan() returns ok:false with a reason when the vault or Meetings/ is
      // missing, or the roster is empty. That is not "no 1-2-1s were held".
      gaps.push(`1-2-1s not counted — ${index?.error || 'no index available'}`);
    } else {
      for (const [who, items] of Object.entries(index.byPerson || {})) {
        for (const item of items || []) {
          const when = item?.date;
          if (!when || when < from || when > to) continue;
          rows.push({
            dateKey: when,
            occurredAt: new Date(`${when}T12:00:00`),
            source: 'one-to-one',
            kind: '1-2-1',
            text: `1-2-1 with ${who}`,
            evidence: item?.path ? `note:${item.path}` : `1-2-1:${who}:${when}`,
            count: 1,
            dedupeKey: `1-2-1:${who}:${when}`,
          });
        }
      }
    }
  } catch (e) {
    gaps.push(`1-2-1 detection unavailable — ${e.message}`);
  }

  // 6. Commits.
  const { commits, failed } = readCommits(from);
  for (const row of foldCommits(commits.filter(c => c.dateKey >= from && c.dateKey <= to))) rows.push(row);
  for (const f of failed) gaps.push(`git unreadable — ${f}`);

  return { rows, gaps, from, to };
}

// ── Meetings held ────────────────────────────────────────────────────────────

/**
 * Meetings Nick actually sat in, recorded from the events calendar-sync already
 * holds.
 *
 * This is the biggest single category of finished work in his week and the
 * ledger's first cut counted NONE of it, on a reason that was wrong: I wrote
 * that `attendeesOther()` "cannot reach" the data because `calendar_cache` has
 * no attendees column. plaud-admin-blocks does not read that table — it is
 * handed the freshly fetched Graph events by `calendar-sync`, and those carry
 * attendees, isOrganizer and responseStatus. So the filter was already running
 * against exactly the data needed, weekly, and had been measured on 96 real
 * events: 25 meetings, 23 solo focus blocks correctly rejected.
 *
 * A push rather than a pull for the same reason plaud-admin-blocks is: this is
 * the one place a fresh calendar exists, and `collect()` staying free of
 * network I/O is what keeps a sync fast and offline-safe.
 *
 * The filters are IMPORTED, never re-implemented — half Nick's diary is time
 * blocked out to work alone, and a second copy of "is this a real meeting"
 * would drift from the one he has already corrected.
 *
 * Everything unknowable fails CLOSED, exactly as it does there: no signed-in
 * address means nothing qualifies, and an unanswered invite is not a yes.
 */
function recordMeetingsHeld(events, { me, now = new Date() } = {}) {
  if (!Array.isArray(events) || !events.length) return { added: 0, considered: 0 };
  if (!me) return { added: 0, considered: 0, skipped: 'identity-unknown' };

  const { attendeesOther, createdOrAccepted } = require('./plaud-admin-blocks')._internals;
  let added = 0;
  let considered = 0;

  for (const ev of events) {
    try {
      if (!ev || ev.isCancelled) continue;
      if (ev.isAllDay) continue;
      // Time Nick marked free is not a meeting he attended.
      if (String(ev.showAs || '').toLowerCase() === 'free') continue;
      // A meeting that has not FINISHED is not a win yet — the whole ledger is
      // finished work, and a diary is a plan until it has happened.
      const end = ev.end ? new Date(ev.end) : null;
      if (!end || Number.isNaN(end.getTime()) || end > now) continue;
      if (!createdOrAccepted(ev)) continue;
      const others = attendeesOther(ev, me);
      if (others.length === 0) continue;

      considered++;
      const subject = String(ev.subject || 'Meeting').trim();
      const id = ev.id || `${ev.start}|${subject}`;
      const res = db.run(
        `INSERT OR IGNORE INTO wins
           (date_key, occurred_at, source, kind, text, evidence, count, dedupe_key, created_at)
         VALUES (?, ?, 'meeting', 'meeting_held', ?, ?, 1, ?, ?)`,
        [
          dateKey(end),
          end.toISOString(),
          `Meeting: ${subject}${others.length > 1 ? ` (${others.length + 1} people)` : ''}`.slice(0, 500),
          `event:${id}`,
          `meeting:${id}`,
          new Date().toISOString(),
        ]
      );
      if (res && res.changes) added++;
    } catch { /* one malformed event must not cost the rest of the run */ }
  }

  return { added, considered };
}

// ── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Fold collected rows into the table. Idempotent by dedupe_key.
 *
 * Runs hourly, on startup and over a backfill range, so a second sighting must
 * cost nothing. If this were not idempotent the count would climb on its own,
 * which is the one failure that would make the whole feature worthless — a
 * number Nick cannot trust is worse than no number, and he would work that out
 * within a week.
 */
function sync({ since, until } = {}) {
  const { rows, gaps, from, to } = collect({ since, until });
  let added = 0;

  db.batchSaves(() => {
    for (const r of rows) {
      const res = db.run(
        `INSERT OR IGNORE INTO wins
           (date_key, occurred_at, source, kind, text, evidence, count, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          r.dateKey,
          r.occurredAt.toISOString(),
          r.source,
          r.kind,
          String(r.text).slice(0, 500),
          r.evidence || null,
          r.count || 1,
          r.dedupeKey,
          new Date().toISOString(),
        ]
      );
      if (res && res.changes) added++;
    }

    // A folded git row grows during the day as commits land, so its count is
    // updated in place. Without this the day freezes at whatever the first
    // sync saw, and INSERT OR IGNORE alone would never correct it.
    for (const r of rows.filter(x => x.source === 'git')) {
      db.run(
        `UPDATE wins SET count = ?, text = ?, occurred_at = ?
          WHERE dedupe_key = ? AND count <> ?`,
        [r.count, String(r.text).slice(0, 500), r.occurredAt.toISOString(), r.dedupeKey, r.count]
      );
    }
  });

  return { added, considered: rows.length, gaps, from, to };
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Consecutive days back from today with at least one win.
 *
 * Kept identical to the rule adhd-dashboard already used so the two cannot
 * drift: weekends do not break a work streak, and today being still empty is a
 * day in progress rather than a broken streak — so the count starts at
 * yesterday when today has nothing yet.
 *
 * Pure: takes a Set of date keys and an anchor, touches no DB and no clock.
 */
function streakFrom(daysWithWins, anchor = new Date()) {
  const has = daysWithWins instanceof Set ? daysWithWins : new Set(daysWithWins);
  let streak = 0;
  for (let i = has.has(dateKey(anchor)) ? 0 : 1; i < 365; i++) {
    const d = addDays(anchor, -i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue;
    if (!has.has(dateKey(d))) break;
    streak++;
  }
  return streak;
}

/**
 * The counters. Today, this week, all time, streak, seven-day shape.
 *
 * `total` is the one that only ever goes up, and that is the point of it: every
 * other growing number in NEURO is a debt — 159 open tasks, 287 waiting-on,
 * a pending actions queue. This is the first counter where growth is good news.
 */
function summary(anchor = new Date()) {
  const today = dateKey(anchor);
  const weekAgo = dateKey(addDays(anchor, -6));

  const days = db.all(
    'SELECT date_key, COUNT(*) n FROM wins WHERE date_key >= ? GROUP BY date_key',
    [dateKey(addDays(anchor, -400))]
  );
  const byDay = new Map(days.map(d => [d.date_key, d.n]));

  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const key = dateKey(addDays(anchor, -i));
    last7.push({ date: key, done: byDay.get(key) || 0 });
  }

  const total = db.get('SELECT COUNT(*) n FROM wins')?.n || 0;
  const week = db.get('SELECT COUNT(*) n FROM wins WHERE date_key BETWEEN ? AND ?', [weekAgo, today])?.n || 0;
  const bySource = db.all(
    'SELECT source, COUNT(*) n FROM wins WHERE date_key BETWEEN ? AND ? GROUP BY source ORDER BY n DESC',
    [weekAgo, today]
  );

  return {
    dateKey: today,
    doneToday: byDay.get(today) || 0,
    doneThisWeek: week,
    total,
    streakDays: streakFrom(new Set(byDay.keys()), anchor),
    last7,
    best7: last7.reduce((m, d) => Math.max(m, d.done), 0),
    bySource: bySource.map(r => ({ source: r.source, count: r.n })),
    knownGaps: KNOWN_GAPS,
  };
}

/** Local HH:MM from a stored UTC ISO timestamp. */
function _hhmm(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** The scrollable log. Newest first, paginated — this is the `git log` half. */
function feed({ limit = 50, offset = 0, source = null, dateKey: onDate = null } = {}) {
  const lim = Number.isInteger(limit) && limit > 0 && limit <= 200 ? limit : 50;
  const off = Number.isInteger(offset) && offset >= 0 ? offset : 0;

  const where = [];
  const params = [];
  if (source) { where.push('source = ?'); params.push(source); }
  if (onDate) { where.push('date_key = ?'); params.push(onDate); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.get(`SELECT COUNT(*) n FROM wins ${clause}`, params)?.n || 0;
  const rows = db.all(
    `SELECT * FROM wins ${clause} ORDER BY occurred_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, lim, off]
  );

  return {
    wins: rows.map(r => ({
      id: r.id,
      dateKey: r.date_key,
      occurredAt: r.occurred_at,
      // Formatted here rather than by each caller. occurred_at is stored as UTC
      // ISO, so slicing HH:MM out of the string shows BST times an hour early —
      // the bug every calendar time in NEURO had before Prefer: outlook.timezone.
      // The first cut left this to adhd-dashboard, so /api/wins served
      // `time: undefined` to everything that was not the Today tab.
      time: _hhmm(r.occurred_at),
      source: r.source,
      kind: r.kind,
      text: r.text,
      evidence: r.evidence,
      count: r.count,
    })),
    total,
    hasMore: off + rows.length < total,
  };
}

/**
 * One line stating what today came to. Pure — takes a summary, no DB, no clock.
 *
 * Exists so the tick acknowledgement, the EOD nudge and any later surface all
 * say the same thing in the same words; three places phrasing it themselves is
 * how cadenceState, working-days and action-presenter each ended up needing one
 * definition after the fact.
 *
 * Returns null on a day with nothing in it. There is no encouraging version of
 * zero — SARA states the fact or says nothing, and a cheerful line over an empty
 * count is exactly the register the voice spec rejects. A quiet day is also the
 * one where an invented win would be most obviously false.
 */
function headline(summary) {
  const done = summary?.doneToday || 0;
  if (!done) return null;
  const streak = summary?.streakDays || 0;
  const core = `${done} finished today`;
  return streak > 1 ? `${core} · ${streak}-day streak` : core;
}

/** Today's wins, newest first — what the Today tab reads. */
function winsForDate(key = dateKey()) {
  return feed({ dateKey: key, limit: 200 }).wins;
}

/**
 * A win with no other home. Kept from the old /api/adhd/win: a hard
 * conversation had, an hour of real focus, something survived. It is the one
 * source allowed no evidence, and it is stamped `manual` so the feed never
 * pretends it was detected.
 */
function logManual(text, at = new Date()) {
  const clean = String(text || '').trim();
  if (!clean) return null;
  const key = `manual:${at.toISOString()}:${clean.slice(0, 80)}`;
  db.run(
    `INSERT OR IGNORE INTO wins
       (date_key, occurred_at, source, kind, text, evidence, count, dedupe_key, created_at)
     VALUES (?, ?, 'manual', 'manual', ?, NULL, 1, ?, ?)`,
    [dateKey(at), at.toISOString(), clean.slice(0, 500), key, new Date().toISOString()]
  );
  return true;
}

module.exports = {
  sync,
  collect,
  recordMeetingsHeld,
  summary,
  headline,
  feed,
  winsForDate,
  logManual,
  KNOWN_GAPS,
  // exported for tests — pure, no DB, no clock
  foldCommits,
  streakFrom,
  dateKey,
  parseDbTime,
};
