'use strict';

/**
 * Team Health Snapshot — cross-team prioritised list of issues requiring
 * Nick's attention. Pulls from People/*.md frontmatter, dev plans, meetings,
 * and open action items.
 *
 * Issue shape:
 *   { person, severity: 'high'|'med'|'low', type, title, meta? }
 *
 * Severity meaning:
 *   high  — acute: overdue 1:1, probation, improvement window, goal due < 7d
 *   med   — elevated: 1:1 due <= 3d, no meeting in 30-45d, goal due < 21d
 *   low   — awareness: stale meeting 45-60d, action overdue < 7d
 *
 * TEAMS list is duplicated from the frontend PeopleBoard by design (speed
 * over purity). If this goes stale, hoist it into settings.
 */

const fs = require('fs');
const path = require('path');
const obsidian = require('./obsidian');
const devPlan = require('./development-plan');
const actionItems = require('./action-items');

const VAULT_PATH = () => process.env.OBSIDIAN_VAULT_PATH || '';

// Mirrors frontend/src/components/PeopleBoard.jsx TEAMS
const TEAMS = {
  '2nd Line Technical Support': [
    'Abdi Mohamed', 'Arman Shazad', 'Luke Scaife', 'Stephen Mitchell',
    'Willem Kruger', 'Nathan Rutland',
  ],
  '1st Line Customer Care': [
    'Adele Norman-Swift', 'Heidi Power', 'Hope Goodall', 'Maria Pappa',
    'Naomi Wentworth', 'Sebastian Broome', 'Zoe Rees',
  ],
  'Digital Design': [
    'Isabel Busk', 'Kayleigh Russell',
  ],
};

function allPeople(teamFilter) {
  if (teamFilter && TEAMS[teamFilter]) return TEAMS[teamFilter].map(name => ({ name, team: teamFilter }));
  const out = [];
  for (const [team, names] of Object.entries(TEAMS)) {
    for (const name of names) out.push({ name, team });
  }
  return out;
}

function daysBetween(aStr, bStr) {
  const a = new Date(aStr), b = new Date(bStr);
  return Math.floor((a - b) / 86400000);
}

function todayISO() { return new Date().toISOString().slice(0, 10); }

function readPersonFrontmatter(name) {
  const file = path.join(VAULT_PATH(), 'People', `${name}.md`);
  if (!fs.existsSync(file)) return null;
  try {
    const content = fs.readFileSync(file, 'utf-8');
    return { frontmatter: obsidian.parseFrontmatter(content), content };
  } catch { return null; }
}

function lastMeetingDate(name) {
  const vault = VAULT_PATH();
  const meetingsDir = path.join(vault, 'Meetings');
  if (!fs.existsSync(meetingsDir)) return null;
  const firstName = name.split(' ')[0].toLowerCase();
  const stack = [meetingsDir];
  let latest = null;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const dm = entry.name.match(/^(\d{4}-\d{2}-\d{2})/);
      if (!dm) continue;
      if (latest && dm[1] <= latest) continue;
      let content;
      try { content = fs.readFileSync(full, 'utf-8'); } catch { continue; }
      if (content.toLowerCase().includes(firstName)) latest = dm[1];
    }
  }
  return latest;
}

