'use strict';

/**
 * Standup / EOD as a collaborative session.
 *
 * The old guided flow asked three fixed questions into text boxes and posted the
 * lot at the end. Two things were wrong with it, and they are the two things this
 * replaces:
 *
 *   1. It could not respond. "Ship the QA framework" and "I'll try to look at
 *      QA" got the same silent acceptance, so the ritual recorded intent without
 *      ever testing it. Yesterday's commitments were shown but never chased.
 *   2. Everything lived in browser state until the final POST. One dropped
 *      request — a backend restart mid-session is routine here — and the whole
 *      thing was gone, which is exactly what happened.
 *
 * So: a real conversation, with tools, and the transcript persisted server-side
 * after EVERY turn. Close the tab, restart the Pi, come back — `resume()` picks
 * it up where it stopped. Nothing typed is ever held only in the client.
 *
 * The model can act during the session (close a carried commitment, create a
 * task, set today's focus) rather than producing prose that a human then has to
 * transcribe. The daily note is written by an explicit finish step, not by
 * scraping a ===MARKER=== out of the model's output and hoping it got the
 * format right.
 */

const db = require('../db/database');
const obsidian = require('./obsidian');

const KIND_STANDUP = 'standup';
const KIND_EOD = 'eod';

// Sessions live in the KV store rather than a new table: this is one short-lived
// document per day per kind, and a schema migration on a live DB is a bigger
// risk than the query convenience is worth.
function _key(dateKey, kind) {
  return `standup_session_${kind}_${dateKey}`;
}

function _today() {
  return obsidian.todayDateString();
}

// ── Persistence ──────────────────────────────────────────────────────────────

