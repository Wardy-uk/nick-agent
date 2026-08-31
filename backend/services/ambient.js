'use strict';

/**
 * Ambient observations — what SARA can notice about Nick's body and his day.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Nick, 31 Aug 2026: she should behave like J.A.R.V.I.S. — sat down at home on a
 * weekend, suggest getting up; a health metric worth noting, tell him; not eaten
 * in a while, suggest lunch; not exercised, poke him for a walk.
 *
 * The brain for that already existed. `context-state` resolves nine situational
 * states and `attention.gate()` decides what is worth surfacing. What was
 * missing was inputs — and, measured on 31 Aug, most of the inputs were already
 * in the house:
 *
 *   · the HA Companion app had been reporting `activity` (the CoreMotion
 *     Still / Walking / Running / Automotive classification), steps, floors and
 *     Focus mode all along — NEURO was reading the wrong entity ids for five
 *     weeks and blamed the phone for going quiet.
 *   · `health_daily` holds 743 complete days; `health-signals` already computes
 *     RHR / HRV / wrist-temp / sleep-debt trends AND NOTHING CONSUMED THEM.
 *   · dietary energy and water are ALREADY in `health_samples` — MyFitnessPal
 *     writes to Apple Health and NEURO already ingests Apple Health. No API
 *     integration was ever needed.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * ⚠ It adds no candidates to `decision-engine` and re-ranks nothing. It produces
 * OBSERVATIONS — things that are true about right now — and hands them over.
 * `decision-engine` stays the one place something becomes worth surfacing and
 * `attention.gate()` the one place it is filtered, exactly as `attention.js`
 * says. This is a sensor, not a second brain; `sara/backend/state/inference.js`
 * was retired for being the latter.
 *
 * ⚠ NOTHING HERE NOTIFIES. Pull only, first release. Six new interruption
 * sources is precisely how SARA becomes a pest and gets muted, after which none
 * of the rest matters — nudge volume is the one budget allowed to argue against
 * building more. Earn the push once the observations have been read for a while
 * and found to be right.
 *
 * ── The rule the whole file turns on ────────────────────────────────────────
 * ⚠ **NOT LOGGED IS NOT NOT DONE.** This is the difference between a useful
 * observation and a daily lie. `dietary_energy_consumed` last has a sample on
 * 30 Mar 2026 and `dietary_water` on 3 Feb 2025 — so "no food logged today" is
 * true every single day, and a naive read would tell Nick he has not eaten every
 * lunchtime for five months. The signal is only meaningful when he is ACTUALLY
 * LOGGING, so each diet observation first asks whether the habit is live
 * (`LOGGING_DAYS_REQUIRED` of the trailing window) and reports `unknown` with
 * the reason when it is not. Same species as "an unread domain is structurally
 * empty and null, never 0", applied to a habit rather than a feed.
 *
 * The same rule, differently dressed, is why a sedentary read needs
 * `lastReportAt`: a phone that is switched off and a phone reporting `Still`
 * look identical if you only read the value.
 *
 * PURE where it judges. `assess()` takes plain data and a clock and returns the
 * observations, so every threshold and every refusal pins without a database,
 * a phone or a network — the `pi-health.assess()` / `state-of-play.assess()`
 * split. Only `build()` reads.
 *
 * CommonJS — NEURO backend convention.
 */

// ── Thresholds ───────────────────────────────────────────────────────────────

// How stale a phone reading may be before it stops describing NOW. The
// Companion app reports on significant change rather than on a timer, so a
// genuinely motionless hour is quiet by design — battery keeps ticking, which is
// why `lastReportAt` includes it.
const PHONE_FRESH_MINUTES = 45;

// How long sitting still stops being a pause and starts being worth a word.
// Deliberately long. A 20-minute floor would fire during every meeting, every
// meal and every film.
const SEDENTARY_MINUTES = 90;

