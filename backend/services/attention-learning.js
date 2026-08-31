'use strict';

/**
 * What SARA learns from whether her prompts actually helped.
 *
 * Nick, 31 Aug 2026: *"SARA also needs to learn — what do I ignore, what do I
 * respond to, how can she help me better."* Then, on what she should do about
 * it: *"I think she goes quiet — but I need to know somehow. Maybe SARA should
 * initiate and run the End of Day routine — she can tell me there what I've
 * ignored and what she's muted, and I can ask her to resume any I want."*
 *
 * So: she quietens herself, and the EOD is where that is confessed and undone.
 * That is what makes going quiet safe — a system that mutes itself silently is
 * indistinguishable from one that has broken, which is the failure `signals.js`
 * exists to make impossible.
 *
 * ── ⚠ MEASURE THE OUTCOME, NOT HIS ATTENTION ────────────────────────────────
 * The obvious measure is "did he open the app after the prompt". It is WRONG,
 * and water is the case that proves it: he gets a glass and does not log it.
 * "Ignored" and "acted on and never told me" are indistinguishable that way —
 * and it is exactly the signal he most wants tuned.
 *
 * It would also break a rule this codebase already holds twice over: *a missed
 * check-in means nothing, being heads-down is why one gets skipped*
 * (`focus-session`), and `friction.js` refuses to read absence at all.
 *
 * So the question is never "did he respond". It is **did the world change** —
 * measured from sensors SARA already reads:
 *
 *   sedentary     did `apple_stand_time` appear in the next hour?      MEASURABLE
 *   no-exercise   did exercise minutes appear within two days?         MEASURABLE
 *   long-focus    did the foreground app change, or go idle?           MEASURABLE
 *   low-water     did a `dietary_water` sample appear?      only if he is logging
 *   not-eaten     did `dietary_energy_consumed` appear?     only if he is logging
 *   health-signal not that kind of prompt                            NEVER JUDGED
 *
 * ⚠ **UNMEASURABLE IS NOT IGNORED.** If the outcome cannot be seen, the delivery
 * is recorded and scored as nothing at all. It does not count towards muting, in
 * either direction. Counting it as a failure would mute the water prompt for the
 * precise reason it is working — he drank and did not log it — which is the
 * dumbest possible thing this file could do.
 *
 * ── Muting is conservative, and it is never silent ──────────────────────────
 * `MIN_JUDGED` before an opinion exists at all, and a rate low enough that it is
 * not a run of bad luck. A mute stops the PUSH and never hides the observation:
 * it still renders on the Surface, the widget and Now. That is
 * `attention-lifecycle`'s acknowledged rule — seen means it stops asking, not
 * that it disappears.
 *
 * PURE where it judges: `outcomeWindow`, `rate` and `shouldMute` take plain data
 * and a clock. Only the recording and the sweep read or write.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');

const STATE_KEY = 'attention_learning';

// How many JUDGED deliveries before there is an opinion worth acting on. Low
// enough to learn inside a month at this cadence, high enough that three bad
// days do not mute something useful.
const MIN_JUDGED = 8;

// Below this it is not helping. Deliberately not 0 — a prompt that works one
// time in three is still worth keeping, because the times it works are the whole
// point and the cost of the others is one line on a lock screen.
const MUTE_BELOW = 0.2;

// How long the record is kept. Long enough to see a habit, short enough that a
// change in his life is not argued with by last spring's data.
const RETAIN_DAYS = 120;

/** Per kind: how long after the prompt the world has to change, and how. */
const OUTCOMES = {
  sedentary: { windowMinutes: 60, metric: 'apple_stand_time', measurable: true },
  'no-exercise': { windowMinutes: 48 * 60, metric: 'apple_exercise_time', measurable: true },
  'long-focus': { windowMinutes: 30, metric: null, measurable: true, kind: 'desktop-switch' },
  'low-water': { windowMinutes: 120, metric: 'dietary_water', measurable: 'if-logging' },
  'not-eaten': { windowMinutes: 180, metric: 'dietary_energy_consumed', measurable: 'if-logging' },
  // ⚠ Never judged. "Your resting heart rate has been up for three days" is not
  // a prompt with an action attached, so scoring it on whether anything changed
  // would mute the one signal most worth interrupting for.
  'health-signal': { measurable: false },
};