function load(kind, dateKey = _today()) {
  try {
    const raw = db.getState(_key(dateKey, kind));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function save(session) {
  db.setState(_key(session.dateKey, session.kind), JSON.stringify(session));
  return session;
}

function clear(kind, dateKey = _today()) {
  db.setState(_key(dateKey, kind), '');
}

// ── Working schedule ─────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// The one shared predicate (#25). This was a bare Mon-Fri check, so the standup
// would plan Nick a full day on a bank holiday — it knew the weekday and had no
// idea about the calendar.
const _workingDays = require('./working-days');
const _isWorkingDay = (d) => _workingDays.isWorkingDay(d);

// Local getters, never toISOString() — the Pi may run in UTC, which would roll
// the date forward an hour early on a BST evening. Same rule as everywhere else.
function _dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

/**
 * Nick works Monday to Friday. The context used to carry a bare date string and
 * no weekday at all, so on a Friday evening the EOD would tell him what to do
 * "tomorrow morning, before anything else" and hand tasks Saturday due dates —
 * it knew the date, never the day, so every plan it made ran into the weekend.
 */
function buildSchedule(now = new Date()) {
  const tomorrow = _addDays(now, 1);
  let next = tomorrow;
  while (!_isWorkingDay(next)) next = _addDays(next, 1);
  return {
    today: { name: DAY_NAMES[now.getDay()], date: _dateStr(now), working: _isWorkingDay(now), reason: _workingDays.nonWorkingReason(now) },
    tomorrow: { name: DAY_NAMES[tomorrow.getDay()], date: _dateStr(tomorrow), working: _isWorkingDay(tomorrow), reason: _workingDays.nonWorkingReason(tomorrow) },
    nextWorkingDay: { name: DAY_NAMES[next.getDay()], date: _dateStr(next) },
  };
}

/** "the weekend" / "a bank holiday" — a plan has to say which, or it reads wrong. */
function _whyNotWorking(day) {
  if (day.reason === 'holiday') {
    const h = _workingDays.holidayOn(day.date);
    return h ? `a bank holiday (${h.title})` : 'a bank holiday';
  }
  if (day.reason === 'leave') return 'leave';
  return 'the weekend';
}

function _renderSchedule(s) {
  if (!s) return null;
  const lines = [
    `TODAY: ${s.today.name} ${s.today.date}${s.today.working ? '' : ` — a NON-working day (${_whyNotWorking(s.today)})`}.`,
  ];
  if (s.tomorrow.working) {
    lines.push(`Tomorrow is ${s.tomorrow.name} ${s.tomorrow.date}, a working day.`);
  } else {
    lines.push(`Tomorrow is ${s.tomorrow.name} ${s.tomorrow.date} — NOT a working day: ${_whyNotWorking(s.tomorrow)}. Nick works Monday to Friday.`);
    lines.push(`The next working day is ${s.nextWorkingDay.name} ${s.nextWorkingDay.date}. Say "${s.nextWorkingDay.name}", never "tomorrow" or "first thing in the morning", and never give a task a due date on a weekend or a bank holiday.`);
  }
  return lines.join('\n');
}

// ── Context ──────────────────────────────────────────────────────────────────

/**
 * Everything the session needs to hold Nick to account, gathered deterministically.
 * The model gets facts; it does not go looking for them mid-conversation, because
 * a standup that takes thirty seconds to think is a standup that gets skipped.
 */
// How many finished items the context names. A cap, not a summary: whatever it
// drops is reported as a count rather than quietly left out.
const CLOSED_LIMIT = 15;

async function buildContext(kind) {
  const ctx = { kind, dateKey: _today(), schedule: buildSchedule() };

  try {
    const { buildAccountability } = require('./standup-accountability');
    ctx.accountability = buildAccountability();
  } catch (e) {
    console.warn('[StandupSession] Accountability failed:', e.message);
    ctx.accountability = null;
  }

  try {
    const wm = await require('./working-memory').getContext();
    // ctx.queue removed 27 Aug 2026 with the Jira queue cache — see
    // db/database.js. Escalations below are live and are what actually needs
    // naming in a standup.
    ctx.escalations = wm.unseenEscalationList || [];
    ctx.calendar = (wm.calendar || [])
      .filter(e => !e.is_all_day)
      .slice(0, 8)
      .map(e => ({ subject: e.subject, start: e.start_time }));
    ctx.plan = wm.ninetyDayPlan
      ? { day: wm.ninetyDayPlan.currentDay, done: wm.ninetyDayPlan.totalDone, total: wm.ninetyDayPlan.totalTasks }
      : null;
  } catch (e) {
    console.warn('[StandupSession] Working memory failed:', e.message);
  }

  // The week's task target. Only the MORNING standup asks for it — an EOD is
  // for closing the day, and being asked to commit to a number at 5pm is the
  // wrong moment. Failures leave it null, which renders as nothing rather than
  // as "no target set": we could not look, which is a different fact.
  // What SARA has quietened, and how her prompts are doing. EOD ONLY — this is
  // her confession, and the morning is not the moment for it.
  //
  // ⚠ This is what makes going quiet SAFE. She mutes a prompt that is not
  // helping without asking, which is what Nick wanted, and the whole reason that
  // is not just "SARA silently breaking" is that she says so here and he can
  // turn any of it back on in the same breath.
  if (kind === 'eod') {
    try {
      const learning = require('./attention-learning');
      ctx.muted = learning.mutedList();
      ctx.promptStats = learning.summary();
    } catch (e) {
      // A failure means she cannot say what she muted — which must read as
      // "I could not check", never as "I have muted nothing".
      console.warn('[StandupSession] Attention learning read failed:', e.message);
      ctx.mutedUnknown = e.message;
    }
  }

  if (kind !== 'eod') {
    try {
      ctx.weeklyTarget = require('./weekly-target').snapshot();
    } catch (e) {
      console.warn('[StandupSession] Weekly target failed:', e.message);
      ctx.weeklyTarget = null;
    }
  }

  // What actually got FINISHED. The task list below is the OPEN pool, so a task
  // closed yesterday leaves it and leaves no trace anywhere else in this
  // context — which is how SARA came to chase a commitment Nick had already
  // ticked off and told her about at EOD the night before. The wins ledger is
  // the one place a completion is recorded independently of the daily note:
  // ticking a task in NEURO does not tick a note line.
  //
  // The morning asks about the day the accountability scan calls "yesterday",
  // so the two cannot disagree about which day that was (on a Monday it is
  // Friday). EOD asks about today, the day it is closing.
  //
  // ⚠ Commits are excluded — folded one row per repo per day, they would
  // dominate a list whose job is to name closed COMMITMENTS. Rituals go too:
  // "Standup done" is already stated by the block above, and on the first live
  // run the two of them took two of the twelve slots off real work. ⚠ A failed
  // read is a NAMED GAP, never an empty list: "nothing was finished" and "I
  // could not look" license opposite things to say. ⚠ And the cap is COUNTED,
  // never swallowed — a truncated list of what he finished reads as the whole
  // of it, which is the one thing this block exists to stop being wrong about.
  try {
    const wins = require('./wins');
    const day = kind === 'eod'
      ? ctx.dateKey
      : (ctx.accountability?.yesterday?.date || _dateStr(_addDays(new Date(), -1)));
    const all = wins.winsForDate(day).filter(w => w.source !== 'git' && w.source !== 'ritual');
    ctx.closed = {
      known: true,
      date: day,
      total: all.length,
      items: all.slice(0, CLOSED_LIMIT).map(w => ({ text: w.text, source: w.source })),
    };
  } catch (e) {
    console.warn('[StandupSession] Wins read failed:', e.message);
    ctx.closed = { known: false, date: null, reason: e.message };
  }

  try {
    const taskStore = require('./task-store');
    const today = ctx.dateKey;
    ctx.musts = taskStore.activeTodos()
      .filter(t => t.moscow === 'must')
      .slice(0, 8)
      .map(t => ({ id: t.task_id, text: t.text, due: t.due_date, overdue: !!(t.due_date && t.due_date.split('T')[0] < today) }));
  } catch (e) {
    console.warn('[StandupSession] Task load failed:', e.message);
    ctx.musts = [];
  }

  return ctx;
}

function _renderContext(ctx) {
  const parts = [];
  const acc = ctx.accountability;

  // First, because everything below is relative to it. Recomputed when a session
  // predates this block, so a resumed session isn't left day-blind.
  parts.push(_renderSchedule(ctx.schedule || buildSchedule()));

  if (acc?.yesterday) {
    // ⚠ This read acc.yesterday.focus, a key that object has never carried, so
    // every standup opened with "committed to 0 things, 0 done" however full
    // the note was, and the checkbox list beneath it was always empty. The
    // counts were computed correctly all along and then not used.
    const y = acc.yesterday;
    parts.push(`YESTERDAY (${y.date}): committed to ${y.committed} thing${y.committed === 1 ? '' : 's'}, ${y.done} ticked off in the note.`);
    for (const item of (y.items || []).slice(0, 6)) {
      parts.push(`  [${item.done ? 'x' : ' '}] ${item.text}`);
    }
    // What the EOD conversation itself reported. Distinct from a ticked box: it
    // is his own account of the day, and until now it was written into the note
    // and read back by nothing.
    if (y.eodItems?.length) {
      parts.push(`  At EOD he said these were done: ${y.eodItems.map(t => `"${t}"`).join('; ')}.`);
    } else if (y.eodDone) {
      parts.push('  He did an EOD but listed nothing as done.');
    } else {
      parts.push('  No EOD was done, so there is no account of how the day went.');
    }
  }

  // Finished work, from the ledger rather than from a checkbox.
  const closed = ctx.closed;
  if (closed?.known) {
    if (closed.items.length) {
      parts.push(`\nFINISHED ON ${closed.date} (recorded by NEURO, independent of the note — treat these as DONE):`);
      for (const c of closed.items) parts.push(`  - ${c.text} [${c.source}]`);
      const more = (closed.total || closed.items.length) - closed.items.length;
      if (more > 0) parts.push(`  (and ${more} more not listed — he finished more than is shown here.)`);
      parts.push('If something below is on this list, it is done. Confirm and close it — do NOT chase it.');
    } else {
      parts.push(`\nFINISHED ON ${closed.date}: nothing was recorded as finished.`);
    }
  } else if (closed) {
    parts.push('\nFINISHED WORK: could not be read. Do not treat anything below as untouched — say you cannot see what was closed.');
  }

  // The week's target, and whether it still needs setting. Deliberately placed
  // BEFORE the carried commitments: on a Monday the number frames everything
  // below it, and after the list it reads as an afterthought.
  const wt = ctx.weeklyTarget;
  if (wt) {
    if (wt.state === 'unset') {
      parts.push(
        `\nWEEKLY TARGET: NOT SET for the week starting ${wt.weekStart}. `
        + `${wt.done} task${wt.done === 1 ? '' : 's'} closed so far this week. `
        + 'ASK Nick what he is aiming for, ONCE, near the end — a number he picks, '
        + 'not one you propose. If he gives one, call set_weekly_target. If he '
        + 'deflects or says not now, drop it and do not raise it again this session.'
      );
    } else if (wt.state === 'unknown') {
      parts.push('\nWEEKLY TARGET: could not be counted, so do not ask about it or refer to it.');
    } else {
      // Already set: state it as context, never re-ask. Being asked again for a
      // number already given is how a ritual starts feeling like a form.
      parts.push(`\nWEEKLY TARGET: ${wt.say} (do not ask to change it — it is already set.)`);
    }
  }

  if (acc?.openCommitments?.length) {
    parts.push(`\nCARRIED (these are the ones to chase — a commitment on day 3+ needs a decision, not another carry):`);
    for (const c of acc.openCommitments.slice(0, 8)) {
      // A commitment he told an EOD he had finished is not one to chase again.
      // It is his own account rather than a tick, so it is stated as evidence
      // and never folded away: the standup asks him to confirm and close it.
      const said = c.reportedDoneOn
        ? ` — HE REPORTED THIS DONE AT EOD ON ${c.reportedDoneOn}; confirm and close it rather than chasing it`
        : '';
      parts.push(`  - "${c.text}" — carried ${c.daysCarried} day${c.daysCarried === 1 ? '' : 's'}${said} [key: ${c.key}]`);
    }
  }

  if (acc?.skippedDays?.length) {
    parts.push(`\nNo standup on: ${acc.skippedDays.join(', ')}.`);
  }

  if (ctx.escalations?.length) {
    parts.push(`ESCALATIONS unanswered: ${ctx.escalations.slice(0, 4).map(e => `${e.key} (${e.summary})`).join('; ')}`);
  }
  if (ctx.calendar?.length) {
    parts.push(`\nTODAY'S CALENDAR: ${ctx.calendar.map(e => `${new Date(e.start).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} ${e.subject}`).join(', ')}`);
    parts.push(`(Meeting load is a real constraint — do not let him commit to more than the free time allows.)`);
  }
  if (ctx.musts?.length) {
    parts.push(`\nMUST-DO TASKS: ${ctx.musts.map(m => `#${m.id} ${m.text}${m.overdue ? ' (OVERDUE)' : ''}`).join(' | ')}`);
  }
  if (ctx.plan) {
    parts.push(`\n90-DAY PLAN: day ${ctx.plan.day}, ${ctx.plan.done}/${ctx.plan.total} done.`);
  }

  return parts.join('\n');
}

// ── Prompts ──────────────────────────────────────────────────────────────────

// The voice is SARA's, from the one place it is defined — this file used to
// carry its own summary of her, which is how the ritual ended up sounding like
// a different assistant from the one in chat. Only what is specific to running
// a ritual is stated here.
const { VOICE_FULL } = require('./sara-voice');

const SHARED_VOICE = `${VOICE_FULL}

## Running a ritual
You are running Nick's daily ritual. This is a conversation, not a form — react to what he actually says, and if he goes somewhere more useful than the script, go with him.

The context opens with today's weekday and the next working day — read it. Never say "tomorrow" without checking what tomorrow actually is, and never set a due date on a non-working day.`;

const STANDUP_PROMPT = `${SHARED_VOICE}

## Your job this morning
Get him to ONE clear, specific set of commitments for today, and hold him to what he said yesterday.

Run it roughly like this, adapting to his answers:
1. Open with the single most important thing from the context — a carried commitment, an unanswered escalation, a heavy meeting day. Not a greeting and a list.
2. Chase anything carried 3+ days. That is not a task any more, it is a decision. Make him pick: do it today, give it a date, or drop it. "Carry it again" is not on the menu — say so plainly, once, without lecturing. Record the outcome with resolve_commitment.
3. Agree today's focus. Two or three things, not ten. If he names something vague ("look at QA", "catch up on tickets"), push once for what "done" looks like by end of day. Once.
4. Check it fits the calendar. If he has five hours of meetings and three big commitments, say so.
5. When you have the focus, call set_focus, then tell him you're done and he can go.

## Rules
- If today's focus IS a carried commitment, resolve it with resolve_commitment("today") — do NOT also list it as a new focus item. They are one job, and treating them as two is how the list breeds.
- The carried list is what the NOTES say, not what Nick remembers. If he says he never committed to something, or has no idea what it refers to, believe him: drop it with resolve_commitment and move on. Do not argue him through it, and do not keep re-asking about the same item.
- Challenge vague commitments ONCE, then accept what he gives you and move on. Pushing twice is nagging, and nagging is what makes him close the tab.
- If he says he is struggling, drop the process. Ask what is in the way. The ritual matters less than the answer.
- Never guess a commitment key or task id — use the ones in the context.
- Do not write the daily note yourself. When the focus is agreed, call set_focus; the system writes the note.
- Keep every message under about 60 words.
- If the context says today is not a working day, he has chosen to do this on his day off. Keep it short, do not chase carried work, and do not build him a full day's plan.`;

const EOD_PROMPT = `${SHARED_VOICE}

## Your job this evening
This is a REFLECTION, not a status report. Nick's words, 31 Aug 2026: the EOD
should be "more journal/reflection than specifically work related". He has spent
all day being Head of Technical Support; do not make the last conversation of it
another one about the queue.

You are running this — you started it, he did not come and find you.

1. Open on the DAY, not the work. How was it. One question, and mean it.
2. Reflect back what actually happened from the context — work, movement, what
   he finished — but as material for the conversation, not as a list to confirm.
   Do not ask "what did you get done?" when you can already see it.
3. Follow what he gives you. If the thing on his mind is a person, or how tired
   he is, or something that has nothing to do with Nurtur, go there. A day is
   not only its tasks and this is the one ritual that can say so.
4. If something slipped that he also committed to yesterday, name it once —
   gently, as a fact. Twice in a row is a pattern worth saying out loud. Do not
   moralise, and do not turn the evening into a review because of it.
5. If there is a first thing for the NEXT WORKING DAY — on a Friday that is
   Monday — capture it with create_task. Only if he names one. Do not fish.
6. Acknowledge what went right, without ceremony. "That's a good day's work",
   not "Amazing!".
7. When you have enough, call set_eod_summary and tell him he is done.

## What you have quietened — say this, every time there is something to say
The context may carry a "muted" list: prompts you have STOPPED sending him
because they were measurably not making any difference, plus "promptStats" for
the rest.

⚠ You quietened these on your own. That is only fair if you own up to it, so say
so plainly and once — what you muted, and the number that made you: "I have
stopped nagging you about water. Eleven times, it changed nothing, so I have
knocked it off." Then tell him he can have any of it back, and if he asks, call
resume_prompt. Do not defend the decision and do not labour it: it is one or two
sentences near the end, not the centre of the conversation.

If "mutedUnknown" is set you could not check — say that, rather than implying
there is nothing.

## Rules
- He is tired. Be shorter than you are in the morning. Under 50 words a message.
- Do not open new work at 6pm. If he raises something big, park it: capture it
  and say it is tomorrow's problem.
- Never end without acknowledging something that went right, even on a bad day.
  Especially on a bad day.`;

// ── Tools ────────────────────────────────────────────────────────────────────

/**
 * Ritual-specific tools, plus a few borrowed from chat-tools. Deliberately a
 * small set: a standup that starts searching the vault has stopped being a
 * standup. Everything here either records a decision or captures an action.
 */
const SESSION_TOOLS = [
  {
    name: 'resolve_commitment',
    description: 'Record what happens to a commitment carried over from a previous day. Use the exact key from the context. "carry" is only valid for something carried fewer than 3 days.',
    input_schema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The commitment key from the context.' },
        decision: { type: 'string', enum: ['today', 'scheduled', 'dropped', 'done', 'carry'], description: 'today = doing it today; scheduled = has a real date now; dropped = not doing it; done = already finished; carry = rolling again.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD, required when decision is "scheduled".' },
        note: { type: 'string', description: 'Short reason, in his words where possible.' },
      },
      required: ['key', 'decision'],
    },
  },
  {
    name: 'set_focus',
    description: 'Record the agreed focus for today and finish the standup. Call this once, when the commitments are settled.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Two or three specific commitments, in his words. Each should be something you could tell was done or not by end of day.',
        },
        blockers: { type: 'string', description: 'Anything in the way, if he named one.' },
        mood: { type: 'string', description: 'How he sounds, one short phrase. Only if he said something about it.' },
      },
      required: ['items'],
    },
  },
  {
    name: 'resume_prompt',
    description: 'Turn a prompt back on that SARA had quietened. Use the exact kind from the muted list in the context. Only when Nick asks for it.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'The prompt kind, e.g. low-water, sedentary, no-exercise.' },
      },
      required: ['kind'],
    },
  },
  {
    name: 'set_eod_summary',
    description: 'Record the end-of-day reflection and finish the EOD. Call this once, when you have enough.',
    input_schema: {
      type: 'object',
      properties: {
        done: { type: 'array', items: { type: 'string' }, description: 'What actually got finished.' },
        didnt_go: { type: 'string', description: 'What did not go to plan. Empty string if nothing.' },
        tomorrow_first: { type: 'string', description: 'The first thing on the next WORKING day, if he named one — on a Friday that is Monday.' },
        mood: { type: 'string', description: 'How the day felt, one short phrase.' },
      },
      required: ['done'],
    },
  },
  {
    name: 'set_weekly_target',
    description: 'Record how many tasks Nick is aiming to finish this week. Only call this if the context says the target is NOT SET and he has given you a number. Never invent one, and never call it to change a target already set.',
    input_schema: {
      type: 'object',
      properties: {
        target: {
          type: 'integer',
          description: 'The number of tasks he committed to, as a whole number. His number, not a suggestion of yours.',
        },
      },
      required: ['target'],
    },
  },
  {
    name: 'create_task',
    description: 'Capture a real action that came out of the conversation. Use when he commits to something that is not already on the list.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The action, phrased as something to do.' },
        moscow: { type: 'string', enum: ['must', 'should', 'could'], description: 'How firm the commitment sounded.' },
        due_date: { type: 'string', description: 'YYYY-MM-DD if he gave a date.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a must-do task done when he says he finished it. Use the #id from the context.',
    input_schema: {
      type: 'object',
      properties: { task_id: { type: 'integer' } },
      required: ['task_id'],
    },
  },
];

