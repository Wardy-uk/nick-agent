const db = require('../db/database');
const obsidian = require('./obsidian');
const webpush = require('./webpush');
const todoIntelligence = require('./todo-intelligence');

// SSE clients listening for nudges
const clients = new Set();

// Every nudge type that can be raised, snoozed and reported in snooze state.
const NUDGE_TYPES = ['standup', 'todo', 'eod', '121', 'plan_milestone', 'journal', 'escalation', 'email'];

const SNOOZE_DEFAULT_MINUTES = 30;
const SNOOZE_MAX_MINUTES = 24 * 60; // enough for "rest of day" from any hour

function snoozeNudge(type, minutes = SNOOZE_DEFAULT_MINUTES) {
  const requested = Number(minutes);
  const mins = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.round(requested), SNOOZE_MAX_MINUTES)
    : SNOOZE_DEFAULT_MINUTES;
  const until = Date.now() + mins * 60 * 1000;
  db.setState(`snooze_${type}`, String(until));
  try { require('./activity').trackNudgeSnooze(type); } catch {}
  console.log(`[Nudge] ${type} snoozed for ${mins}m, until ${new Date(until).toLocaleTimeString()}`);
  broadcast({ type: 'nudge_snoozed', nudge_type: type, until, minutes: mins });
  return { until, minutes: mins };
}

function isSnoozed(type) {
  const val = db.getState(`snooze_${type}`);
  if (!val) return false;
  return Date.now() < parseInt(val, 10);
}

function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of clients) {
    client.write(data);
  }
}

function todayKey() {
  return new Date().toISOString().split('T')[0];
}

function isPastStandupCutoff(now = new Date()) {
  return now.getHours() >= 12;
}

// ── Days Nick is not working ─────────────────────────────────────────────────
//
// Two separate reasons a ritual nudge must not fire, and they are kept apart
// because they are answerable by different things and Nick can only control one.
//
//   BANK HOLIDAY — the crons are already `* * 1-5`, so weekends were handled,
//     but nothing in the nudge path had ever heard of a bank holiday. This is
//     the sixth place in the repo where "working day" quietly meant Mon-Fri
//     (see the working-days note in CLAUDE.md), and it was days from proving
//     it: Monday 31 Aug 2026 is the Summer bank holiday, and without this the
//     standup, todo and EOD nudges would all have fired on a day off.
//
//   ANNUAL LEAVE — Nick's own declaration, because nothing else can know. Graph
//     OOF events exist and `working-days.leaveDates()` reads them, but they
//     depend on him having blocked it out in Outlook AND on Graph answering;
//     a button that works with the Pi offline and needs no calendar is the one
//     he will actually press when he is already on holiday.
//
// ⚠ THE LINE THIS DRAWS: nudges go quiet, alarms still ring. Everything in
// NUDGE_TYPES is a nudge about Nick's working rhythm — including the escalation
// and email BANNERS — and none of it should chase him on a day off. The
// separate `escalation_alert` / `system_alert` pushes (briefing.js, watchdog)
// are in webpush's ALWAYS_DELIVER and are deliberately NOT touched: those are
// "something is on fire", and going quiet on those is a bigger decision than a
// leave button should be allowed to make on its own.

const LEAVE_KEY = 'nudges_leave_until';
const MAX_LEAVE_DAYS = 60;

/**
 * Read leave state. PURE — takes the stored value and `now`, resolves no clock
 * and no DB, so the boundary behaviour pins without either.
 *
 * `until` is an INCLUSIVE date string. Storing a date rather than a timestamp
 * is deliberate: "back on Monday" is a fact about a day, and a millisecond
 * deadline set at 16:00 on the Friday would silently end leave mid-afternoon on
 * the last day of it.
 */
function leaveState(raw, now = new Date()) {
  if (!raw) return { onLeave: false, until: null, daysRemaining: 0 };
  const until = String(raw).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) return { onLeave: false, until: null, daysRemaining: 0 };

  // Local date, never toISOString() — the Pi may run UTC and that would end
  // leave an hour early on the last evening.
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  if (today > until) return { onLeave: false, until, daysRemaining: 0, expired: true };

  const msPerDay = 86400000;
  const daysRemaining = Math.max(0, Math.round(
    (new Date(`${until}T00:00:00`) - new Date(`${today}T00:00:00`)) / msPerDay
  )) + 1;
  return { onLeave: true, until, daysRemaining };
}

/** Leave state from the store. */
function getLeave(now = new Date()) {
  return leaveState(db.getState(LEAVE_KEY), now);
}

/**
 * "I'm on annual leave." `days` counts TODAY as the first day, so the common
 * case — pressing it on the morning of a day off — is `days: 1`.
 */
