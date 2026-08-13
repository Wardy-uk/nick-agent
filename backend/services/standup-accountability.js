// Deterministic accountability scan for the standup ritual.
// No AI — reads recent daily notes and works out what Nick actually committed to,
// what he did, and what has been quietly rolling forward day after day.

const fs = require('fs');
const path = require('path');

function vaultPath() {
  return process.env.OBSIDIAN_VAULT_PATH || '';
}

function dateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Normalised key for matching the same commitment across days
function commitmentKey(text) {
  return text
    .toLowerCase()
    .replace(/\[\[([^|]*?\|)?([^\]]*?)\]\]/g, '$2')
    .replace(/#[\w-]+/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 60);
}

function cleanTaskText(raw) {
  return raw
    .replace(/<!--.*?-->/g, '')
    .replace(/\[\[([^|]*?\|)?([^\]]*?)\]\]/g, '$2')
    .replace(/due::\d{4}-\d{2}-\d{2}/g, '')
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, '')
    .replace(/#[\w-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Parse one daily note into the bits accountability cares about
function parseDailyNote(content) {
  const focus = [];
  const carry = [];
  let eodDone = false;
  let didntGo = null;

  let section = null;
  for (const line of content.split('\n')) {
    if (/^##\s+Focus Today/i.test(line)) { section = 'focus'; continue; }
    if (/^##\s+Carry/i.test(line)) { section = 'carry'; continue; }
    if (/^##\s+EOD/i.test(line)) { section = 'eod'; eodDone = true; continue; }
    if (/^##\s/.test(line)) { section = null; continue; }

    if (section === 'eod') {
      const m = line.match(/\*\*Didn't go to plan:\*\*\s*(.+)/i);
      if (m && !/^nothing/i.test(m[1].trim())) didntGo = m[1].trim();
      continue;
    }

    if (section !== 'focus' && section !== 'carry') continue;
    const m = line.match(/^\s*-\s+\[([ x>/])\]\s+(.+)$/i);
    if (!m) continue;
    const text = cleanTaskText(m[2]);
    if (!text || /^none$/i.test(text)) continue;
    const item = { text, key: commitmentKey(text), done: m[1].toLowerCase() === 'x' };
    (section === 'focus' ? focus : carry).push(item);
  }

  const standupDone = focus.length > 0 || /^##\s+Standup/im.test(content);
  return { focus, carry, eodDone, didntGo, standupDone };
}

// Walk back over the last `lookbackDays` calendar days, newest first
function readRecentNotes(lookbackDays) {
  const dir = path.join(vaultPath(), 'Daily');
  const days = [];
  if (!vaultPath() || !fs.existsSync(dir)) return days;

  const today = new Date();
  for (let i = 1; i <= lookbackDays; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ds = dateStr(d);
    const file = path.join(dir, `${ds}.md`);
    const isWeekend = d.getDay() === 0 || d.getDay() === 6;
    if (!fs.existsSync(file)) {
      days.push({ date: ds, isWeekend, exists: false });
      continue;
    }
    let content = '';
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    days.push({ date: ds, isWeekend, exists: true, ...parseDailyNote(content) });
  }
  return days;
}

/**
 * Build the full accountability picture for this morning's standup.
 * Everything here is derived from the vault + queue cache — no AI, no guessing.
 */
function buildAccountability({ lookbackDays = 14 } = {}) {
  const days = readRecentNotes(lookbackDays);
  const withNotes = days.filter(d => d.exists);
  const previous = withNotes[0] || null;

  // ── Today, if the standup has already run ──
  // Kept separate from the lookback: today's items aren't "carried" yet, but if
  // the standup is already done we should be tracking progress against them.
  let today = null;
  const todayStr = dateStr(new Date());
  const todayFile = path.join(vaultPath(), 'Daily', `${todayStr}.md`);
  if (vaultPath() && fs.existsSync(todayFile)) {
    try {
      const parsed = parseDailyNote(fs.readFileSync(todayFile, 'utf-8'));
      const all = [...parsed.focus, ...parsed.carry];
      today = {
        date: todayStr,
        standupDone: parsed.standupDone,
        eodDone: parsed.eodDone,
        committed: all.length,
        done: all.filter(i => i.done).length,
        items: all.map(i => ({ text: i.text, done: i.done })),
      };
    } catch {}
  }

  // ── Open commitments and how long they've been rolling ──
  // Walk oldest → newest so the newest mention wins.
  const tracked = new Map();
  for (const day of [...withNotes].reverse()) {
    for (const item of [...(day.focus || []), ...(day.carry || [])]) {
      const entry = tracked.get(item.key) || { text: item.text, dates: [], lastDone: false };
      entry.text = item.text; // keep the most recent wording
      entry.lastDone = item.done;
      if (!item.done) entry.dates.push(day.date);
      tracked.set(item.key, entry);
    }
  }

  const openCommitments = [];
  for (const [key, entry] of tracked) {
    if (entry.lastDone || entry.dates.length === 0) continue;
    openCommitments.push({
      key,
      text: entry.text,
      daysCarried: entry.dates.length,
      firstSeen: entry.dates[0],
      lastSeen: entry.dates[entry.dates.length - 1],
    });
  }
  openCommitments.sort((a, b) => b.daysCarried - a.daysCarried);

  // ── Yesterday's scoreboard ──
  let yesterday = null;
  if (previous) {
    const all = [...(previous.focus || []), ...(previous.carry || [])];
    yesterday = {
      date: previous.date,
      committed: all.length,
      done: all.filter(i => i.done).length,
      eodDone: !!previous.eodDone,
      unresolved: previous.didntGo || null,
    };
  }

  // ── Days the ritual was skipped entirely (weekdays only) ──
  const skipped = days
    .filter(d => !d.isWeekend && (!d.exists || !d.standupDone))
    .map(d => d.date)
    .slice(0, 5);

  // ── Overdue must-dos ──
  const overdueMustDos = [];
  try {
    const obsidian = require('./obsidian');
    const todayStr = obsidian.todayDateString();
    for (const m of obsidian.parseVaultMustDos()) {
      if (!m.due_date || m.due_date >= todayStr) continue;
      const daysLate = Math.round(
        (new Date(todayStr) - new Date(m.due_date)) / 86400000
      );
      overdueMustDos.push({ text: m.text, due_date: m.due_date, daysLate });
    }
    overdueMustDos.sort((a, b) => b.daysLate - a.daysLate);
  } catch {}

  // ── Queue pressure ──
  let queue = null;
  try {
    const db = require('../db/database');
    const q = db.getQueueSummary();
    if (q.total > 0) {
      queue = {
        total: q.total,
        atRisk: q.at_risk_count || 0,
        p1s: q.open_p1s || 0,
        atRiskTickets: (q.at_risk_tickets || []).slice(0, 3)
          .map(t => ({ key: t.ticket_key, summary: t.summary })),
      };
    }
  } catch {}

  // ── 90-day plan slippage ──
  let plan = null;
  try {
    const p = require('./obsidian').parseNinetyDayPlan();
    if (p) {
      plan = {
        currentDay: p.currentDay,
        totalDays: p.totalDays,
        done: p.totalDone,
        total: p.totalTasks,
        overdue: (p.overdueTasks || []).length,
      };
    }
  } catch {}

  // ── The blunt one-liner ──
  const stale = openCommitments.filter(c => c.daysCarried >= 3);
  let headline;
  if (today?.standupDone && today.committed > 0) {
    const open = today.committed - today.done;
    headline = open === 0
      ? `All ${today.committed} of today's commitments ticked off.`
      : `You committed to ${today.committed} thing${today.committed > 1 ? 's' : ''} today. ${today.done} done, ${open} still open.`;
  } else if (stale.length === 1) {
    headline = `"${stale[0].text}" has been on your list ${stale[0].daysCarried} days. Decide today.`;
  } else if (stale.length > 1) {
    headline = `${stale.length} things have been rolling for 3+ days. Commit or drop them.`;
  } else if (yesterday && yesterday.committed > 0 && yesterday.done === 0) {
    headline = `Nothing from ${yesterday.date} got ticked off. What actually happened?`;
  } else if (skipped.length >= 2) {
    headline = `You've skipped standup ${skipped.length} of the last few weekdays.`;
  } else if (openCommitments.length === 0 && yesterday) {
    headline = 'Clean slate — nothing carried over.';
  } else {
    headline = null;
  }

  return {
    headline,
    today,
    yesterday,
    openCommitments,
    staleCount: stale.length,
    skippedDays: skipped,
    overdueMustDos,
    queue,
    plan,
  };
}

module.exports = { buildAccountability, commitmentKey };