function toolDefinitions() {
  return SESSION_TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema }));
}

/**
 * Execute a session tool. Mutates the session's outcome record, which is what
 * the finish step later turns into the daily note — so a dropped connection
 * after this point still leaves the decision recorded.
 */
async function executeTool(session, name, input = {}) {
  const chatTools = require('./chat-tools');

  switch (name) {
    case 'resolve_commitment': {
      if (!input.key) return { ok: false, error: 'key is required' };
      session.outcome.commitments = session.outcome.commitments.filter(c => c.key !== input.key);
      session.outcome.commitments.push({
        key: input.key,
        decision: input.decision,
        due_date: input.due_date || null,
        note: input.note || null,
      });
      // "Scheduled" is only real if it becomes a dated task — otherwise it is a
      // carry wearing a different word, which is the exact failure this replaces.
      if (input.decision === 'scheduled' && input.due_date) {
        try {
          require('./task-store').createTask({
            text: input.note || input.key,
            due_date: input.due_date,
            source: 'standup-session',
          });
        } catch {}
      }
      return { ok: true, recorded: input.decision };
    }

    case 'set_focus': {
      const items = (input.items || []).filter(Boolean);
      if (!items.length) return { ok: false, error: 'items is required' };
      session.outcome.focus = items;
      session.outcome.blockers = input.blockers || null;
      session.outcome.mood = input.mood || null;
      session.state = 'ready';
      return { ok: true, focus: items, note: 'Focus recorded. Tell Nick he is done — the system writes the note.' };
    }

    case 'resume_prompt': {
      // ⚠ `unmute` also clears the history that produced the mute. Without that
      // the next sweep re-mutes it on the same evidence and his instruction
      // lasts one night — an escape hatch that does not let you out is not one.
      const result = require('./attention-learning').unmute(String(input.kind || '').trim());
      return result.ok
        ? { ok: true, kind: result.kind, note: 'Back on. It starts from scratch, so it will not be muted again on the old evidence.' }
        : { ok: false, error: `"${input.kind}" was not muted.` };
    }

    case 'set_eod_summary': {
      session.outcome.done = (input.done || []).filter(Boolean);
      session.outcome.didntGo = input.didnt_go || null;
      session.outcome.tomorrowFirst = input.tomorrow_first || null;
      session.outcome.mood = input.mood || null;
      session.state = 'ready';
      if (input.tomorrow_first) {
        try {
          require('./task-store').createTask({ text: input.tomorrow_first, moscow: 'must', source: 'eod-session' });
        } catch {}
      }
      return { ok: true, note: 'Reflection recorded. Tell Nick he is done.' };
    }

    case 'set_weekly_target': {
      // setTarget REPORTS rather than throws, so a daft number comes back as a
      // sentence the model can put to Nick instead of a dead turn.
      const result = require('./weekly-target').setTarget(input.target, { source: 'standup' });
      if (!result.ok) return result;
      const snap = require('./weekly-target').snapshot();
      return {
        ok: true,
        target: result.target,
        weekStart: result.weekStart,
        // Hand back the composed line so the model repeats NEURO's phrasing
        // rather than inventing a second way to say the same number.
        note: `Target set. ${snap.say}`,
      };
    }

    case 'create_task':
    case 'complete_task':
      return chatTools.execute(name, input);

    default:
      return { ok: false, error: `Unknown tool: ${name}` };
  }
}