function setLeave(days = 1, now = new Date()) {
  const n = Math.min(MAX_LEAVE_DAYS, Math.max(1, Math.round(Number(days) || 1)));
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (n - 1));
  const until = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
  db.setState(LEAVE_KEY, until);

  // Clear what is already on screen. Setting leave while a standup banner is up
  // and leaving it there would make the button look broken at the exact moment
  // it is being trusted.
  let cleared = 0;
  try {
    for (const nudge of db.getActiveNudges()) { db.completeNudge(nudge.id); cleared += 1; }
  } catch (e) {
    console.warn('[Nudge] Could not clear active nudges on leave:', e.message);
  }
  broadcast({ type: 'nudge_cleared', nudge_type: 'all' });
  broadcast({ type: 'leave_set', until, days: n });
  console.log(`[Nudge] Annual leave until ${until} (${n} day(s)) — ${cleared} nudge(s) cleared`);
  return { ok: true, until, days: n, cleared };
}

/** Back early. The way out is not optional — plans change. */
function clearLeave() {
  db.setState(LEAVE_KEY, '');
  broadcast({ type: 'leave_cleared' });
  console.log('[Nudge] Annual leave cleared — nudges resume');
  return { ok: true };
}

/**
 * Should ritual nudges be suppressed right now, and WHY?
 *
 * Returns a reason rather than a bare boolean so the log and the banner can say
 * which of the two it was — "you're on leave" and "it's a bank holiday" are
 * different facts and a silent suppression is indistinguishable from a broken
 * nudge.
 */
function nudgeSuppression(now = new Date()) {
  const leave = getLeave(now);
  if (leave.onLeave) {
    return { suppressed: true, reason: 'annual leave', until: leave.until, daysRemaining: leave.daysRemaining };
  }
  try {
    const shared = require('../../shared/working-days.cjs');
    const workingDays = require('./working-days');
    if (!shared.isWorkingDay(now, workingDays.holidaySet())) {
      const why = shared.nonWorkingReason
        ? shared.nonWorkingReason(now, workingDays.holidaySet())
        : 'not a working day';
      return { suppressed: true, reason: why || 'not a working day' };
    }
  } catch (e) {
    // Fail OPEN here, and only here. Being unable to read the holiday list is
    // not a reason to stop nudging for ever — the cost of a wrong nudge on a
    // bank holiday is an annoyance, the cost of silently never nudging again is
    // the whole feature. The opposite call to booking a meeting on Christmas.
    console.warn('[Nudge] Could not check working day, assuming it is one:', e.message);
  }
  return { suppressed: false, reason: null };
}

// Nudge messages escalate with nag count
const STANDUP_MESSAGES = [
  // Opening — light, time-neutral. Nags 1-2.
  [
    "Standup time. Don't make this weird.",
    "Right then. Standup. You know what to do.",
    "The queue isn't going to narrate itself. Standup tab. Go.",
    "It's that time. Three bullet points. Yesterday, today, blockers. Off you go.",
    "Standup o'clock. The ritual awaits. Don't overthink it.",
    "You have a standup to write. This is not a drill.",
    "Standup time. It takes less time than reading this notification.",
    "The standup awaits. Three questions. You've done this before.",
    "The day has begun. The standup has not. One of these is a problem.",
    "Standup. It's literally three questions. You answer them every day. Today is a day.",
  ],
  // Wry — noticing, not scolding. Nags 3-4.
  [
    "Still no standup. Bold choice. The Standup tab remains available.",
    "Interesting. No standup yet. Very interesting. Extremely interesting.",
    "The standup is not going to write itself. I've checked. Multiple times.",
    "You've had 15 minutes. In that time you could have written the standup approximately 5 times.",
    "Just popping by to mention the standup. Again. As I do.",
    "Standup update: still not done. Thank you for attending my TED talk.",
    "I notice the standup remains in a Schrödinger state — neither done nor officially abandoned.",
    "Visibility is phase 1 of your 90-day plan. The standup is the visibility.",
    "The standup is just sitting there. Waiting. It's very patient. I am less so.",
    "Quick check-in: standup status? (The answer is: not done. I already know. I'm asking rhetorically.)",
    "Still here. Still nudging. The standup is still three questions.",
    "No standup yet. That's fine. Everything is fine. (Do the standup.)",
  ],
  // Fond — warm and personal. Nag 5+, because by then the problem is not that he forgot.
  [
    "I know your brain. I know this pattern. I'm not judging — well, a little. Three bullets. That's all.",
    "Look. It's been a day. I get it. But the standup will make you feel better. It always does.",
    "The standup is just a mirror. Yesterday, today, blockers. You know this. You're good at this.",
    "You built me to know when you're avoiding things. You are avoiding the standup. I am knowing it loudly.",
    "The 90-day clock is ticking. Visibility is phase 1. You're good at this. Show that you're good at this.",
    "Other people have AI assistants that are polite about this. You chose me. I take that as permission to persist.",
    "You have 13 direct reports, a growing queue, and a 90-day plan to deliver. Standup is how you hold all of it.",
    "Open the tab and answer the first question. That's the whole ask. The other two follow on their own.",
    "End of day is coming. Future Nick will be annoyed at Past Nick for skipping this. Don't do that to him.",
    "The standup is a small thing that makes everything else smaller. Three minutes. Then everything gets clearer.",
  ],
];

