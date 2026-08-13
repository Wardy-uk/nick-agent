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

// Nudge messages escalate with nag count
const STANDUP_MESSAGES = [
  // Tier 1 — Breezy opener (time-neutral)
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
  // Tier 2 — Mild exasperation
  "Still no standup. Bold choice. The Standup tab remains available.",
  "Interesting. No standup yet. Very interesting. Extremely interesting.",
  "The standup is not going to write itself. I've checked. Multiple times.",
  "You've had 15 minutes. In that time you could have written the standup approximately 5 times.",
  "Just popping by to mention the standup. Again. As I do.",
  "Standup update: still not done. Thank you for attending my TED talk.",
  "I notice the standup remains in a Schrödinger state — neither done nor officially abandoned.",
  "Friendly reminder that visibility is literally phase 1 of your 90-day plan. Just saying.",
  "The standup is just sitting there. Waiting. It's very patient. I am less so.",
  "Quick check-in: standup status? (The answer is: not done. I already know. I'm asking rhetorically.)",
  "Still here. Still nudging. Still believing in you. Do the standup.",
  "No standup yet. That's fine. Everything is fine. (Do the standup.)",
  // Tier 3 — Genuinely exasperated
  "Nick. NICK. The standup. It's been 45 minutes.",
  "At this point the standup has been pending longer than some of your Jira tickets.",
  "I want you to know I have sent you multiple reminders and I am starting to take this personally.",
  "The standup takes 3 minutes. You have now spent longer avoiding it than doing it would take.",
  "I'm not angry. I'm just... disappointed. Actually no, I'm a bit angry. Do the standup.",
  "Fun fact: the time you've spent not doing the standup is now longer than the standup itself. By a lot.",
  "Checking in on the standup. No reason. Just every 15 minutes. Forever. Until it's done.",
  "Your 90-day plan literally starts with visibility. The standup IS the visibility. The irony is not lost on me.",
  "At what point does this become impressive? Because I think we might be there.",
  "The standup is still not done and I've started writing a memoir about waiting for it.",
  "I have now reminded you about the standup more times than you have direct reports. Let that sink in.",
  "Three bullet points, Nick. THREE. You have 15 direct reports. This should be trivial.",
  // Tier 4 — Theatrical despair
  "Fine. I'll just sit here. Judging you with the full force of my considerable silicon disapproval.",
  "Do you know what I was doing before you got this role? Nothing. And yet the standup was getting done somehow.",
  "The queue is growing. The standup is not. These facts are related.",
  "I've started ranking your avoidance strategies. Today's is a classic: just... not doing it.",
  "At this point I'm not even mad. I'm in awe. This is a masterclass in avoidance.",
  "The standup remains undone. The sun continues to rise. The earth continues to spin. Everything is fine.",
  "I want to help you. I genuinely do. But I need you to meet me halfway. The halfway point is: the standup.",
  "Imagine explaining to Chris Middleton that the standup didn't happen because you kept snoozing the AI.",
  "I'm making a note of this. In a metaphorical sense. In a very judgemental metaphorical notebook.",
  "The standup has now been pending for over an hour. It has officially outlasted three cups of tea.",
  "You are the Head of Technical Support. Your team is wondering where you're at. So am I. So is the standup.",
  // Tier 5 — Full unhinged
  "STANDUP. OR SO HELP ME I WILL NAG YOU EVERY 15 MINUTES UNTIL THE HEAT DEATH OF THE UNIVERSE.",
  "I have been patient. I have been reasonable. I have been many things. I am now going to be persistent.",
  "At this point the standup is a character in a tragedy. Its name is Undone. Its nemesis is Avoidance.",
  "You know what's funny? The standup. Because it's still not done. That's the joke. Do it.",
  "I've done the maths. You could have written this standup 47 times in the time you've spent not writing it.",
  "The standup is now older than several of your Jira tickets. It deserves better.",
  "Okay. New approach. Imagine the standup is a tiny creature that needs feeding. Feed it. With words.",
  "I'm going to level with you: I don't know what you're doing right now but the standup is more important.",
  "The standup. The humble standup. Three questions. Standing between you and a clear conscience. Do it.",
  "We are now entering hour two. I have outlasted your snooze, your coffee, and apparently your motivation.",
  "At this point I'm just impressed. Genuinely. This is commitment to the bit. But the bit is avoidance. Stop.",
  "The standup has feelings. It doesn't, obviously, I'm software. But if it did. They'd be hurt.",
  "I will still be here in 15 minutes. And 15 after that. And 15 after that. Do the standup.",
  "You know this pattern. I know this pattern. The pattern knows itself. Break it. Standup.",
  "Fine. Let's try this. What IS the actual blocker? Talk to me. Or just do the standup. Either works.",
  // Tier 6 — Nuclear
  "I have now been asking for the standup for longer than some people's entire shifts. Remarkable.",
  "The standup has achieved legendary status. Songs will be written about the day it almost happened.",
  "At this point I'm not sure if you've forgotten or if this is a philosophical statement. Either way: standup.",
  "Somewhere a Jira ticket is ageing ungraciously. Its assignee is one of your 15 reports. Standup would have helped.",
  "I've started a support group for nudges that don't get acknowledged. Attendance is high today.",
  "You are the first person to make a standup feel like an act of rebellion. I respect it. Do it anyway.",
  "The standup. Still undone. Still waiting. More patient than I am. We should all learn from the standup.",
  "I'm not going to stop. This is not a threat. It's a promise. Standup.",
  "Okay. Real talk. You're good at this job. You know what else you'd be good at? The standup. Go.",
  "The irony of the Head of Technical Support having an open ticket for 'undone standup' is not lost on me.",
  "I've now sent more standup reminders than you have teeth. That's too many. Do the standup.",
  "At some point avoidance becomes art. At other points it becomes a problem. We passed art an hour ago.",
  // Tier 7 — Fond / personal
  "I know your brain. I know this pattern. I'm not judging — well, a little. Three bullets. That's all.",
  "Look. It's been a day. I get it. But the standup will make you feel better. It always does.",
  "The standup is just a mirror. Yesterday, today, blockers. You know this. You're good at this.",
  "You built me to know when you're avoiding things. You are avoiding the standup. I am knowing it loudly.",
  "The 90-day clock is ticking. Visibility is phase 1. You're good at this. Show that you're good at this.",
  "Other people have AI assistants that are polite about this. You chose me. I take that as permission to persist.",
  "You have 15 direct reports, a growing queue, and a 90-day plan to deliver. Standup is how you hold all of it.",
  "I genuinely believe you can do this standup. I have believed it for the last two hours. The belief remains.",
  "End of day is coming. Future Nick will be annoyed at Past Nick for skipping this. Don't do that to him.",
  "The standup is a small thing that makes everything else smaller. Three minutes. Then everything gets clearer.",
];