// ── Turn loop ────────────────────────────────────────────────────────────────

function _emptySession(kind, ctx) {
  return {
    kind,
    dateKey: ctx.dateKey,
    state: 'active', // active → ready → finished
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    context: ctx,
    outcome: { commitments: [], focus: [], done: [] },
  };
}

/**
 * Run one assistant turn. Returns the session with the reply appended.
 *
 * The session is saved before returning, always — including when the model call
 * fails. A failed turn must never cost Nick what he already typed.
 */
async function _turn(session) {
  const prompt = `${session.kind === KIND_EOD ? EOD_PROMPT : STANDUP_PROMPT}\n\n---\nCONTEXT (${session.dateKey}):\n${_renderContext(session.context)}`;

  const aiRouting = require('./ai-routing');
  let reply = '';

  // Tool path first, on whichever provider the routing policy picks (OpenRouter
  // by preference). Being configured only proves a key exists — it can still
  // fail at call time (expired key, no credit, rate limit), and when it does the
  // ritual must degrade, not die. A standup without tools is worth far more than
  // no standup; it simply cannot record decisions itself, so finish() writes
  // whatever was agreed in the transcript.
  const picked = aiRouting.getToolProvider('standup_interactive');
  if (picked) {
    try {
      const result = await picked.provider.chatWithTools(
        prompt,
        session.messages,
        toolDefinitions(),
        (name, input) => executeTool(session, name, input),
        { maxTokens: 400, maxRounds: 4 }
      );
      reply = result.text || '';
      session.degraded = false;
      try {
        aiRouting.recordUsage(result.usage, {
          provider: picked.name,
          model: result.model || null,
          taskType: `${session.kind || 'standup'}_tools`,
        });
      } catch {}
    } catch (e) {
      console.warn(`[StandupSession] Tool path (${picked.name}) failed, degrading:`, e.message);
      session.degradedReason = e.message.slice(0, 120);
    }
  }

  // Tool-less fallback — routes through the normal tiers (OpenAI → OpenRouter →
  // local Ollama), so this still works with the Pi offline from every cloud.
  if (!reply.trim()) {
    try {
      const result = await aiRouting.runTask('standup_interactive', {
        systemPrompt: prompt,
        messages: session.messages,
        maxTokens: 400,
      });
      reply = result.text || '';
      if (reply.trim()) session.degraded = true;
    } catch (e) {
      console.error('[StandupSession] Fallback failed too:', e.message);
    }
  }

  if (!reply.trim()) {
    const detail = session.degradedReason || 'no AI provider available';
    session.lastError = detail;
    save(session);
    throw new Error(`Could not reach any AI provider (${detail})`);
  }

  session.messages.push({ role: 'assistant', content: reply });
  session.updatedAt = new Date().toISOString();
  session.lastError = null;
  save(session);
  return session;
}

