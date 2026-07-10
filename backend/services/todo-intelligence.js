'use strict';

function todayDateString() {
  return new Date().toISOString().split('T')[0];
}

function daysBetween(startStr, endStr) {
  if (!startStr || !endStr) return null;
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);
  return Math.round((end - start) / (1000 * 60 * 60 * 24));
}

function normalize(value) {
  return String(value || '').toLowerCase();
}

function safeJsonParse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function parseEmbeddedMeta(rawText) {
  const match = String(rawText || '').match(/<!--nuero-meta:(\{.*?\})-->/);
  if (!match) return null;
  const parsed = safeJsonParse(match[1]);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function serializeEmbeddedMeta(meta) {
  const clean = {};
  for (const [key, value] of Object.entries(meta || {})) {
    if (value == null || value === '') continue;
    clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return '';
  return `<!--nuero-meta:${JSON.stringify(clean)}-->`;
}

function classifyContext(text, sourcePath) {
  const lower = normalize(text);
  const path = normalize(sourcePath);

  if (path.includes('meetings/') || lower.includes('follow up') || lower.includes('follow-up')) return 'meeting-follow-up';
  if (lower.includes('sla') || lower.includes('ticket') || lower.includes('queue') || lower.includes('customer') || lower.includes('escalat')) return 'queue';
  if (lower.includes('willem') || lower.includes('adele') || lower.includes('arman') || lower.includes('heidi') || lower.includes('nick') || lower.includes('team') || lower.includes('1-2-1') || lower.includes('1:1')) return 'people';
  if (lower.includes('invoice') || lower.includes('finance') || lower.includes('approval') || lower.includes('expense') || lower.includes('calendar') || lower.includes('admin')) return 'admin';
  if (path.includes('documents/') || path.includes('projects/') || lower.includes('plan') || lower.includes('project') || lower.includes('launch')) return 'project';
  return 'general';
}

function classifyMoscow({ text, sourcePath, dueDate, mustdo, priority }) {
  const lower = normalize(text);
  const today = todayDateString();
  const overdue = dueDate && dueDate < today;
  const dueToday = dueDate && dueDate === today;
  const urgentSignal = [
    'urgent', 'asap', 'today', 'before lunch', 'before eod', 'disciplinary',
    'probation', 'review', 'approval', 'approve', 'breach', 'sla', 'customer',
    'escalat', 'payroll', 'deadline'
  ].some((token) => lower.includes(token));

  if (mustdo || priority === 'high' || overdue || dueToday || urgentSignal) return 'must';
  if (normalize(sourcePath).includes('meetings/') || lower.includes('follow up') || lower.includes('reply') || lower.includes('send')) return 'should';
  if (lower.includes('capture') || lower.includes('brainstorm') || lower.includes('idea')) return 'could';
  return 'should';
}

function priorityFromMoscow(moscow, existingPriority, dueDate) {
  const today = todayDateString();
  if (existingPriority === 'high') return 'high';
  if (moscow === 'must') return 'high';
  if (dueDate && dueDate <= today) return 'high';
  if (moscow === 'should') return 'normal';
  if (moscow === 'wont') return 'low';
  return 'low';
}

function triageTodo({ text, sourcePath, dueDate, mustdo = false, priority = null, metadata = null }) {
  const meta = metadata || {};
  const context = meta.context || classifyContext(text, sourcePath);
  const moscow = meta.moscow || classifyMoscow({ text, sourcePath, dueDate, mustdo, priority });
  const computedPriority = priorityFromMoscow(moscow, priority, dueDate);
  const today = todayDateString();
  const overdue = dueDate ? dueDate < today : false;
  const dueToday = dueDate ? dueDate === today : false;
  const needsToday = mustdo || moscow === 'must' || overdue || dueToday || context === 'queue';
  const followThroughDays = moscow === 'must' ? 0 : moscow === 'should' ? 1 : 3;
  return {
    context,
    moscow,
    priority: computedPriority,
    needsToday,
    overdue,
    dueToday,
    followThroughDays,
  };
}

function taskAgeDays(task, todayStr = todayDateString()) {
  const created = task.meta?.created || task.createdAt || null;
  if (!created) return null;
  return daysBetween(created, todayStr);
}

function decorateTask(task, todayStr = todayDateString()) {
  const meta = task.meta || {};
  const triage = triageTodo({
    text: task.text,
    sourcePath: meta.sourcePath || task.sourcePath || task.filePath || null,
    dueDate: task.due_date || null,
    mustdo: Boolean(task.mustdo),
    priority: task.priority || null,
    metadata: meta,
  });
  const ageDays = taskAgeDays({ ...task, meta }, todayStr);
  const stale = ageDays != null && ageDays >= triage.followThroughDays && !triage.needsToday;
  return {
    ...task,
    meta,
    context: triage.context,
    moscow: triage.moscow,
    priority: triage.priority,
    needsToday: triage.needsToday,
    followThroughDays: triage.followThroughDays,
    ageDays,
    stale,
  };
}

function buildTodayLane(tasks, todayStr = todayDateString(), limit = 5) {
  return (tasks || [])
    .map((task) => decorateTask(task, todayStr))
    .filter((task) => task.needsToday || task.mustdo || task.priority === 'high')
    .sort((a, b) => {
      const am = a.moscow === 'must' ? 0 : a.moscow === 'should' ? 1 : 2;
      const bm = b.moscow === 'must' ? 0 : b.moscow === 'should' ? 1 : 2;
      if (am !== bm) return am - bm;
      if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
      if ((a.ageDays || 0) !== (b.ageDays || 0)) return (b.ageDays || 0) - (a.ageDays || 0);
      return 0;
    })
    .slice(0, limit)
    .map((task, index) => ({
      id: task.id || `${task.filePath || task.source}-${task.lineNumber || index}`,
      text: task.text,
      priority: task.priority,
      moscow: task.moscow,
      context: task.context,
      due_date: task.due_date || null,
      source: task.source || null,
      filePath: task.filePath || null,
      lineNumber: task.lineNumber != null ? task.lineNumber : null,
      ageDays: task.ageDays,
      why: task._scoreReason || (task.moscow === 'must' ? 'Must move today' : 'High-signal task'),
      sourcePath: task.meta?.sourcePath || task.sourcePath || null,
    }));
}

function buildFollowThroughCandidate(tasks, todayStr = todayDateString()) {
  const ranked = (tasks || [])
    .map((task) => decorateTask(task, todayStr))
    .filter((task) => task.moscow !== 'could' && task.moscow !== 'wont')
    .filter((task) => task.ageDays == null || task.ageDays >= task.followThroughDays || task.stale || task.overdue || task.dueToday)
    .sort((a, b) => {
      if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
      return (b.ageDays || 0) - (a.ageDays || 0);
    });

  const top = ranked[0];
  if (!top) return null;

  const sourceLabel = top.meta?.sourcePath ? top.meta.sourcePath.split('/').pop().replace(/\.md$/i, '') : null;
  const staleText = top.ageDays != null && top.ageDays > 0 ? `${top.ageDays}d old` : top.overdue ? 'overdue' : 'still open';
  return {
    text: top.text,
    context: top.context,
    sourcePath: top.meta?.sourcePath || top.sourcePath || null,
    sourceLabel,
    message: sourceLabel
      ? `"${top.text}" is still open (${staleText}) from ${sourceLabel}. Move it or kill it.`
      : `"${top.text}" is still open (${staleText}). Move it or kill it.`,
    navigate: 'todos',
    filter: top.moscow === 'must' ? 'mustdo' : top.overdue || top.dueToday ? 'today' : 'high',
  };
}

module.exports = {
  buildFollowThroughCandidate,
  buildTodayLane,
  decorateTask,
  parseEmbeddedMeta,
  serializeEmbeddedMeta,
  taskAgeDays,
  todayDateString,
  triageTodo,
};