const TODO_MESSAGES = [
  // Opening — light. Nags 1-2.
  [
    "You've got overdue todos. Just so you know. No pressure. (Pressure.)",
    "Overdue todos spotted. Pick one. Any one. The smallest one if that helps.",
    "The todo list has some items that have... matured. Worth a look.",
    "Quick heads up: todos are overdue. You know what to do.",
    "Todos awaiting your attention. They're very patient. Unlike me.",
    "The todo list grows not younger. Just saying.",
    "Some todos have been sitting there long enough to develop opinions. Address them.",
    "Overdue todos detected. This is not a drill. Well, it's a soft drill. A friendly drill.",
    "Your past self made promises to your future self. Your future self is now. Time to honour them.",
    "Todos outstanding. This is your reminder. You may now proceed to do something about it.",
  ],
  // Wry — noticing, not scolding. Nags 3-4.
  [
    "Those todos aren't going to complete themselves. Shockingly.",
    "Still here. Still watching the todos age. Pick one.",
    "The todo list has been waiting longer than your last Jira ticket.",
    "Fun fact: crossing off a todo releases dopamine. You could have had that dopamine 15 minutes ago.",
    "The todo is just sitting there. Judging you softly. With tiny todo eyes.",
    "At what point does 'overdue' become 'legendary'? You're approaching it.",
    "I checked: the todos are still there. I will continue checking. Every 15 minutes.",
    "Your todo list is a snapshot of your commitments. Currently it's looking quite... committed.",
    "Pick the smallest todo. Do it. Feel the relief. Repeat. This is the system.",
    "The todos have formed a support group. They meet to discuss their abandonment. You're the topic.",
    "Just one. Pick one todo. The rest can wait. But one cannot. That one is calling to you.",
  ],
  // Fond — warm and practical. Nag 5+, because by then it isn't forgetfulness.
  //
  // This tier used to be absurdist, which put the comedy routine at exactly the
  // point the standup pool had already worked out was wrong: five nags in, the
  // problem is friction, and a joke about sentient todos doesn't reduce any. The
  // gradient now matches — light, wry, then warm and specific about the next
  // action. The best of the absurd lines survive one tier up, where they belong.
  [
    "Five nudges in. So it's not that you forgot. What's actually in the way?",
    "Pick the smallest one. Do only that. You can stop after it — you won't, but you can.",
    "I've started naming the todos. Gerald has been waiting the longest. Gerald deserves better.",
    "This isn't a discipline problem. It's an activation problem. Open one todo. That's the whole job.",
    "You don't have to clear the list. You have to move one thing. Those are very different asks.",
    "If the todo is too vague to start, that's the actual blocker. Rewrite it as a first step instead.",
    "The list isn't the problem — the first ten minutes are. Give me those and I'll leave you alone.",
    "Whatever's at the top: is it real, or does it need dropping? Either answer gets it off the list.",
    "Something here is bigger than it looks, or duller than it sounds. Which one?",
    "You've done harder things than this today. Start with one and I'll stop counting.",
  ],
];

// Seeded pseudo-random number generator (Mulberry32)
function seededRandom(seed) {
  let t = seed + 0x6D2B79F5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Get day-of-year for daily seeding
function getDayOfYear() {
  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 0);
  return Math.floor((now - start) / (1000 * 60 * 60 * 24));
}