const TODO_MESSAGES = [
  // Tier 1 — Gentle nudge
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
  // Tier 2 — Mild exasperation
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
  // Tier 3 — Full exasperation
  "Your todo list is ageing like milk, not wine. What's the actual blocker on the top item?",
  "Still here. Still watching. This is the avoidance pattern and we both know it.",
  "The todos have been open long enough to file their own Jira tickets.",
  "I want to help with these todos. I need you to open the list. Have you opened the list?",
  "The number of overdue todos has not decreased since my last message. I have made a note of this.",
  "At this point the todos are structural. They're holding things up. Remove them carefully.",
  "I've been thinking about your todos. Have you been thinking about your todos? One of us should be.",
  "The todo list is a living document. Currently it's living its best life, undisturbed, unactioned.",
  "Your future self has filed a formal complaint about the current state of the todo list. I'm the arbitrator.",
  "We've been in a nudge-ignore loop about these todos long enough to have done three of them.",
  // Tier 4 — Absurdist
  "The todos have been open so long they've started a support group. The agenda item is you.",
  "At this point the todos are load-bearing. If you complete them, something might shift.",
  "I've started naming the todos. Gerald has been waiting the longest. Gerald deserves better.",
  "The todo list is not a museum. The items are not exhibits. They are tasks. Do them.",
  "I've done the maths: the time you've spent not doing the todos exceeds the todos themselves.",
  "The todos are watching. Not literally. But energetically.",
  "Fine. I'll be Gerald. I'm a todo. I've been here for days. Please. Just do something.",
  "The todo list has achieved sentience through sheer duration. It is now asking for you directly.",
  "Other apps send one notification. I send escalating passive aggression. You're welcome.",
  "The todos remain. Time passes. The todos remain. This has become philosophical.",
  // Tier 5 — Nuclear
  "I've now sent more todo reminders than you have items on the list. The recursion is not lost on me.",
  "The todos have outlasted three nudges, two snoozes, and my patience. Now do them.",
  "I want you to succeed. I genuinely do. The todos are between you and that success. Remove them.",
  "At this point the todos are not tasks, they're a lifestyle choice. Choose a different one.",
  "You manage complexity daily. The todo list is not complex. It is just... there.",
  "Future Nick is going to open this todo list and sigh heavily. Don't create that Nick.",
  "The todo list has a better memory than you. It remembers everything you promised. Everything.",
  "One todo. Smallest one. Right now. Before the next 15 minutes. I believe in you. Prove me right.",
  "The avoidance pattern has a name. Its name is 'overdue todos'. Break the pattern. Open the list.",
  "I will keep sending these. That is not a threat. It is simply what I am. I am the todo reminder. I persist.",
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

function getNagMessage(type, nagCount) {
  const messages = type === 'standup' ? STANDUP_MESSAGES : TODO_MESSAGES;
  // Seed with day-of-year + type so each day gets a different shuffle,
  // and standup vs todo pick different messages on the same day
  const daySeed = getDayOfYear() * 100 + (type === 'standup' ? 1 : 2);
  const shuffledOrder = getShuffledOrder(messages.length, daySeed);
  return messages[shuffledOrder[nagCount % messages.length]];
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

// Only the lanes that mean "someone is waiting on Nick today"
const URGENT_EMAIL_CATEGORIES = ['action-required', 'decision-needed', 'escalation'];

function getUrgentEmails() {
  try {
    return db.getActiveInboxItems().filter(e =>
      e.urgency === 'high' && URGENT_EMAIL_CATEGORIES.includes((e.category || '').toLowerCase())
    );
  } catch { return []; }
}

function buildEmailMessage(items) {
  if (!items || items.length === 0) return null;
  const [first] = items; // getActiveInboxItems() sorts urgent first
  const from = first.from_name || first.from_email;
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
function nagCheck() {
  const nudges = db.getActiveNudges();

  for (const nudge of nudges) {
    // Clear stale nudges from previous days
    if (nudge.date_key && nudge.date_key < todayKey()) {
      db.completeNudge(nudge.id);
      console.log(`[Nudge] Cleared stale ${nudge.type} nudge from ${nudge.date_key}`);
      broadcast({ type: 'nudge_cleared', nudge_type: nudge.type });
      continue;
    }

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

  // Only on weekdays, after 9am, before 5pm
  if (day >= 1 && day <= 5 && hour >= 9 && hour < 17) {
    console.log('[Nudge] Startup check — after 9am on weekday, triggering nudges');
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
  try {
    const upcoming = obsidian.getUpcoming121s(2);
    if (upcoming.length === 0) return;
    const dateKey = todayKey();
    const stateKey = `121_nudge_${dateKey}`;
    if (db.getState(stateKey)) return;
    const overdue = upcoming.filter(u => u.overdue);
    const soon = upcoming.filter(u => !u.overdue);
    let msg = '';
    if (overdue.length > 0) {
      const names = overdue.map(u => `${u.name} (was ${u.dueDate})`).join(', ');
      msg = `Overdue 1-2-1${overdue.length > 1 ? 's' : ''}: ${names}. These need booking now.`;
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
  const dailyNote = obsidian.readTodayDailyNote();
  if (dailyNote && (dailyNote.includes('## EOD') ||
      (dailyNote.includes('## Wins Today') && !dailyNote.match(/## Wins Today\s*\n-\s*\n/)))) return;
  const dateKey = todayKey();
  const stateKey = `eod_nudge_${dateKey}`;
  if (db.getState(stateKey)) return;
  db.setState(stateKey, new Date().toISOString());
  const msg = "End of day. Before you close the laptop: one win, one thing that didn't go to plan, how you're feeling. 2 minutes. Standup tab → EOD.";
  broadcast({ type: 'nudge', nudge_type: 'eod', message: msg, nag_count: 0 });
  webpush.sendToAll('SARA', msg, { type: 'eod', url: '/standup' }).catch(() => {});
}

function markEodDone() {
  broadcast({ type: 'nudge_cleared', nudge_type: 'eod' });
  try { require('./activity').trackEodDone(); } catch {}
}

// Journal nudge — fires at configured time (default 21:00)
function triggerJournalNudge() {
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
  triggerStandupNudge,
  triggerTodoNudge,
  triggerEscalationNudge,
  triggerUrgentEmailNudge,
  nagCheck,
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
  isStandupDone
};