// Exercise. Judged against his OWN recent behaviour, never a public guideline —
// the `stress-score` rule: an absolute threshold is a fact about the population,
// not about Nick.
const EXERCISE_QUIET_DAYS = 3;
const EXERCISE_DAY_MINUTES = 15;   // what counts as "a day with exercise in it"
const EXERCISE_BASELINE_DAYS = 28;
const EXERCISE_BASELINE_MIN_ACTIVE = 4;  // he must normally move, or this says nothing

// Food and water. `LOGGING_DAYS_REQUIRED` is the load-bearing one — see the
// header. Two of the last seven days is a low bar on purpose: it only has to
// establish that the habit exists at all.
const DIET_WINDOW_DAYS = 7;
const LOGGING_DAYS_REQUIRED = 2;
const LUNCH_HOUR = 13;      // before this, "not eaten today" is just morning
const EVENING_HOUR = 20;    // after this, a missed water target is history

const WATER_TARGET_ML = 1500;

// ── The Apple Watch stand read ───────────────────────────────────────────────
//
// ⚠ RAW ACCELEROMETER IS NOT AVAILABLE and never will be from here. HealthKit
// exposes no raw motion type; the Watch's CoreMotion stream is reachable only by
// an app running ON the watch and is never written to Health. So "can SARA read
// the accelerometer" is no — but Apple has already done the processing, and
// `apple_stand_time` IS the accelerometer-derived answer to the question that
// was actually being asked.
//
// Shape, measured: HOURLY buckets, value = minutes stood in that hour, and an
// hour with no standing has NO ROW AT ALL. ⚠ That absence is the trap — it means
// "did not stand" and "watch was off charging" identically.
//
// `heartRate` is the corroboration. Measured over 32 live hours it arrives
// 13-19 samples an hour, continuously, including all night (he sleeps in the
// watch — hence the sleep stages and wrist temperature). So a missing stand hour
// WITH heart rate in it is a real hour of sitting; a missing stand hour with no
// heart rate is a watch that was off, and is unknown rather than sedentary.
//
// This outranks the phone's `activity` for one plain reason: the watch is on his
// body and the phone might be on a desk in another room. Live proof on the day
// this was built — the watch reported at 09:00 while the phone was 14 hours
// stale. The phone stays as a fallback, and which source answered is always
// named.
const STAND_MINUTES_FLOOR = 1;   // a row at all means he got up
const STAND_QUIET_HOURS = 2;     // Apple's own reminder fires at 1h; don't compete with it
const HR_SAMPLES_WORN = 3;       // below this the watch was not on the wrist

const MAX_OBSERVATIONS = 4;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _minutesSince(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 60000);
}

function _phrase(minutes) {
  if (minutes == null) return null;
  if (minutes < 120) return `${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m >= 15 ? `${h}h ${m}m` : `${h} hours`;
}

/**
 * Is a logging habit actually live? PURE.
 *
 * `days` is a list of `{ day, value }`. A habit counts as live when at least
 * `LOGGING_DAYS_REQUIRED` of the trailing window carry a reading. Returns the
 * reason when it does not, because "he has not logged food since March" and
 * "he has not eaten today" are completely different statements and only one of
 * them is SARA's business.
 */
function loggingHabit(days = [], { required = LOGGING_DAYS_REQUIRED, label = 'this' } = {}) {
  const logged = days.filter(d => d && Number(d.value) > 0);
  if (logged.length >= required) return { live: true, loggedDays: logged.length };
  return {
    live: false,
    loggedDays: logged.length,
    why: logged.length === 0
      ? `nothing logged for ${label} in the last ${days.length} days — can't tell a missed day from a missed habit`
      : `only ${logged.length} of the last ${days.length} days logged for ${label} — not enough to read a gap`,
  };
}