function analysePerson({ name, team }) {
  const today = todayISO();
  const issues = [];
  const pf = readPersonFrontmatter(name);
  if (!pf) return { name, team, issues: [{ severity: 'low', type: 'missing_note', title: `No People/${name}.md found`, meta: {} }] };

  const fm = pf.frontmatter;

  // ── 1:1 cadence
  //
  // Classified by `one-to-one-detect.cadenceState()`, not here: this board and
  // the 1-2-1 nudge must agree on what "overdue" means, and they didn't. Both
  // read `next-1-2-1-due` as "owed by", while `book()` was writing the booked
  // date into it — so a 1-2-1 sitting in the diary showed as high-severity
  // overdue the day after it happened.
  const nextDue = fm['next-1-2-1-due'];
  const booked = fm['1-2-1-booked'] || null;
  if (nextDue || booked) {
    const s = require('./one-to-one-detect').cadenceState({
      lastHeld: fm['last-1-2-1'] || null,
      nextDue: nextDue || null,
      booked,
    }, today, { soonDays: 3 });

    if (s.state === 'overdue') {
      issues.push({
        severity: 'high', type: 'overdue_1to1',
        title: `1:1 overdue by ${s.daysOverdue}d`,
        meta: { dueDate: s.nextDue, daysOverdue: s.daysOverdue },
      });
    } else if (s.state === 'unwritten') {
      // Not an overdue 1-2-1 — a missing write-up, or a cancellation nobody
      // recorded. Different problem, different fix, so it gets its own type
      // rather than being folded into the overdue count.
      issues.push({
        severity: 'med', type: 'unwritten_1to1',
        title: `1:1 on ${s.booked} has no note (${s.daysSince}d ago)`,
        meta: { bookedDate: s.booked, daysSince: s.daysSince },
      });
    } else if (s.state === 'due-soon') {
      issues.push({
        severity: 'med', type: 'due_soon_1to1',
        title: `1:1 due in ${s.daysUntil}d`,
        meta: { dueDate: s.nextDue, daysUntil: s.daysUntil },
      });
    }
    // `booked` is silent — it's in the diary, there is nothing to raise.
  } else {
    issues.push({
      severity: 'med', type: 'missing_cadence',
      title: `No next-1-2-1-due set in frontmatter`,
      meta: {},
    });
  }

  // ── Probation / improvement window
  const status = String(fm.status || '').toLowerCase();
  if (/improvement/i.test(status)) {
    issues.push({ severity: 'high', type: 'improvement_window', title: `Status: ${fm.status}`, meta: { status: fm.status } });
  } else if (/probation/i.test(status) && !/passed/i.test(status)) {
    issues.push({ severity: 'high', type: 'probation_active', title: `Status: ${fm.status}`, meta: { status: fm.status } });
  }

  // ── Meeting freshness
  const lastMeeting = lastMeetingDate(name);
  if (lastMeeting) {
    const staleDays = daysBetween(today, lastMeeting);
    if (staleDays >= 45) {
      issues.push({
        severity: staleDays >= 60 ? 'med' : 'low', type: 'stale_meeting',
        title: `No meeting mention in ${staleDays}d`,
        meta: { lastMeeting, staleDays },
      });
    }
  } else {
    issues.push({ severity: 'low', type: 'no_meetings_found', title: `No meeting files mention ${name}`, meta: {} });
  }

  // ── Dev plan goal deadlines
  const plan = devPlan.readPlan(name);
  if (plan.status === 'ok') {
    for (const g of plan.goals) {
      if (g.complete) continue;
      if (!g.targetDate) continue;
      // Target dates are "30 May 2026" human format — parse loosely
      const parsed = new Date(g.targetDate);
      if (isNaN(parsed.getTime())) continue;
      const daysUntil = Math.floor((parsed - new Date()) / 86400000);
      if (daysUntil < 0) {
        issues.push({
          severity: 'high', type: 'goal_overdue',
          title: `Goal ${g.number} "${g.title}" overdue by ${Math.abs(daysUntil)}d`,
          meta: { goalNumber: g.number, targetDate: g.targetDate },
        });
      } else if (daysUntil <= 7) {
        issues.push({
          severity: 'high', type: 'goal_due_very_soon',
          title: `Goal ${g.number} "${g.title}" due in ${daysUntil}d`,
          meta: { goalNumber: g.number, targetDate: g.targetDate },
        });
      } else if (daysUntil <= 21) {
        issues.push({
          severity: 'med', type: 'goal_due_soon',
          title: `Goal ${g.number} "${g.title}" due in ${daysUntil}d`,
          meta: { goalNumber: g.number, targetDate: g.targetDate },
        });
      }
    }
  }

  // ── Open overdue actions owned by / about the person
  const actions = actionItems.findActionItems({ person: name, status: 'open', daysBack: 180 });
  const overdueActions = actions.filter(a => a.dueDate && a.dueDate < today);
  if (overdueActions.length) {
    const worst = overdueActions[0];
    const worstDelta = daysBetween(today, worst.dueDate);
    issues.push({
      severity: worstDelta >= 14 ? 'high' : 'med',
      type: 'overdue_actions',
      title: `${overdueActions.length} overdue action(s), worst ${worstDelta}d late`,
      meta: { count: overdueActions.length, worstOverdueDays: worstDelta, example: worst.text.substring(0, 120) },
    });
  }

  return { name, team, issues };
}

const SEVERITY_RANK = { high: 3, med: 2, low: 1 };

// Accept both 'med' (internal) and 'medium' (friendly) for the filter param.
function normaliseSeverityFilter(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'medium') return 'med';
  if (['high', 'med', 'low', 'all'].includes(s)) return s;
  return 'high'; // default
}

function teamHealthSnapshot({ team, severity = 'high' } = {}) {
  const vault = VAULT_PATH();
  if (!vault) return { status: 'error', error: 'OBSIDIAN_VAULT_PATH not configured' };

  const people = allPeople(team);
  if (!people.length) return { status: 'error', error: `Unknown team: ${team}. Valid: ${Object.keys(TEAMS).join(', ')}` };

  const filter = normaliseSeverityFilter(severity);
  const perPerson = people.map(analysePerson);

  // Always compute the full counts (across all severities) so callers can
  // see what was filtered out vs what's included.
  const allIssues = [];
  for (const p of perPerson) {
    for (const i of p.issues) allIssues.push({ person: p.name, team: p.team, ...i });
  }

  const allCounts = {
    high: allIssues.filter(i => i.severity === 'high').length,
    med: allIssues.filter(i => i.severity === 'med').length,
    low: allIssues.filter(i => i.severity === 'low').length,
    peopleWithIssues: perPerson.filter(p => p.issues.length).length,
    peopleClean: perPerson.filter(p => !p.issues.length).length,
  };

  // Apply filter: 'high' → only high; 'med' → high + med; 'low' → all; 'all' → all.
  const minRank = filter === 'all' || filter === 'low' ? 1
    : filter === 'med' ? 2
    : 3;
  const filtered = allIssues.filter(i => (SEVERITY_RANK[i.severity] || 0) >= minRank);

  filtered.sort((a, b) => {
    const r = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (r) return r;
    return a.person.localeCompare(b.person);
  });

  const filteredPerPerson = perPerson.map(p => ({
    ...p,
    issues: p.issues.filter(i => (SEVERITY_RANK[i.severity] || 0) >= minRank),
  })).filter(p => p.issues.length > 0);

  return {
    status: 'ok',
    team: team || 'all',
    severityFilter: filter,
    counts: allCounts,
    filteredCount: filtered.length,
    issues: filtered,
    perPerson: filteredPerPerson,
  };
}

module.exports = { teamHealthSnapshot, TEAMS };
