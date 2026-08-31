'use strict';

/**
 * When an ambient observation is worth interrupting for.
 *
 * ── The correction that produced this file ───────────────────────────────────
 * I said water should never push. Nick, 31 Aug 2026: *"if I'm sat in the office,
 * and haven't recorded a drink in hours, that should be called out — if I'm in a
 * meeting, or hiking, then not. But yes — I think it all should push, but
 * contextually and sensitively."*
 *
 * He is right and the reasoning I had was lazy. Whether something is worth
 * saying is not a property of the SIGNAL, it is a property of the MOMENT. The
 * same fact — no drink logged for three hours — is worth a word at a desk and is
 * noise halfway up a hill. Deciding per signal is how you end up with a system
 * that is either mute or a pest, because there is no single answer to "should
 * water push" and I was trying to give one.
 *
 * ⚠ Note "hiking" needs no special case, and that is the test of the design: if
 * he is walking, `atDesk` is already false and the steps are climbing. A moment
 * described honestly out of the signals SARA already has does not need a list of
 * activities to exclude.
 *
 * ── What this file does NOT do ──────────────────────────────────────────────
 * It does not send. `webpush.sendToAll` already carries the machinery that stops
 * a nag becoming a pest, and every one of those was built for a reason:
 *
 *   · `attention-lifecycle` gives the thing a DURABLE IDENTITY, so the same
 *     observation cannot notify twice across widget, push, kiosk and phone, and
 *     an acknowledged one stays visible without ever interrupting again.
 *   · the governor holds quiet hours, a 30-minute dedupe and an hourly cap.
 *
 * So this decides ONLY "is now the moment", and hands the survivors over. A
 * second copy of quiet hours here is how two parts of a system come to disagree
 * about the same evening.
 *
 * PURE where it judges: `momentFrom()` and `worthInterrupting()` take plain data
 * and a clock. Only `deliver()` sends.
 *
 * CommonJS — NEURO backend convention.
 */

// He asked for this explicitly, so it is on by default — but it is the one part
// of the ambient layer that can annoy him, so the switch is loud and one line.
const ENABLED = process.env.AMBIENT_PUSH_ENABLED !== 'false';

// A drink at a desk is worth mentioning after this long. Deliberately generous:
// he is not being audited, and a prompt every hour is one he turns off.
const DRY_HOURS = 3;

// ── The moment ───────────────────────────────────────────────────────────────

/**
 * Everything about right now that bears on whether to interrupt. PURE.
 *
 * Deliberately a small, named set rather than passing four raw payloads into the
 * rules: the rules below should read like the sentence Nick said, and a rule
 * spelling out `phone.activity === 'Still' && !phone.focusMode && ...` is one
 * nobody can check against what he asked for.
 */
function momentFrom({ context = null, phone = null, desktop = null, now = new Date() } = {}) {
  const activity = phone && phone.activity ? String(phone.activity) : null;

  // At a desk: the laptop is reporting an app in the foreground, OR the phone is
  // still and he is somewhere he sits. The laptop is the stronger signal and is
  // tried first — it is the one that means WORKING rather than merely stationary.
  const atLaptop = !!(desktop && desktop.known && desktop.app);
  const stillSomewhere = activity === 'Still';

  return {
    now,
    // ⚠ Each of these is three-valued in spirit: false here can mean "no" or
    // "we could not tell", so the rules must never read a false as evidence FOR
    // interrupting. They gate; they never trigger.
    known: !!(context && context.confidence && context.confidence.level !== 'low'),
    inMeeting: context ? context.activity === 'in-meeting' : false,
    quiet: context ? context.quiet === true : false,
    onDuty: context && context.duty ? context.duty.onDuty !== false : true,
    focusMode: phone ? phone.focusMode === true : false,
    // Moving under his own steam, or in a car. Both are "not now".
    moving: activity === 'Walking' || activity === 'Running' || activity === 'Cycling',
    driving: activity === 'Automotive',
    atLaptop,
    atDesk: atLaptop || stillSomewhere,
    inFocusSession: context ? context.activity === 'in-focus-session' : false,
  };
}

// ── The rules ────────────────────────────────────────────────────────────────
//
// One entry per observation kind. `when` returns true if THIS moment is a
// reasonable one to say this thing. Everything is subject to the universal
// vetoes below first, so these only describe the positive case.
//
// Each carries `say`, because the words are the other half of "sensitively" —
// the point is not to fire the same sentence the screen shows.

const RULES = {
  // Nick's own example, almost verbatim: at a desk, hours without a drink.
  'low-water': {
    when: m => m.atDesk && !m.moving,
    urgency: 'low',
    say: () => ({ title: 'SARA', body: 'You have not logged a drink in a while. Worth getting one.' }),
  },

  'not-eaten': {
    // Not while he is moving — he may well be on his way to get lunch.
    when: m => !m.moving,
    urgency: 'low',
    say: () => ({ title: 'SARA', body: 'Nothing logged for food today. Worth eating something.' }),
  },

  sedentary: {
    // Only worth saying if he is actually still there to hear it.
    when: m => m.atDesk,
    urgency: 'low',
    say: o => ({ title: 'SARA', body: `${o.text} ${o.suggestion || ''}`.trim() }),
  },

  'long-focus': {
    // He is at the laptop by definition, or the observation could not exist.
    when: m => m.atLaptop,
    urgency: 'low',
    say: o => ({ title: 'SARA', body: `${o.text} ${o.suggestion || ''}`.trim() }),
  },

  'no-exercise': {
    // ⚠ NOT mid-working-day. "You have not exercised in three days" delivered at
    // 11am on a Tuesday is a thing he can do nothing about, and a prompt he
    // cannot act on is the fastest way to teach him to ignore the channel.
    when: m => !m.onDuty || m.now.getHours() >= 17,
    urgency: 'low',
    say: o => ({ title: 'SARA', body: `${o.text} ${o.suggestion || ''}`.trim() }),
  },

  'health-signal': {
    // The one worth interrupting for on its own merits, and the only one allowed
    // during a focus session. Still never in a meeting.
    when: () => true,
    urgency: 'normal',
    say: o => ({
      title: 'SARA',
      // The caveat travels with it. Apple Health cannot separate exercise,
      // illness, alcohol and a hard week, and a push that drops the caveat is a
      // reading turned into a diagnosis on a lock screen.
      body: [o.text, o.detail, o.caveat].filter(Boolean).join(' — '),
    }),
  },
};