/**
 * How many completed hours he has been sitting, per the Watch. PURE.
 *
 * `hours` is newest-first `[{ hour, standMinutes, hrSamples, asleep }]`, one
 * entry per clock hour, INCLUDING hours with no stand data (standMinutes 0) —
 * the caller must fill those in, because an absent row is the whole signal and
 * a gappy array cannot be told from a short one.
 *
 * Walks back from the last COMPLETED hour. The current hour is partial: it may
 * be four minutes old, and reading a partial hour as "no standing" would report
 * a sedentary run at one minute past every hour.
 *
 * Returns `{ known, hours, why }`. Three distinct answers, and keeping them
 * apart is the point:
 *   known:true,  hours:N  — he sat for N hours and the watch was on for all of them
 *   known:true,  hours:0  — he got up; nothing to say
 *   known:false, why      — the watch was off, or there is no data to read
 */
function standStillness(hours = [], now = new Date()) {
  if (!hours.length) return { known: false, hours: 0, why: 'no stand data' };

  const currentHourKey = _hourKey(now);
  let counted = 0;

  for (const h of hours) {
    if (!h || h.hour === currentHourKey) continue;   // skip the partial hour

    // Asleep is not sitting. Skipped entirely rather than counted or treated as
    // unknown — it is simply not the question, and counting a night in bed as
    // eight hours of sitting is the most obvious way to make this useless.
    if (h.asleep) {
      // A night BREAKS the run: the morning is a fresh start, not a
      // continuation of yesterday evening.
      if (counted > 0) break;
      continue;
    }

    // ⚠ Was the watch even on? Without this a watch left on charge reads as
    // perfect stillness, which is the same failure as a switched-off phone
    // reporting `Still`.
    if (!(Number(h.hrSamples) >= HR_SAMPLES_WORN)) {
      if (counted > 0) break;   // the run ends where the evidence ends
      return { known: false, hours: 0, why: `the watch was not being worn at ${h.hour}` };
    }

    if (Number(h.standMinutes) >= STAND_MINUTES_FLOOR) break;  // he got up
    counted += 1;
  }

  return { known: true, hours: counted };
}