// ── Pure ─────────────────────────────────────────────────────────────────────

/** When a delivery of this kind stops waiting for an answer. PURE. */
function outcomeWindow(kind, at) {
  const rule = OUTCOMES[kind];
  if (!rule || !rule.windowMinutes) return null;
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  return new Date(t + rule.windowMinutes * 60000).toISOString();
}

/** The measured success rate for one kind. PURE.
 *
 *  ⚠ `judged` counts only deliveries whose outcome could be SEEN. `unmeasured`
 *  is reported separately and never folded in — a rate computed over deliveries
 *  we could not judge is a number with no meaning that looks exactly like one
 *  with meaning. */
function rate(entries = []) {
  const judged = entries.filter(e => e && (e.outcome === 'worked' || e.outcome === 'no-change'));
  const worked = judged.filter(e => e.outcome === 'worked').length;
  const unmeasured = entries.filter(e => e && e.outcome === 'unmeasurable').length;
  const pending = entries.filter(e => e && e.outcome === 'pending').length;
  return {
    delivered: entries.length,
    judged: judged.length,
    worked,
    unmeasured,
    pending,
    // null, not 0. "Nothing judged yet" and "judged and never worked" are
    // opposite facts about whether SARA is allowed to have an opinion.
    rate: judged.length ? Number((worked / judged.length).toFixed(2)) : null,
  };
}

/**
 * Should this kind be muted? PURE.
 *
 * Returns `{ mute, why }`. `why` is always populated on a mute, because it is
 * read aloud in the EOD — a mute Nick cannot hear the reason for is one he
 * cannot sensibly overrule.
 */
function shouldMute(kind, stats) {
  const rule = OUTCOMES[kind];
  if (!rule || rule.measurable === false) {
    return { mute: false, why: 'this kind is never judged on outcomes' };
  }
  if (!stats || stats.judged < MIN_JUDGED) {
    return { mute: false, why: `only ${stats ? stats.judged : 0} of ${MIN_JUDGED} judged so far` };
  }
  if (stats.rate == null || stats.rate > MUTE_BELOW) return { mute: false, why: 'it is helping' };
  return {
    mute: true,
    why: `${stats.worked} of ${stats.judged} times it made any difference`,
  };
}

// ── State ────────────────────────────────────────────────────────────────────

function _load() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return { deliveries: [], muted: {} };
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return {
      deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
      muted: parsed.muted && typeof parsed.muted === 'object' ? parsed.muted : {},
    };
  } catch (e) {
    console.error('[AttentionLearning] Could not read:', e.message);
    return { deliveries: [], muted: {} };
  }
}

function _save(state) {
  const cutoff = Date.now() - RETAIN_DAYS * 86400000;
  db.setState(STATE_KEY, JSON.stringify({
    deliveries: state.deliveries.filter(d => Date.parse(d.at) >= cutoff),
    muted: state.muted || {},
  }));
}

/** SARA said something. Recorded pending; the sweep decides whether it helped. */
function recordDelivery(kind, at = new Date().toISOString()) {
  const state = _load();
  state.deliveries.push({ kind, at, outcome: 'pending', judgeAfter: outcomeWindow(kind, at) });
  _save(state);
}

function isMuted(kind) {
  const muted = _load().muted[kind];
  return !!(muted && muted.until !== 'never');
}

/** Everything muted, with why and when — what the EOD reads out. */
function mutedList() {
  const state = _load();
  return Object.entries(state.muted).map(([kind, m]) => ({
    kind,
    why: m.why || null,
    at: m.at || null,
    by: m.by || 'sara',
    stats: rate(state.deliveries.filter(d => d.kind === kind)),
  }));
}

function mute(kind, why, by = 'sara') {
  const state = _load();
  state.muted[kind] = { why: why || null, at: new Date().toISOString(), by };
  _save(state);
  return { ok: true, kind, why };
}

/** The way back. Clears the mute AND the history that produced it — otherwise
 *  the same evidence re-mutes it on the next sweep and his instruction lasts one
 *  night. Same shape as `task-blocks.release()`: an escape hatch that does not
 *  actually let you out is not one. */
