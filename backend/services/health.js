'use strict';

/**
 * Today's body, as context for the surfaces that talk to Nick.
 *
 * ⚠ WHY THIS FILE WAS REWRITTEN (29 Aug 2026). Every function here read the KV
 * blob `agent_state.health_data_<date>`, written by `POST /api/health/ingest`.
 * The phone stopped using that route when the FreeReps app took over: it posts
 * to `/api/v1/ingest/` (routes/apple-health.js) and writes `health_samples`
 * ONLY. So the blob stopped being written and every reader of it returned null —
 * chat context (claude.js), journal prompts (routes/journal.js), the readiness
 * probe in server.js, and `/api/health/{today,history,status}`. Measured before
 * changing anything: `agent_state` held NO `health_*` keys at all, against 1.1M
 * rows in `health_samples` covering two years and still arriving that morning.
 *
 * Nothing threw and nothing logged, because a missing blob reads as "no data
 * yet" rather than "the writer is gone" — the same species as the Jira queue
 * cache, where readers outlived their writer and served a frozen snapshot as
 * current fact. One store now: `health_samples`, rolled up by `health-daily`.
 */

const healthDaily = require('./health-daily');

/**
 * Today's rolled-up row, or null.
 *
 * ⚠ Null is NOT "Nick is fine". It means the day has produced nothing readable
 * yet — which on a phone that syncs when iOS feels like it is a normal state at
 * 07:00 and a broken feed at 19:00. Callers that make a claim from this must say
 * which of the two they are looking at; `getHealthContextBlock` does.
 */
function getTodayData(now = new Date()) {
  try {
    const { data } = healthDaily.today(now);
    if (!data) return null;
    // A row exists for every day the rollup ran, so an EMPTY row is not data.
    const hasAnything = ['asleepHours', 'hrvMedian', 'rhrMedian', 'steps', 'activeEnergy']
      .some(k => Number.isFinite(data[k]));
    return hasAnything ? data : null;
  } catch { return null; }
}

function fmt(n, dp = 0) {
  return Number.isFinite(n) ? Number(n.toFixed(dp)).toLocaleString() : null;
}

/**
 * The block dropped into chat's prompt.
 *
 * Leads with the READINESS SENTENCE rather than the numbers, because the numbers
 * are what NEURO has always had and the judgement is what it did not: "HRV 14ms"
 * means nothing to a model without two years of Nick to compare it against, and
 * `health-daily` has already done that comparison. The raw figures follow for
 * anything that wants to quote one.
 */
function getHealthContextBlock(now = new Date()) {
  let snapshot;
  try { snapshot = healthDaily.today(now); } catch { return null; }
  const data = snapshot && snapshot.data;
  if (!data) return null;

  const parts = [];
  if (Number.isFinite(data.asleepHours)) {
    let sleep = `Slept ${data.asleepHours}h`;
    const stages = [];
    if (Number.isFinite(data.deepHours)) stages.push(`${data.deepHours}h deep`);
    if (Number.isFinite(data.remHours)) stages.push(`${data.remHours}h REM`);
    if (stages.length) sleep += ` (${stages.join(', ')})`;
    parts.push(sleep);
  }
  if (Number.isFinite(data.hrvMedian)) parts.push(`HRV ${fmt(data.hrvMedian)}ms`);
  if (Number.isFinite(data.rhrMedian)) parts.push(`Resting HR ${fmt(data.rhrMedian)}bpm`);
  if (Number.isFinite(data.steps)) parts.push(`${fmt(data.steps)} steps`);
  if (Number.isFinite(data.exerciseMinutes)) parts.push(`${fmt(data.exerciseMinutes)} min exercise`);
  if (Number.isFinite(data.daylightMinutes)) parts.push(`${fmt(data.daylightMinutes)} min daylight`);
  if (Number.isFinite(data.activeEnergy)) parts.push(`${fmt(data.activeEnergy)}kcal active`);

  if (!parts.length && !snapshot.sentence) return null;

  const lines = ['## Apple Health — today'];
  if (snapshot.sentence) {
    lines.push(snapshot.sentence);
  } else if (snapshot.readiness && snapshot.readiness.reason) {
    // Says WHY there is no judgement rather than omitting it, so the model does
    // not read a bare list of numbers as an assessment nobody made.
    lines.push(`(No readiness read: ${snapshot.readiness.reason}.)`);
  }
  if (parts.length) lines.push(parts.join(' · '));
  // Today's row is a partial day by definition — the steps figure is not a
  // day's steps at 11am, and a model told otherwise will say so out loud.
  if (data.complete === false) lines.push('(Figures are today so far, not a full day.)');

  return lines.join('\n');
}

/** The one-liner the journal prompt gets. Same source, fewer words. */
function getHealthSummaryForJournal(now = new Date()) {
  let snapshot;
  try { snapshot = healthDaily.today(now); } catch { return null; }
  const data = snapshot && snapshot.data;
  if (!data) return null;

  const bits = [];
  if (Number.isFinite(data.asleepHours)) bits.push(`${data.asleepHours}h sleep`);
  if (Number.isFinite(data.hrvMedian)) bits.push(`HRV ${fmt(data.hrvMedian)}ms`);
  if (Number.isFinite(data.rhrMedian)) bits.push(`resting HR ${fmt(data.rhrMedian)}bpm`);
  if (!bits.length) return null;

  // The sentence is composed once in health-daily and reused, so the journal,
  // chat and the panel cannot describe the same morning three different ways.
  return snapshot.sentence
    ? `${snapshot.sentence} (${bits.join(', ')})`
    : `Last night: ${bits.join(', ')}`;
}

module.exports = {
  getTodayData,
  getHealthContextBlock,
  getHealthSummaryForJournal,
};