/** `YYYY-MM-DD HH`, matching the SQL substring the hourly rollup is keyed on. */
function _hourKey(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}`;
}

// ── The judgement ────────────────────────────────────────────────────────────

/**
 * Turn readings into what can honestly be said about them. PURE.
 *
 * @param {object} input
 *   `phone`       getPhoneStatus() shape, or null
 *   `days`        health_daily rows, newest first
 *   `dietEnergy`  [{day, value}] trailing dietary_energy_consumed, newest first
 *   `water`       [{day, value}] trailing dietary_water in ml, newest first
 *   `signals`     health-signals snapshot ({findings, unknowns}) or null
 *   `duty`        context-state duty block, or null
 *   `inMeeting`   boolean — a meeting is the one state where speaking up is wrong
 * @param {Date} now
 */
function assess(input = {}, now = new Date()) {
  const observations = [];
  const unknowns = [];

  const phone = input.phone || null;
  const days = Array.isArray(input.days) ? input.days : [];
  const signals = input.signals || null;

  // ── Is the phone even talking to us? ──────────────────────────────────────
  //
  // Everything phone-derived depends on this, so it is asked once. A stale
  // phone is an UNKNOWN, never a still one.
  const phoneAgeMin = _minutesSince(phone?.lastReportAt, now);
  const phoneLive = phoneAgeMin != null && phoneAgeMin <= PHONE_FRESH_MINUTES;
  if (phone && !phoneLive) {
    unknowns.push({
      input: 'phone',
      why: phoneAgeMin == null
        ? 'the phone has never reported'
        : `the phone last reported ${_phrase(phoneAgeMin)} ago — too old to say what you're doing now`,
    });
  } else if (!phone) {
    unknowns.push({ input: 'phone', why: 'Home Assistant could not be read' });
  }

  // ── Sat still a long time ─────────────────────────────────────────────────
  //
  // TWO sources, and the WATCH is preferred: it is on his body, and the phone
  // might be on a desk in another room. Which one answered is always named — a
  // reading whose provenance is invisible cannot be argued with.
  //
  // ⚠ Focus mode vetoes the nudge whichever source found it. He has explicitly
  // told the phone to leave him alone, and that is a more current and more
  // deliberate statement than anything this file can infer from his wrist.
  const stand = standStillness(input.standHours || [], now);
  if (!stand.known) unknowns.push({ input: 'watch', why: stand.why });

  const focusVeto = phone?.focusMode === true;
  let sat = null;

  if (stand.known && stand.hours >= STAND_QUIET_HOURS) {
    sat = {
      text: `You've been sitting for ${stand.hours} hours.`,
      because: `your watch has logged no standing for ${stand.hours} full hours`,
      evidence: [{ source: 'watch', ref: 'apple_stand_time', detail: `${stand.hours}h with no stand minutes` }],
    };
  } else if (!stand.known && phoneLive) {
    // Fallback only. The phone answers the same question worse, so it is asked
    // second and only when the watch could not answer at all.
    const stillFor = phone.activity === 'Still' ? _minutesSince(phone.activitySince, now) : null;
    if (stillFor != null && stillFor >= SEDENTARY_MINUTES) {
      sat = {
        text: `You've been sitting for ${_phrase(stillFor)}.`,
        because: `the phone has read Still since ${phone.activitySince} — your watch didn't answer`,
        evidence: [{ source: 'ha', ref: 'sensor.activity', observedAt: phone.activitySince, detail: `Still for ${stillFor} min` }],
      };
    }
  }

  if (sat && !focusVeto) {
    observations.push({
      kind: 'sedentary',
      level: 'nudge',
      // Says what it saw, not what he should feel about it.
      text: sat.text,
      suggestion: input.duty?.onDuty === false
        ? 'Worth getting up — a walk, or something round the house.'
        : 'Worth standing up for a few minutes.',
      because: sat.because,
      evidence: sat.evidence,
      weight: 2,
    });
  }

  // ── Not exercised in a while ──────────────────────────────────────────────
  //
  // Judged against his own recent behaviour. `EXERCISE_BASELINE_MIN_ACTIVE`
  // means a person who never records exercise is never told he has stopped —
  // there is no habit to have broken, and saying so would be inventing a
  // standard he never set.
  const withExercise = days.filter(d => d && d.complete && d.exerciseMinutes != null);
  if (withExercise.length === 0) {
    unknowns.push({ input: 'exercise', why: 'no exercise minutes recorded' });
  } else {
    const baseline = withExercise.slice(0, EXERCISE_BASELINE_DAYS);
    const activeInBaseline = baseline.filter(d => d.exerciseMinutes >= EXERCISE_DAY_MINUTES).length;
    if (activeInBaseline >= EXERCISE_BASELINE_MIN_ACTIVE) {
      // Complete days only — today is half a day and cannot count as a gap.
      const recent = withExercise.slice(0, EXERCISE_QUIET_DAYS);
      const quiet = recent.length === EXERCISE_QUIET_DAYS
        && recent.every(d => d.exerciseMinutes < EXERCISE_DAY_MINUTES);
      if (quiet) {
        observations.push({
          kind: 'no-exercise',
          level: 'nudge',
          text: `No real exercise for ${EXERCISE_QUIET_DAYS} days.`,
          suggestion: 'A walk would do it — you normally manage more than this.',
          because: `${activeInBaseline} of your last ${baseline.length} days had ${EXERCISE_DAY_MINUTES}+ minutes`,
          evidence: recent.map(d => ({ source: 'health', ref: d.day, detail: `${Math.round(d.exerciseMinutes)} min` })),
          weight: 1,
        });
      }
    }
  }

  // ── Something in the health data worth saying ─────────────────────────────
  //
  // Pass-through, NOT re-derived. `health-signals` owns what counts as a trend
  // and carries a caveat on every finding precisely because Apple Health cannot
  // separate exercise, illness, alcohol and a hard week. The caveat travels with
  // it — dropping it is how a reading becomes a diagnosis.
  if (signals) {
    for (const f of (signals.findings || [])) {
      // ⚠ A STOPPED SENSOR IS AN UNKNOWN, NOT AN OBSERVATION.
      //
      // `health-signals` reports both trends ("resting heart rate up for three
      // days") and quiet sensors ("blood pressure stopped arriving in April"),
      // and both are worth having — but only the first is a fact about TODAY.
      // Caught on the first live run: all four observation slots were filled by
      // quiet-sensor findings, three more were dropped to the cap, and every one
      // of them would have rendered identically every day for ever. That is the
      // screen nobody reads by week two, and it was crowding out the trends this
      // exists to surface.
      //
      // They belong in `unknowns`, which is exactly what they are — "I can't see
      // your blood pressure any more" — so they stay visible without pretending
      // to be news. The stopped-sensor report has a proper home on the Health
      // panel, where it is a data-quality question rather than an ambient one.
      if (String(f.id || '').startsWith('quiet:')) {
        unknowns.push({ input: `health:${f.id}`, why: f.detail || f.title });
        continue;
      }
      observations.push({
        kind: 'health-signal',
        level: f.level === 'warn' ? 'notice' : 'info',
        text: f.title,
        detail: f.detail || null,
        caveat: f.caveat || null,
        because: 'a trend against your own baseline',
        evidence: (f.evidence || []).slice(0, 3).map(e => ({ source: 'health', ref: e.day, detail: JSON.stringify(e) })),
        weight: 3,
      });
    }
    for (const u of (signals.unknowns || [])) unknowns.push({ input: `health:${u.input}`, why: u.why });
  } else {
    unknowns.push({ input: 'health-signals', why: 'could not be read' });
  }

  // ── Food ──────────────────────────────────────────────────────────────────
  //
  // ⚠ The habit check comes FIRST and is the point. Without it this says "you
  // haven't eaten" every lunchtime for as long as he is not logging, which is
  // both wrong and the fastest possible way to get SARA muted.
  const dietEnergy = Array.isArray(input.dietEnergy) ? input.dietEnergy : [];
  const foodHabit = loggingHabit(dietEnergy.slice(0, DIET_WINDOW_DAYS), { label: 'food' });
  if (!foodHabit.live) {
    unknowns.push({ input: 'food', why: foodHabit.why });
  } else if (now.getHours() >= LUNCH_HOUR && !input.inMeeting) {
    const todayKey = _dayKey(now);
    const todayEnergy = dietEnergy.find(d => d.day === todayKey);
    if (!todayEnergy || !(todayEnergy.value > 0)) {
      observations.push({
        kind: 'not-eaten',
        level: 'nudge',
        text: 'Nothing logged for food today.',
        suggestion: 'Worth eating something.',
        because: `you logged food on ${foodHabit.loggedDays} of the last ${DIET_WINDOW_DAYS} days, so a blank today means something`,
        evidence: [{ source: 'health', ref: 'dietary_energy_consumed', detail: 'no sample today' }],
        weight: 2,
      });
    }
  }

  // ── Water ─────────────────────────────────────────────────────────────────
  const water = Array.isArray(input.water) ? input.water : [];
  const waterHabit = loggingHabit(water.slice(0, DIET_WINDOW_DAYS), { label: 'water' });
  if (!waterHabit.live) {
    unknowns.push({ input: 'water', why: waterHabit.why });
  } else if (now.getHours() >= LUNCH_HOUR && now.getHours() < EVENING_HOUR) {
    const todayKey = _dayKey(now);
    const todayWater = water.find(d => d.day === todayKey);
    const ml = todayWater ? Number(todayWater.value) || 0 : 0;
    if (ml < WATER_TARGET_ML) {
      observations.push({
        kind: 'low-water',
        level: 'info',
        text: ml > 0 ? `${Math.round(ml)}ml of water logged today.` : 'No water logged today.',
        suggestion: 'Have a glass.',
        because: `you normally log it — ${waterHabit.loggedDays} of the last ${DIET_WINDOW_DAYS} days`,
        evidence: [{ source: 'health', ref: 'dietary_water', detail: `${Math.round(ml)}ml` }],
        weight: 0,
      });
    }
  }

  // ── Too long at one thing ─────────────────────────────────────────────────
  //
  // Nick's own example: four hours in VS Code. Nothing else NEURO holds can see
  // it — the phone knows where he is, the watch knows whether he is sitting, the
  // calendar knows whether a meeting is running, and none of them can tell four
  // hours of one job from four hours of twelve.
  //
  // Passed in already judged by `desktop-activity`, which owns the reminder
  // interval too: this is polled by several surfaces and a fresh observation on
  // every poll would be the same line over and over.
  if (input.longFocus) observations.push(input.longFocus);

  // ── Ordering and the cap ──────────────────────────────────────────────────
  //
  // Health findings outrank body-maintenance prompts: "your resting heart rate
  // has been up for three days" is worth more of his attention than a glass of
  // water, and a cap that dropped it in favour of one would be the wrong way
  // round.
  observations.sort((a, b) => b.weight - a.weight);

  return {
    // ⚠ An empty list is a correct and common answer, and must not be padded
    // with a reassuring line. `allClear` is only true when nothing went unread
    // either — "nothing to say" and "I couldn't look" are different facts.
    observations: observations.slice(0, MAX_OBSERVATIONS),
    dropped: Math.max(0, observations.length - MAX_OBSERVATIONS),
    unknowns,
    allClear: observations.length === 0 && unknowns.length === 0,
    phoneLive,
  };
}