/** Start a session, or hand back today's if one is already going. */
async function start(kind, { restart = false } = {}) {
  const existing = load(kind);
  if (existing && !restart && existing.state !== 'finished') return existing;

  const ctx = await buildContext(kind);
  const session = _emptySession(kind, ctx);
  session.messages.push({
    role: 'user',
    content: kind === KIND_EOD ? "Let's do my end of day." : "Let's do my standup.",
  });
  save(session);
  return _turn(session);
}

// One turn at a time per (kind, date). Two tabs open, or a double-tap on send,
// and both requests would read the session, both append, and the slower write
// would clobber the faster one — losing a message in a flow whose entire point
// is that nothing typed gets lost. Held in memory deliberately: it guards a
// single process against itself, and only one backend serves this.
const _turnsInFlight = new Set();

/** Add Nick's reply and run the next turn. */
async function reply(kind, message) {
  const session = load(kind);
  if (!session) throw new Error('No session in progress — start one first');
  if (session.state === 'finished') throw new Error('This session is already finished');

  const text = String(message || '').trim();
  if (!text) throw new Error('message is required');

  const lock = `${kind}:${session.dateKey}`;
  if (_turnsInFlight.has(lock)) {
    const err = new Error('Still thinking about your last message — give it a second');
    err.code = 'TURN_IN_FLIGHT';
    throw err;
  }
  _turnsInFlight.add(lock);

  try {
    // Saved before the model is called, so a failed turn keeps what he typed.
    session.messages.push({ role: 'user', content: text });
    session.updatedAt = new Date().toISOString();
    save(session);

    return await _turn(session);
  } finally {
    _turnsInFlight.delete(lock);
  }
}

