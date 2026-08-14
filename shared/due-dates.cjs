'use strict';

/**
 * Due-date presets, shared by every surface that can move a task.
 *
 * Presets rather than a date picker on purpose. A picker asks "which day?" — a
 * question that needs you to hold a calendar in your head and is exactly the
 * kind of small decision that stalls. These ask "how far away?", which is the
 * question you can actually answer while looking at the task.
 *
 * Weekends are never offered as a target. Nick works Monday to Friday, so a
 * task landing on Saturday is a task that silently becomes overdue on Monday.
 */

const DAY_MS = 86400000;

// Local getters throughout, never toISOString() — the Pi runs UTC, which rolls
// the date forward an hour early on a BST evening.
function toDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d, n) {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function isWorkingDay(d) {
  const day = d.getDay();
  return day >= 1 && day <= 5;
}

/** The next working day strictly after `from`. */
function nextWorkingDay(from) {
  let d = addDays(from, 1);
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}

/** Monday of the week after `from`. */
function nextMonday(from) {
  let d = addDays(from, 1);
  while (d.getDay() !== 1) d = addDays(d, 1);
  return d;
}

/**
 * Build the preset list for a given moment.
 *
 * "Tomorrow" collapses into "Monday" at the weekend rather than being offered
 * twice — two buttons resolving to the same date reads as a bug and wastes the
 * one bit of attention this control gets.
 */
function duePresets(now = new Date()) {
  const presets = [];
  const tomorrow = addDays(now, 1);

  if (isWorkingDay(tomorrow)) {
    presets.push({ id: 'tomorrow', label: 'Tomorrow', date: toDateStr(tomorrow) });
  }

  const monday = nextMonday(now);
  const mondayStr = toDateStr(monday);
  if (!presets.some(p => p.date === mondayStr)) {
    presets.push({ id: 'monday', label: 'Monday', date: mondayStr });
  }

  // A week out, pulled back to a working day if it lands on a weekend.
  let week = addDays(now, 7);
  if (!isWorkingDay(week)) week = nextWorkingDay(week);
  const weekStr = toDateStr(week);
  if (!presets.some(p => p.date === weekStr)) {
    presets.push({ id: 'week', label: 'Next week', date: weekStr });
  }

  return presets;
}

/**
 * How a due date should read on a task row. Relative where relative is clearer
 * ("in 3 days" beats "2026-08-17" when you are deciding what to do now), absolute
 * once it is far enough out that the day of week stops meaning anything.
 */
function describeDue(dateStr, now = new Date()) {
  if (!dateStr) return null;
  const target = new Date(`${String(dateStr).split('T')[0]}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((target - today) / DAY_MS);

  if (days < 0) return { label: days === -1 ? 'Yesterday' : `${Math.abs(days)} days ago`, overdue: true };
  if (days === 0) return { label: 'Today', overdue: false, due: true };
  if (days === 1) return { label: 'Tomorrow', overdue: false };
  if (days <= 6) return { label: target.toLocaleDateString('en-GB', { weekday: 'long' }), overdue: false };
  return { label: target.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), overdue: false };
}

module.exports = { duePresets, describeDue, toDateStr, nextWorkingDay, nextMonday, isWorkingDay };