/** Local day key. Never toISOString() — the Pi may run in UTC. */
function _dayKey(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Gather the inputs and assess them. Every source is independently guarded and
 * a failure becomes a NAMED gap rather than a quiet absence — a sedentary read
 * that silently reports nothing because HA was unreachable is indistinguishable
 * from one that looked and found him moving.
 */
async function build({ now = new Date(), context = null } = {}) {
  const gaps = [];

  let phone = null;
  try {
    const ha = require('./ha');
    if (ha.isConfigured()) phone = await ha.getPhoneStatus();
    else gaps.push({ source: 'ha', why: 'Home Assistant is not configured' });
  } catch (e) {
    gaps.push({ source: 'ha', why: e.message });
  }

  let days = [];
  try {
    days = require('./health-daily').recentDays(EXERCISE_BASELINE_DAYS + 2);
  } catch (e) {
    gaps.push({ source: 'health-daily', why: e.message });
  }

  let signals = null;
  try {
    signals = require('./health-signals').snapshot();
  } catch (e) {
    gaps.push({ source: 'health-signals', why: e.message });
  }

  const standHours = _standHours(now, gaps);

  const dietEnergy = _dailyTotals('dietary_energy_consumed', DIET_WINDOW_DAYS, now, gaps);
  const water = _dailyTotals('dietary_water', DIET_WINDOW_DAYS, now, gaps);

  // ⚠ Read AFTER everything else and never allowed to fail the build: the
  // desktop agent is the one input that lives on a machine NEURO does not
  // control, so it is the most likely to be absent, and its absence must cost
  // nothing but itself.
  let longFocus = null;
  try {
    longFocus = require('./desktop-activity').longRunObservation(now);
  } catch (e) {
    gaps.push({ source: 'desktop', why: e.message });
  }

  const assessed = assess({
    phone,
    standHours,
    longFocus,
    days,
    dietEnergy,
    water,
    signals,
    duty: context?.duty || null,
    inMeeting: context?.activity === 'in-meeting',
  }, now);

  return {
    generatedAt: now.toISOString(),
    ...assessed,
    gaps,
    // Same rule as friction: an empty observation list under a non-empty `gaps`
    // means "I could not look", not "there is nothing to say".
    complete: gaps.length === 0,
  };
}

/**
 * The last 12 hours as `{ hour, standMinutes, hrSamples, asleep }`, newest first.
 *
 * ⚠ EVERY hour is emitted, including the ones with no stand row — the absence IS
 * the signal, and a sparse array cannot be told from a short one by the pure
 * reader. Twelve hours is comfortably more than any run worth reporting and
 * keeps the query small.
 */
function _standHours(now, gaps) {
  try {
    const db = require('../db/database');
    const since = new Date(now.getTime() - 13 * 3600000).toISOString();

    const bucket = (metric) => {
      const out = new Map();
      for (const r of (db.getHealthSamples(metric, since, 20000) || [])) {
        const t = new Date(r.recorded_at);
        if (Number.isNaN(t.getTime())) continue;
        const key = _hourKey(t);
        out.set(key, (out.get(key) || 0) + (Number(r.value) || 0));
      }
      return out;
    };
    const count = (metric) => {
      const out = new Map();
      for (const r of (db.getHealthSamples(metric, since, 20000) || [])) {
        const t = new Date(r.recorded_at);
        if (Number.isNaN(t.getTime())) continue;
        const key = _hourKey(t);
        out.set(key, (out.get(key) || 0) + 1);
      }
      return out;
    };

    const standBy = bucket('apple_stand_time');
    const hrBy = count('heartRate');
    // Any sleep stage in the hour means he was in bed for some of it, which is
    // enough — a part-slept hour is not an hour of sitting at a desk.
    const asleepBy = new Map();
    for (const m of ['sleep_asleep_core_hours', 'sleep_asleep_deep_hours', 'sleep_asleep_rem_hours', 'sleep_asleep_unspecified_hours']) {
      for (const [k, v] of bucket(m)) if (v > 0) asleepBy.set(k, true);
    }

    const out = [];
    for (let i = 0; i < 12; i += 1) {
      const d = new Date(now.getTime() - i * 3600000);
      const key = _hourKey(d);
      out.push({
        hour: key,
        standMinutes: standBy.get(key) || 0,
        hrSamples: hrBy.get(key) || 0,
        asleep: asleepBy.get(key) === true,
      });
    }
    return out;
  } catch (e) {
    gaps.push({ source: 'apple_stand_time', why: e.message });
    return [];
  }
}

/** Trailing per-day totals for one health metric, newest first. */
function _dailyTotals(metric, windowDays, now, gaps) {
  try {
    const db = require('../db/database');
    const since = new Date(now.getTime() - windowDays * 86400000).toISOString();
    const rows = db.getHealthSamples(metric, since, 5000) || [];
    const byDay = new Map();
    for (const r of rows) {
      const t = new Date(r.recorded_at);
      if (Number.isNaN(t.getTime())) continue;
      const key = _dayKey(t);
      byDay.set(key, (byDay.get(key) || 0) + (Number(r.value) || 0));
    }
    // Every day in the window, including the empty ones — a day with no sample
    // must be present as a zero here, or `loggingHabit` cannot tell a short
    // window from a sparse one.
    const out = [];
    for (let i = 0; i < windowDays; i += 1) {
      const d = new Date(now.getTime() - i * 86400000);
      const key = _dayKey(d);
      out.push({ day: key, value: byDay.get(key) || 0 });
    }
    return out;
  } catch (e) {
    gaps.push({ source: metric, why: e.message });
    return [];
  }
}

module.exports = {
  assess,
  loggingHabit,
  standStillness,
  build,
  PHONE_FRESH_MINUTES,
  SEDENTARY_MINUTES,
  EXERCISE_QUIET_DAYS,
  EXERCISE_DAY_MINUTES,
  DIET_WINDOW_DAYS,
  LOGGING_DAYS_REQUIRED,
  WATER_TARGET_ML,
  MAX_OBSERVATIONS,
  STAND_QUIET_HOURS,
  HR_SAMPLES_WORN,
};