function unmute(kind) {
  const state = _load();
  if (!state.muted[kind]) return { ok: false, reason: 'not muted' };
  delete state.muted[kind];
  state.deliveries = state.deliveries.filter(d => d.kind !== kind);
  _save(state);
  return { ok: true, kind };
}

/** Per-kind stats, for the EOD and for anything that wants to explain itself. */
function summary() {
  const state = _load();
  const kinds = [...new Set(state.deliveries.map(d => d.kind))];
  return kinds.map(kind => ({
    kind,
    muted: !!state.muted[kind],
    ...rate(state.deliveries.filter(d => d.kind === kind)),
  }));
}

// ── The sweep ────────────────────────────────────────────────────────────────

/**
 * Judge every delivery whose window has closed, then mute anything that has
 * earned it.
 *
 * ⚠ Never mutes something Nick has UNMUTED by hand in the same window — his
 * instruction outranks the measurement, and a system that re-mutes what he just
 * turned back on has not learned anything, it has just argued with him.
 * `unmute` clears the history, which is what makes that true without a flag.
 */
function sweep(now = new Date()) {
  const state = _load();
  let judged = 0;
  const muted = [];

  for (const delivery of state.deliveries) {
    if (delivery.outcome !== 'pending') continue;
    if (!delivery.judgeAfter || Date.parse(delivery.judgeAfter) > now.getTime()) continue;

    delivery.outcome = _judge(delivery);
    judged += 1;
  }

  for (const kind of [...new Set(state.deliveries.map(d => d.kind))]) {
    if (state.muted[kind]) continue;
    const stats = rate(state.deliveries.filter(d => d.kind === kind));
    const verdict = shouldMute(kind, stats);
    if (verdict.mute) {
      state.muted[kind] = { why: verdict.why, at: now.toISOString(), by: 'sara' };
      muted.push({ kind, why: verdict.why });
      console.log(`[AttentionLearning] Muting "${kind}" — ${verdict.why}`);
    }
  }

  _save(state);
  return { judged, muted };
}

/** Did the world change after this prompt? Returns worked / no-change /
 *  unmeasurable. Failures return `unmeasurable`, never `no-change` — a reading
 *  we could not take must not count against the prompt. */
function _judge(delivery) {
  const rule = OUTCOMES[delivery.kind];
  if (!rule || rule.measurable === false) return 'unmeasurable';

  const from = delivery.at;
  const to = delivery.judgeAfter;

  try {
    if (rule.kind === 'desktop-switch') {
      const desk = require('./desktop-activity');
      const samples = desk.samples().filter(s => s.at > from && s.at <= to);
      if (!samples.length) return 'unmeasurable';
      // Any app other than the one he was in, or going idle, counts as a break.
      const changed = samples.some(s => !s.app || s.idleSeconds > 600);
      return changed ? 'worked' : 'no-change';
    }

    if (!rule.metric) return 'unmeasurable';

    // ⚠ For the diet prompts, an absent sample is only evidence if he was
    // logging in the first place. Otherwise it is the "not logged is not not
    // done" rule, and scoring it would mute the prompt for working.
    if (rule.measurable === 'if-logging') {
      const recent = db.getHealthSamples(rule.metric, new Date(Date.parse(from) - 7 * 86400000).toISOString(), 200) || [];
      const loggedDays = new Set(recent.map(r => String(r.recorded_at).slice(0, 10)));
      if (loggedDays.size < 2) return 'unmeasurable';
    }

    const after = (db.getHealthSamples(rule.metric, from, 200) || [])
      .filter(r => r.recorded_at <= to && Number(r.value) > 0);
    return after.length ? 'worked' : 'no-change';
  } catch (e) {
    console.warn(`[AttentionLearning] Could not judge ${delivery.kind}:`, e.message);
    return 'unmeasurable';
  }
}

module.exports = {
  // pure
  outcomeWindow,
  rate,
  shouldMute,
  // stateful
  recordDelivery,
  isMuted,
  mutedList,
  mute,
  unmute,
  summary,
  sweep,
  // constants
  OUTCOMES,
  MIN_JUDGED,
  MUTE_BELOW,
  RETAIN_DAYS,
};