// Shuffle message indices using seed — deterministic but different each day
function getShuffledOrder(arrayLength, seed) {
  const indices = Array.from({ length: arrayLength }, (_, i) => i);
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(seededRandom(seed * 1000 + i) * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices;
}

/**
 * Pick a nag message for this nag count.
 *
 * The pools are tiered and the tier is chosen by nag count, so escalation is
 * real. It used to shuffle the ENTIRE flat pool and index by nag count, which
 * meant the tier comments in the source were decorative — the first nudge of the
 * day could just as easily be "I'm not angry, I'm just disappointed" as the
 * breezy opener. Those tiers are gone now, and the gradient is deliberately
 * inverted: light, then wry, then WARM. Nick's failure mode is avoidance, and
 * shame feeds avoidance — so the longer something goes undone, the kinder this
 * gets, because by nag five the problem is not that he forgot.
 *
 * Shuffling still happens WITHIN a tier, seeded by day, so repeats are rare
 * without the tone jumping around.
 */
function getNagMessage(type, nagCount) {
  const tiers = type === 'standup' ? STANDUP_MESSAGES : TODO_MESSAGES;
  const n = Math.max(0, nagCount || 0);
  const tierIndex = n <= 1 ? 0 : n <= 3 ? 1 : 2;
  const messages = tiers[Math.min(tierIndex, tiers.length - 1)];
  if (!messages || !messages.length) return 'Standup?';

  // Seed with day-of-year + type + tier so each day and tier shuffles
  // differently, and standup vs todo pick different messages on the same day.
  const daySeed = getDayOfYear() * 100 + (type === 'standup' ? 1 : 2) + tierIndex * 7;
  const shuffledOrder = getShuffledOrder(messages.length, daySeed);
  return messages[shuffledOrder[n % messages.length]];
}

// Check if standup/daily ritual has been done today
// The ritual may happen in Obsidian directly — check if today's note exists and has real content
function isStandupDone() {
  const dailyNote = obsidian.readTodayDailyNote();
  if (!dailyNote) return false;

  // Check for a populated Focus Today section (has actual task items, not just the heading)
  if (dailyNote.includes('## Focus Today')) {
    const lines = dailyNote.split('\n');
    let inFocus = false;
    for (const line of lines) {
      if (line.startsWith('## Focus Today')) { inFocus = true; continue; }
      if (line.startsWith('## ') && inFocus) break;
      // Require actual text after the checkbox — not just an empty item
      const match = line.match(/^\s*-\s+\[.\]\s+(.+)$/);
      if (inFocus && match && match[1].trim().length > 2) return true;
    }
  }

  // Also accept explicit ## Standup section (added by the app)
  if (dailyNote.includes('## Standup')) return true;

  return false;
}

// Check if there are overdue/pending todos (from vault)
function hasPendingTodos() {
  try {
    const { active } = obsidian.parseVaultTodos();
    const todayLane = todoIntelligence.buildTodayLane(active);
    return todayLane.length > 0;
  } catch (e) {
    return false;
  }
}

function getFollowThroughTodo() {
  try {
    const { active } = obsidian.parseVaultTodos();
    return todoIntelligence.buildFollowThroughCandidate(active);
  } catch {
    return null;
  }
}

// Called by cron — creates the initial nudge at 9am
// Now context-aware: checks if user is active, in a meeting, or standup already started
function triggerStandupNudge() {
  const away = nudgeSuppression();
  if (away.suppressed) { console.log(`[Nudge] standup skipped — ${away.reason}`); return; }

  const dateKey = todayKey();
  const existing = db.getActiveNudgeByTypeAndDate('standup', dateKey);

  if (existing) {
    return; // Already nudging
  }

  if (isStandupDone()) {
    return; // Already done today
  }

  if (isPastStandupCutoff()) {
    return; // Past midday — no standup reminders for the rest of the day
  }

  // Context-aware checks — defer if conditions aren't right
  try {
    const todayActivity = db.getActivityForDate(dateKey);

    // Check if user already opened the standup tab today
    const openedStandup = todayActivity.some(a => {
      if (a.event_type !== 'tab_open') return false;
      try {
        const data = typeof a.event_data === 'string' ? JSON.parse(a.event_data) : a.event_data;
        return data && (data.tab === 'standup' || data.tab === 'dashboard');
      } catch { return false; }
    });

    if (openedStandup) {
      console.log('[Nudge] Standup nudge deferred — user already opened standup/dashboard tab');
      // Defer: they're already engaging. Check again at next nag cycle.
      return;
    }

    // Check if user is currently in a meeting (calendar event happening now)
    try {
      const now = new Date();
      const todayStr = dateKey;
      const tomorrowStr = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
      const events = db.getCalendarEvents(todayStr, tomorrowStr);
      const inMeeting = events.some(e => {
        if (e.is_all_day) return false;
        const start = new Date(e.start_time);
        const end = new Date(e.end_time);
        return now >= start && now <= end;
      });

      if (inMeeting) {
        console.log('[Nudge] Standup nudge deferred — user is in a meeting');
        return;
      }
    } catch {}
  } catch (e) {
    // If context checks fail, proceed with the nudge anyway
    console.warn('[Nudge] Context check failed, proceeding with nudge:', e.message);
  }

  // Pick from tier 1 messages (first 10) — different each day
  const msg = getNagMessage('standup', 0);
  db.createNudge('standup', msg, dateKey);
  console.log('[Nudge] Standup nudge created for', dateKey);
  broadcast({ type: 'nudge', nudge_type: 'standup', message: msg, nag_count: 0 });
  webpush.sendToAll('SARA', msg, { type: 'standup', url: '/standup' }).catch(() => {});
}

function triggerTodoNudge() {
  const away = nudgeSuppression();
  if (away.suppressed) { console.log(`[Nudge] todo skipped — ${away.reason}`); return; }

  const dateKey = todayKey();
  const existing = db.getActiveNudgeByTypeAndDate('todo', dateKey);

  if (existing) return;
  if (!hasPendingTodos()) return;

  const followThrough = getFollowThroughTodo();
  const msg = followThrough?.message || getNagMessage('todo', 0);
  db.createNudge('todo', msg, dateKey);
  console.log('[Nudge] Todo nudge created for', dateKey);
  broadcast({ type: 'nudge', nudge_type: 'todo', message: msg, nag_count: 0 });
  webpush.sendToAll('SARA', msg, { type: 'todo', url: '/todos' }).catch(() => {});
}

// ── Escalations and urgent email ─────────────────────────────────────────────
// These two are the nudges Nick actually wants interrupting him, so they say what
// the thing IS rather than picking from the joke pool — and they re-state the
// current facts on every nag instead of getting staler with each repeat.

function getUnseenEscalations() {
  try { return require('./jira').getUnseenEscalations(); } catch { return []; }
}

function buildEscalationMessage(items) {
  if (!items || items.length === 0) return null;
  // Count first — one banner for the lot, not one per ticket. The oldest is
  // named only so opening Focus isn't a surprise.
  const [oldest] = items; // getUnseenEscalations() sorts oldest first
  const ageDays = oldest.created
    ? Math.floor((Date.now() - new Date(oldest.created).getTime()) / 86400000)
    : null;
  const age = ageDays == null ? '' : ageDays === 0 ? ', raised today' : `, ${ageDays}d old`;
  const n = items.length;
  return n === 1
    ? `1 escalation waiting on you — ${oldest.key}${age}.`
    : `${n} escalations waiting on you — oldest is ${oldest.key}${age}.`;
}

// Asked, never re-derived: `email-triage` owns what "urgent" means, the same
// way `action-presenter` owns what "leaves the building" means. This banner and
// the list Nick opens must be the same mail — they were not, and the count on
// the notification ran twelve days ahead of the panel (26 Aug 2026).
function getUrgentEmails() {
  try { return require('./email-triage').getUrgentEmails(); } catch { return []; }
}

function buildEmailMessage(items) {
  if (!items || items.length === 0) return null;
  const [first] = items;
  const from = first.from || first.fromEmail;
  const n = items.length;
  if (n === 1) {
    return from ? `1 urgent email needs a reply — from ${from}.` : '1 urgent email needs a reply.';
  }
  return from
    ? `${n} urgent emails need a reply — including one from ${from}.`
    : `${n} urgent emails need a reply.`;
}

/**
 * Raise, refresh or clear a fact-driven nudge. Unlike the standup/todo nudges
 * this can update an existing banner in place — a second escalation landing
 * shouldn't be silent just because one is already showing.
 */
function syncFactNudge(type, message, pushTitle, url) {
  const dateKey = todayKey();
  const existing = db.getActiveNudgeByTypeAndDate(type, dateKey);

  if (!message) {
    if (existing) {
      db.completeNudge(existing.id);
      broadcast({ type: 'nudge_cleared', nudge_type: type });
      console.log(`[Nudge] ${type} nudge cleared — nothing outstanding`);
    }
    return;
  }

  if (isSnoozed(type)) return;

  if (existing) {
    if (existing.message === message) return; // nothing new to say — don't re-notify
    db.updateNudgeMessage(existing.id, message);
  } else {
    db.createNudge(type, message, dateKey);
  }

  const nagCount = existing ? (existing.nag_count || 0) : 0;
  console.log(`[Nudge] ${type} nudge ${existing ? 'updated' : 'created'}: ${message}`);
  broadcast({ type: 'nudge', nudge_type: type, message, nag_count: nagCount });
  webpush.sendToAll(pushTitle, message, { type, url }).catch(() => {});
}

function triggerEscalationNudge() {
  syncFactNudge('escalation', buildEscalationMessage(getUnseenEscalations()), 'SARA — Escalation', '/focus');
}

function triggerUrgentEmailNudge() {
  syncFactNudge('email', buildEmailMessage(getUrgentEmails()), 'SARA — Urgent email', '/inbox');
}

// Called every 15 min — escalates existing nudges
/**
 * Retire yesterday's banners. Split out of nagCheck and scheduled EVERY day,
 * because nagCheck is scheduled every 15 min, 9am-5pm, WEEKDAYS ONLY. `syncFactNudge`
 * keys on (type, dateKey), so Saturday's banner survived the date rollover and
 * Sunday minted a SECOND row for the same fact: one urgent email showed as two
 * outstanding items. Nothing cleared it until Monday 09:00 or the next backend
 * restart, and only the restarts hid how long it had been true.
 *
 * "Stop nagging" is a weekday concern. "Yesterday is over" is not.
 */
function clearStaleNudges() {
  let cleared = 0;
  for (const nudge of db.getActiveNudges()) {
    if (nudge.date_key && nudge.date_key < todayKey()) {
      db.completeNudge(nudge.id);
      console.log(`[Nudge] Cleared stale ${nudge.type} nudge from ${nudge.date_key}`);
      broadcast({ type: 'nudge_cleared', nudge_type: nudge.type });
      cleared++;
    }
  }
  return cleared;
}

function nagCheck() {
  const away = nudgeSuppression();
  if (away.suppressed) { console.log(`[Nudge] nag cycle skipped — ${away.reason}`); return; }

  clearStaleNudges();
  const nudges = db.getActiveNudges();

  for (const nudge of nudges) {

    // Check if standup was completed since last check
    if (nudge.type === 'standup' && isStandupDone()) {
      db.completeNudge(nudge.id);
      broadcast({ type: 'nudge_cleared', nudge_type: 'standup' });
      console.log('[Nudge] Standup completed — nudge cleared');
      continue;
    }

    if (nudge.type === 'standup' && isPastStandupCutoff()) {
      db.completeNudge(nudge.id);
      broadcast({ type: 'nudge_cleared', nudge_type: 'standup' });
      console.log('[Nudge] Midday passed without standup — reminders dismissed for the rest of the day');
      continue;
    }

    // Check if all overdue todos are done
    if (nudge.type === 'todo' && !hasPendingTodos()) {
      db.completeNudge(nudge.id);
      broadcast({ type: 'nudge_cleared', nudge_type: 'todo' });
      console.log('[Nudge] No overdue todos — nudge cleared');
      continue;
    }

    // Escalations answered / urgent email dealt with — stop nagging
    if (nudge.type === 'escalation' && getUnseenEscalations().length === 0) {
      db.completeNudge(nudge.id);
      broadcast({ type: 'nudge_cleared', nudge_type: 'escalation' });
      console.log('[Nudge] No unseen escalations — nudge cleared');
      continue;
    }

    if (nudge.type === 'email' && getUrgentEmails().length === 0) {
      db.completeNudge(nudge.id);
      broadcast({ type: 'nudge_cleared', nudge_type: 'email' });
      console.log('[Nudge] No urgent email outstanding — nudge cleared');
      continue;
    }

    // Skip escalation if snoozed
    if (isSnoozed(nudge.type)) {
      continue;
    }

    // Skip escalation if user is currently in a meeting
    try {
      const now = new Date();
      const todayStr = todayKey();
      const tomorrowStr = new Date(now.getTime() + 86400000).toISOString().split('T')[0];
      const events = db.getCalendarEvents(todayStr, tomorrowStr);
      const inMeeting = events.some(e => {
        if (e.is_all_day) return false;
        const start = new Date(e.start_time);
        const end = new Date(e.end_time);
        return now >= start && now <= end;
      });
      if (inMeeting) {
        console.log(`[Nudge] Nag deferred for ${nudge.type} — user is in a meeting`);
        continue;
      }
    } catch {}

    // Escalate
    const newCount = (nudge.nag_count || 0) + 1;
    db.incrementNagCount(nudge.id);
    const followThrough = nudge.type === 'todo' ? getFollowThroughTodo() : null;
    // Fact-driven types re-state the current position rather than escalating in tone
    const factMessage = nudge.type === 'escalation' ? buildEscalationMessage(getUnseenEscalations())
      : nudge.type === 'email' ? buildEmailMessage(getUrgentEmails())
      : null;
    const msg = factMessage || followThrough?.message || getNagMessage(nudge.type, newCount);
    // Persist it — the row is what a page load renders, so broadcasting alone
    // leaves the banner showing the message this nudge was first created with.
    if (msg !== nudge.message) db.updateNudgeMessage(nudge.id, msg);
    console.log(`[Nudge] Nag #${newCount} for ${nudge.type}: ${msg}`);
    broadcast({ type: 'nudge', nudge_type: nudge.type, message: msg, nag_count: newCount });
    const url = nudge.type === 'standup' ? '/standup'
      : nudge.type === 'escalation' ? '/focus'
      : nudge.type === 'email' ? '/inbox'
      : '/todos';
    webpush.sendToAll('SARA', msg, { type: nudge.type, url }).catch(() => {});
  }
}

// Called on startup — clears stale nudges from previous days, then fires if needed
function startupCheck() {
  const staleNudges = db.getActiveNudges().filter(n => n.date_key && n.date_key < todayKey());
  if (staleNudges.length > 0) {
    console.log(`[Nudge] Startup — clearing ${staleNudges.length} stale nudge(s) from previous days`);
    for (const n of staleNudges) {
      db.completeNudge(n.id);
    }
    broadcast({ type: 'nudge_cleared', nudge_type: 'all' });
  }

  const now = new Date();
  const day = now.getDay(); // 0=Sun, 6=Sat
  const hour = now.getHours();

  // Working hours only. The `day >= 1 && day <= 5` that used to live here was
  // the seventh hand-rolled Mon-Fri in the repo; the triggers themselves now
  // gate on `nudgeSuppression()`, which also knows about bank holidays and
  // annual leave, so the hour window is all that is left to check here.
  if (hour >= 9 && hour < 17) {
    const away = nudgeSuppression(now);
    if (away.suppressed) {
      console.log(`[Nudge] Startup check — not nudging: ${away.reason}`);
      return;
    }
    console.log('[Nudge] Startup check — working hours on a working day, triggering nudges');
    if (!isPastStandupCutoff(now)) triggerStandupNudge();
    triggerTodoNudge();
  }
}

// Mark standup as done (called when user saves standup to daily note)
function markStandupDone() {
  db.completeAllNudgesByType('standup');
  broadcast({ type: 'nudge_cleared', nudge_type: 'standup' });
  try {
    const hour = new Date().getHours();
    require('./activity').trackStandupDone(hour);
  } catch {}
}

// Fire a nudge at 75% of plan duration reminding Nick to plan the next plan
// Only fires once per plan — tracked in agent_state
function checkPlanMilestoneNudge() {
  const away = nudgeSuppression();
  if (away.suppressed) { console.log(`[Nudge] plan milestone skipped — ${away.reason}`); return; }

  try {
    const startDate = new Date(process.env.PLAN_START_DATE || '2026-03-16');
    const planDays = parseInt(process.env.PLAN_DURATION_DAYS || '90', 10);
    const milestoneDay = Math.floor(planDays * 0.75); // 75% mark

    // Calculate current working day (simplified — calendar days for this check)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const calendarDaysElapsed = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

    // Only fire between 75% and 85% of plan duration
    if (calendarDaysElapsed < milestoneDay || calendarDaysElapsed > Math.floor(planDays * 0.85)) return;

    // Check if already sent this plan cycle
    const stateKey = `plan_milestone_sent_${startDate.toISOString().split('T')[0]}`;
    const alreadySent = db.getState(stateKey);
    if (alreadySent) return;

    // Mark as sent
    db.setState(stateKey, new Date().toISOString());

    const daysRemaining = planDays - calendarDaysElapsed;
    const msg = `You're ${Math.round(calendarDaysElapsed / planDays * 100)}% through your ${planDays}-day plan — ${daysRemaining} days left. Time to start thinking about what comes next. What did you set out to achieve? What's landed? What needs a new plan?`;

    console.log('[Nudge] Plan milestone nudge firing');
    broadcast({ type: 'nudge', nudge_type: 'plan_milestone', message: msg, nag_count: 0 });
    webpush.sendToAll(
      `SARA`,
      msg,
      { type: 'plan_milestone', url: '/plan' }
    ).catch(() => {});
  } catch (e) {
    console.error('[Nudge] Plan milestone check failed:', e.message);
  }
}

function getSnoozeState() {
  const state = {};
  for (const type of NUDGE_TYPES) {
    const val = db.getState(`snooze_${type}`);
    state[type] = val && Date.now() < parseInt(val, 10) ? parseInt(val, 10) : null;
  }
  return state;
}

// Check for upcoming/overdue 1-2-1s and nudge once per day
function check121Nudges() {
  const away = nudgeSuppression();
  if (away.suppressed) { console.log(`[Nudge] 1-2-1 skipped — ${away.reason}`); return; }

  try {
    const upcoming = obsidian.getUpcoming121s(2);
    if (upcoming.length === 0) return;
    const dateKey = todayKey();
    const stateKey = `121_nudge_${dateKey}`;
    if (db.getState(stateKey)) return;
    // Anything already in the diary never reaches here — getUpcoming121s drops
    // `booked`. What's left needs one of three different things, and asking for
    // the wrong one is the bug this replaced: a 1-2-1 that has already happened
    // was being reported as "needs booking now".
    const overdue = upcoming.filter(u => u.state === 'overdue');
    const unwritten = upcoming.filter(u => u.state === 'unwritten');
    const soon = upcoming.filter(u => u.state === 'due-soon');
    let msg = '';
    if (overdue.length > 0) {
      const names = overdue.map(u => `${u.name} (was ${u.dueDate})`).join(', ');
      msg = `Overdue 1-2-1${overdue.length > 1 ? 's' : ''}: ${names}. These need booking now.`;
    } else if (unwritten.length > 0) {
      const names = unwritten.map(u => `${u.name} (${u.bookedDate})`).join(', ');
      msg = `1-2-1 with ${names} ${unwritten.length === 1 ? 'has' : 'have'} been and gone with no note. Write ${unwritten.length === 1 ? 'it' : 'them'} up — or if ${unwritten.length === 1 ? 'it was' : 'they were'} cancelled, rebook.`;
    } else {
      const names = soon.map(u => `${u.name} (due ${u.dueDate})`).join(', ');
      msg = `1-2-1 reminder: ${names} ${soon.length === 1 ? 'is' : 'are'} due within 2 days. Get them in the diary.`;
    }
    db.setState(stateKey, new Date().toISOString());
    console.log('[Nudge] 1-2-1 nudge:', msg);
    broadcast({ type: 'nudge', nudge_type: '121', message: msg, nag_count: 0 });
    webpush.sendToAll('SARA', msg, { type: '121', url: '/people' }).catch(() => {});
  } catch (e) {
    console.error('[Nudge] 1-2-1 check failed:', e.message);
  }
}

// EOD ritual nudge — fires at 5pm weekdays
function triggerEodNudge() {
  const away = nudgeSuppression();
  if (away.suppressed) { console.log(`[Nudge] EOD skipped — ${away.reason}`); return; }

  const dailyNote = obsidian.readTodayDailyNote();
  if (dailyNote && (dailyNote.includes('## EOD') ||
      (dailyNote.includes('## Wins Today') && !dailyNote.match(/## Wins Today\s*\n-\s*\n/)))) return;
  const dateKey = todayKey();
  const stateKey = `eod_nudge_${dateKey}`;
  if (db.getState(stateKey)) return;
  db.setState(stateKey, new Date().toISOString());
  // The EOD nudge already asks for "one win" — and NEURO now knows them, so it
  // leads with the day rather than only the ask. Deliberately riding THIS
  // notification instead of adding a wins push of its own: nudge volume is the
  // one signal allowed to argue against building more, and a second daily
  // interruption to say "well done" is how the first one stops being read.
  //
  // Only when there is something to state. `headline()` returns null on an
  // empty day and the original wording stands — there is no encouraging version
  // of zero, and a quiet day is exactly where an invented win reads as false.
  let opener = '';
  try {
    const wins = require('./wins');
    wins.sync();
    const line = wins.headline(wins.summary());
    if (line) opener = `${line}. `;
  } catch (e) {
    // A ledger failure must never cost Nick the EOD prompt itself.
    console.warn('[Nudge] Wins headline unavailable:', e.message);
  }

  const msg = `${opener}End of day. Before you close the laptop: one win, one thing that didn't go to plan, how you're feeling. 2 minutes. Standup tab → EOD.`;
  broadcast({ type: 'nudge', nudge_type: 'eod', message: msg, nag_count: 0 });
  webpush.sendToAll('SARA', msg, { type: 'eod', url: '/standup' }).catch(() => {});
}

function markEodDone() {
  broadcast({ type: 'nudge_cleared', nudge_type: 'eod' });
  try { require('./activity').trackEodDone(); } catch {}
}

// Journal nudge — fires at configured time (default 21:00)
function triggerJournalNudge() {
  const away = nudgeSuppression();
  if (away.suppressed) { console.log(`[Nudge] journal skipped — ${away.reason}`); return; }

  // Skip if journal already done today
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
  const path = require('path');
  const fs = require('fs');
  const todayStr = todayKey();
  const journalPath = path.join(vaultPath, 'Reflections', `${todayStr}-journal.md`);
  if (fs.existsSync(journalPath)) return;

  const dateKey = todayKey();
  const stateKey = `journal_nudge_${dateKey}`;
  if (db.getState(stateKey)) return;

  db.setState(stateKey, new Date().toISOString());

  const hour = new Date().getHours();
  const msgs = [
    "Evening. Your journal is waiting. Three questions, five minutes, then you're done.",
    "Time to close the loop on today. Journal tab — it takes less time than you think.",
    "Before the day fully escapes: what happened, what mattered, how are you. Journal tab.",
    "End of day reflection time. The good stuff fades fast — capture it while it's fresh.",
    "Five minutes of reflection now saves hours of wondering later. Journal tab.",
  ];
  const msg = msgs[Math.floor(Math.random() * msgs.length)];

  console.log('[Nudge] Journal nudge triggered');
  broadcast({ type: 'nudge', nudge_type: 'journal', message: msg, nag_count: 0 });
  webpush.sendToAll('SARA', msg, { type: 'journal', url: '/journal' }).catch(() => {});
}

function markJournalDone() {
  broadcast({ type: 'nudge_cleared', nudge_type: 'journal' });
}

module.exports = {
  addClient,
  broadcast,
  NUDGE_TYPES,
  // Exported for tests — the tone ladder is a design decision worth pinning.
  getNagMessage,
  // Exported so a test can prove this banner and the Inbox panel describe the
  // same mail. They did not, for twelve days (26 Aug 2026).
  getUrgentEmails,
  buildEmailMessage,
  triggerStandupNudge,
  triggerTodoNudge,
  triggerEscalationNudge,
  triggerUrgentEmailNudge,
  nagCheck,
  clearStaleNudges,
  markStandupDone,
  startupCheck,
  snoozeNudge,
  checkPlanMilestoneNudge,
  getSnoozeState,
  check121Nudges,
  triggerEodNudge,
  markEodDone,
  triggerJournalNudge,
  markJournalDone,
  isStandupDone,
  // Leave + working-day suppression. `leaveState` is pure and is the half worth
  // pinning; the rest read or write the store.
  leaveState,
  getLeave,
  setLeave,
  clearLeave,
  nudgeSuppression,
};
