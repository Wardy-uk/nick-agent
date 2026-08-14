'use strict';

/**
 * Renders the outcomes rollup as the weekly review's "did this help?" section.
 *
 * Split from outcomes.js on purpose: that module reports movement and does not
 * editorialise, because the same numbers are read by a UI that will want to
 * present them differently. The interpretation — which direction is good, and
 * what a change is worth saying out loud — lives here.
 *
 * The tone rule is the same one the nudges follow: state the fact, name what it
 * suggests, never imply a verdict about Nick. "Snoozes up 40%" is useful. "You
 * ignored SARA 40% more this week" is the sentence that gets the review closed.
 */

const outcomes = require('./outcomes');

function _arrow(changePct, goodDirection) {
  if (changePct == null) return '';
  if (Math.abs(changePct) < 10) return ' → about the same';
  const up = changePct > 0;
  const good = goodDirection === 'up' ? up : !up;
  return ` ${up ? '↑' : '↓'} ${Math.abs(changePct)}%${good ? '' : ''}`;
}

function buildSection(anchor = new Date()) {
  const week = outcomes.computeWeek(anchor);
  const t = outcomes.trend(5);
  const lines = [];

  lines.push('## Did the system help?');
  lines.push('*Facts from the activity log. No judgement attached — they are here to inform the reflection below.*');
  lines.push('');

  const f = week.finished;
  lines.push(`- **Finished:** ${f.total} thing${f.total === 1 ? '' : 's'} across ${f.activeDays} day${f.activeDays === 1 ? '' : 's'}${t.enough ? _arrow(t.finished.changePct, 'up') : ''}`);
  lines.push(`- **Rituals:** standup on ${week.rituals.standupDays}/5 days, EOD on ${week.rituals.eodDays}/5`);

  const nag = week.nagPressure;
  // Falling is good here, and it is the number most worth being honest about:
  // rising nag pressure while everything else looks healthy means the tool is
  // generating compliance rather than help.
  lines.push(`- **Nudges pushed back:** ${nag.total} (${nag.snoozed} snoozed, ${nag.dismissed} dismissed)${t.enough ? _arrow(t.nagPressure.changePct, 'down') : ''}`);
  if (t.enough && t.nagPressure.changePct != null && t.nagPressure.changePct > 25) {
    lines.push(`  - Worth a look: that is up on recent weeks. Either the week was unusually busy, or the nudges are landing wrong.`);
  }

  if (week.carried) {
    lines.push(`- **Commitments carried:** ${week.carried.open} open, ${week.carried.stale} sitting 3+ days`);
  }
  if (week.tasks) {
    lines.push(`- **Task list:** ${week.tasks.open} open`);
  }
  if (week.suggestions.approvalRate != null) {
    lines.push(`- **SARA suggestions:** ${week.suggestions.executed} approved, ${week.suggestions.rejected} rejected (${week.suggestions.approvalRate}% approved)`);
    if (week.suggestions.approvalRate < 50) {
      lines.push(`  - Under half approved — the suggestions are probably wrong more often than they are useful.`);
    }
  }

  const reachEntries = Object.entries(week.reach || {}).sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (reachEntries.length) {
    lines.push(`- **Most opened:** ${reachEntries.map(([name, n]) => `${name} (${n})`).join(', ')}`);
  }

  if (!t.enough) {
    lines.push('');
    lines.push(`*Only ${t.weeks} week${t.weeks === 1 ? '' : 's'} of history so far — trends appear once there are a few to compare.*`);
  }

  return lines.join('\n');
}

module.exports = { buildSection };