/**
 * Is this observation worth a push RIGHT NOW? PURE.
 *
 * Returns `{ push, why }` — the reason is always given, because a channel that
 * silently decides not to speak is indistinguishable from a broken one, and that
 * ambiguity is what `signals.js` exists to remove.
 */
function worthInterrupting(observation, moment) {
  if (!observation || !moment) return { push: false, why: 'nothing to judge' };
  const rule = RULES[observation.kind];
  if (!rule) return { push: false, why: `no push rule for ${observation.kind}` };

  // ── Universal vetoes ──────────────────────────────────────────────────────
  //
  // ⚠ UNKNOWN NEVER PUSHES. Every other part of this system may act on a
  // low-confidence read because the cost is a slightly wrong screen; here the
  // cost is his phone going off in a room where it should not. Fail closed.
  if (!moment.known) return { push: false, why: 'the situational read is not confident enough to interrupt' };

  // The one state where speaking up is wrong by default — context-state's own
  // rule, and it outranks everything including a health finding.
  if (moment.inMeeting) return { push: false, why: 'in a meeting' };

  // He has told the phone to leave him alone. That is more current and more
  // deliberate than anything inferred from his wrist.
  if (moment.focusMode) return { push: false, why: 'Focus mode is on' };

  if (moment.driving) return { push: false, why: 'driving' };

  // A focus session is the thing the rest of the system exists to protect. Only
  // something about his body gets through it.
  if (moment.inFocusSession && observation.kind !== 'health-signal') {
    return { push: false, why: 'in a focus session' };
  }

  // `quiet` is the brain's own judgement that now is not the moment. Honoured
  // rather than re-derived, or this becomes a second opinion about the same
  // question — which is what `state/inference.js` was retired for.
  if (moment.quiet) return { push: false, why: 'the brain has called this a quiet moment' };

  if (!rule.when(moment, observation)) {
    return { push: false, why: `not the moment for ${observation.kind}` };
  }

  return { push: true, why: null, urgency: rule.urgency, message: rule.say(observation) };
}

// ── Delivery ─────────────────────────────────────────────────────────────────

/**
 * Push whatever survives. Everything downstream of the decision is somebody
 * else's machinery, on purpose.
 *
 * ⚠ ONE per run at most. Not a cap for tidiness — three lock-screen prompts
 * arriving together read as an alarm rather than a nudge, and the fastest way to
 * lose this channel is to use it three times in a minute. The most urgent wins,
 * and the rest keep until the next pass or stay on the screen where they were
 * already visible. Nothing is lost by waiting: they are all still true.
 */
async function deliver({ now = new Date() } = {}) {
  if (!ENABLED) return { sent: 0, skipped: 'disabled' };

  const results = [];
  let observations = [];
  let moment = null;

  try {
    const attention = require('./attention');
    const { inputs } = await attention.gather();
    const context = require('./context-state').resolveContext(inputs);

    const ha = require('./ha');
    const phone = ha.isConfigured() ? await ha.getPhoneStatus() : null;
    const desktop = require('./desktop-activity').run(now);

    const ambient = await require('./ambient').build({ now, context });
    observations = ambient.observations || [];
    moment = momentFrom({ context, phone, desktop, now });
  } catch (e) {
    console.warn('[AmbientPush] Could not read the moment:', e.message);
    // ⚠ Refuses rather than guessing. Not knowing where he is is precisely when
    // an interruption is most likely to land badly.
    return { sent: 0, skipped: 'could not read the moment', why: e.message };
  }

  for (const observation of observations) {
    const verdict = worthInterrupting(observation, moment);
    results.push({ kind: observation.kind, ...verdict });
  }

  const winners = results.filter(r => r.push);
  if (!winners.length) return { sent: 0, considered: results };

  // Health findings outrank body-maintenance prompts.
  winners.sort((a, b) => (a.urgency === 'normal' ? -1 : 1) - (b.urgency === 'normal' ? -1 : 1));
  const chosen = winners[0];

  try {
    const webpush = require('./webpush');
    await webpush.sendToAll(chosen.message.title, chosen.message.body, {
      type: 'ambient',
      // ⚠ The identity is the OBSERVATION KIND, not the wording. "You have been
      // sitting for 2 hours" and "...for 3 hours" are the same interruption, and
      // keying on the text is exactly the bug the attention lifecycle was built
      // to fix for the meeting countdown.
      key: `ambient:${chosen.kind}`,
      url: '/?view=today',
    });
    return { sent: 1, chosen: chosen.kind, considered: results };
  } catch (e) {
    console.error('[AmbientPush] Send failed:', e.message);
    return { sent: 0, error: e.message, considered: results };
  }
}

module.exports = {
  momentFrom,
  worthInterrupting,
  deliver,
  RULES,
  ENABLED,
  DRY_HOURS,
};