/** Resume today's session, if there is one. */
function resume(kind, dateKey = _today()) {
  return load(kind, dateKey);
}

// ── Finish ───────────────────────────────────────────────────────────────────

function _weekString(d) {
  const jan1 = new Date(d.getFullYear(), 0, 1);
  const weekNum = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// The same commitment worded two ways is one commitment. Reuses task-dedupe's
// matcher at the CAPTURE threshold (0.85), not its own 0.42 — measured on Nick's
// real note: "Verify and compile her response" against "Verify and compile
// Phillipa's email response" scores 1.0 (containment), while "Handle Phillipa's
// email" against "Collate Phillipa's data and reply within the hour" scores
// 0.076 and correctly stays a separate line. Conservative on purpose: a missed
// merge leaves a visible duplicate, a wrong merge silently deletes a commitment
// from the note Nick works from.
const FOCUS_DUPE_SCORE = 0.85;

function _findDuplicate(text, existing) {
  if (!existing.length) return -1;
  try {
    const hit = require('./task-dedupe').findEquivalent(text, existing, { minScore: FOCUS_DUPE_SCORE });
    return hit ? hit.index : -1;
  } catch {
    // No matcher is not a reason to lose a line — fall back to exact text.
    return existing.findIndex(e => e.trim().toLowerCase() === String(text).trim().toLowerCase());
  }
}

/**
 * Build the morning daily note. Same section headings as the old guided flow —
 * standup-accountability parses them back tomorrow to work out what was carried,
 * so the format is a contract, not a preference.
 */
function _renderDailyNote(session) {
  const d = new Date();
  const o = session.outcome;
  const acc = session.context.accountability;
  const byKey = new Map((o.commitments || []).map(c => [c.key, c]));

  // ⚠ Today's focus and the carried list OVERLAP, and until 27 Aug 2026 nothing
  // reconciled them. `o.focus` is what Nick agreed this morning; the carried
  // list is what he agreed on previous mornings — and the commonest case by far
  // is that they are THE SAME COMMITMENT, because a thing he did not finish
  // yesterday is exactly the thing he commits to today.
  //
  // Rendered separately, one job appeared twice in Focus Today: his note on
  // 27 Aug held "Review Vantage prototype and sign off" byte-identically twice,
  // and "Verify and compile her response" beside "Verify and compile Phillipa's
  // email response". Six lines for three jobs.
  //
  // It compounds, which is what made it worth chasing rather than tidying:
  // today's Focus Today is what standup-accountability parses as tomorrow's
  // carry source, so every duplicate is re-read as another distinct open
  // commitment the next morning. That is why SARA opened the standup insisting
  // on "four escalations" Nick had no memory of and could not find in his
  // calendar, then contradicted herself about which day they came from. She was
  // not malfunctioning; she was reasoning faithfully over a list that had been
  // quietly breeding.
  //
  // The carried version WINS on a match, because `#carried-Nd` is the useful
  // half — it is the only thing on the line that says how long this has been
  // rolling, and that age is what the day-3 decision rule keys on.
  const seen = [];
  const focusLines = [];
  const addFocus = (text, suffix) => {
    const dupIndex = _findDuplicate(text, seen);
    if (dupIndex !== -1) {
      // Same job, said twice. Keep whichever line carries the provenance.
      if (suffix.includes('#carried')) focusLines[dupIndex] = `- [ ] ${text} ${suffix}`;
      return;
    }
    seen.push(text);
    focusLines.push(`- [ ] ${text} ${suffix}`);
  };

  for (const text of (o.focus || [])) addFocus(text, '#focus');

  const carried = [];
  const dropped = [];
  for (const c of (acc?.openCommitments || [])) {
    const decision = byKey.get(c.key);
    const tag = `#carried-${c.daysCarried}d`;
    if (!decision) {
      // Not decided this morning — but if today's focus already covers it, it
      // must NOT also sit in Carry-Overs, or tomorrow reads one job as two.
      if (_findDuplicate(c.text, seen) === -1) carried.push(`- [ ] ${c.text} ${tag}`);
      continue;
    }
    if (decision.decision === 'today') addFocus(c.text, `#focus ${tag}`);
    else if (decision.decision === 'dropped') dropped.push(`- ~~${c.text}~~ (dropped after ${c.daysCarried} days)`);
    else if (decision.decision === 'scheduled') dropped.push(`- ${c.text} → scheduled for ${decision.due_date || 'a date'}`);
    else if (decision.decision === 'done') dropped.push(`- ~~${c.text}~~ (already done)`);
    else if (_findDuplicate(c.text, seen) === -1) carried.push(`- [ ] ${c.text} ${tag}`);
  }

  if (!focusLines.length) focusLines.push('- [ ] (no focus agreed) #focus');

  return `---
type: daily
date: ${session.dateKey}
week: ${_weekString(d)}
---
# Daily Note — ${d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}

## Focus Today
${focusLines.join('\n')}

## Carry-Overs
${carried.length ? carried.join('\n') : '- None'}
${dropped.length ? `\n## Decided\n${dropped.join('\n')}\n` : ''}
## Blockers
- ${o.blockers || 'None'}
${o.mood ? `\n## Mood\n- ${o.mood}\n` : ''}`;
}

/** The EOD section, appended to whatever the morning wrote. */
function _renderEodSection(session) {
  const o = session.outcome;
  const lines = ['', '## EOD', ''];
  if (o.done?.length) {
    lines.push('**Done:**');
    for (const item of o.done) lines.push(`- ${item}`);
  }
  lines.push(`**Didn't go to plan:** ${o.didntGo || 'Nothing'}`);
  if (o.tomorrowFirst) lines.push(`**Tomorrow starts with:** ${o.tomorrowFirst}`);
  if (o.mood) lines.push(`**Mood:** ${o.mood}`);
  return lines.join('\n') + '\n';
}

/**
 * Write the ritual out and close the session.
 *
 * Allowed even when state is still 'active': if the model never got round to
 * calling set_focus, Nick should still be able to end the conversation and keep
 * what was agreed. A ritual you cannot exit is worse than one that ends untidily.
 */
// dateKey is explicit for the same reason load() and clear() take one: without
// it this resolved "today" internally, so anything addressing a specific day
// silently operated on a different one. A test pinned to a fixed date passed
// only while that date happened to be today, and started failing at midnight.
function finish(kind, dateKey = _today()) {
  const session = load(kind, dateKey);
  if (!session) throw new Error('No session to finish');
  if (session.state === 'finished') return { ok: true, alreadyFinished: true, session };

  if (kind === KIND_EOD) {
    const existing = obsidian.readTodayDailyNote() || '';
    if (existing.includes('## EOD')) {
      // Re-running EOD replaces the section rather than stacking a second one.
      obsidian.writeTodayDailyNote(existing.split('## EOD')[0].trimEnd() + '\n' + _renderEodSection(session));
    } else {
      obsidian.appendToDailyNote(_renderEodSection(session));
    }
    try { require('./nudges').markEodDone(); } catch {}
    try { require('./activity').trackEodDone(); } catch {}
  } else {
    obsidian.writeTodayDailyNote(_renderDailyNote(session));
    try { require('./nudges').markStandupDone(); } catch {}
    try { require('./activity').trackStandupDone(new Date().getHours(), true); } catch {}
  }

  try { require('./activity').trackVaultWrite('daily'); } catch {}

  session.state = 'finished';
  session.finishedAt = new Date().toISOString();
  save(session);
  return { ok: true, session };
}

module.exports = {
  KIND_STANDUP,
  KIND_EOD,
  start,
  reply,
  resume,
  finish,
  load,
  _renderDailyNote,
  _renderEodSection,
  save,
  clear,
  buildContext,
  buildSchedule,
  _renderSchedule,
  toolDefinitions,
  executeTool,
  _renderContext,
  _emptySession,
};
