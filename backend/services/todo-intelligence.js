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

// The distinction that fixes everything-is-a-MUST: some words say WHEN a thing
// must happen, and some say WHAT the thing is. Only the first kind is urgency.
//
// The old list mixed them — `review`, `approval`, `approve`, `customer`, `sla`,
// `deadline` sat alongside `urgent` and `asap`. That first group is a fair
// description of Head of Technical Support, so almost every task matched, became
// `must`, and was promoted to `high` by priorityFromMoscow. A tag every row
// shares has stopped sorting anything: arithmetically identical to no
// priorities at all, while poisoning Focus, the Must Move Today lane AND the
// nudge count, since nudges.js ranks off the same builder.
//
// Deliberately rare. If these start matching most of the list again, that is the
// signal to cut the list, not to add to it.
const URGENT_NOW = [
  'urgent', 'asap', 'today', 'tonight', 'this morning', 'this afternoon',
  'before lunch', 'before eod', 'end of day', 'by close of play', 'first thing',
  // Severity rather than timing, but both are genuinely exceptional rather than
  // descriptive of the job: an SLA *breach* is not the same word as an SLA.
  'breach', 'disciplinary',
];

// Words that describe the WORK. Real signal about what a task is — they set
// context and can carry it to `should` — but they never promote to `must` on
// their own, because in this job they match nearly everything.
const DOMAIN_TERMS = [
  'review', 'approval', 'approve', 'customer', 'sla', 'escalat',
  'payroll', 'probation', 'deadline', 'ticket', 'queue',
];

// `today` is a parameter, not a call to the clock. decorateTask/buildTodayLane
// already took a todayStr and this ignored it, so every date test ran against
// the wall clock regardless of what the caller asked for — invisible in
// production, where they agree, and it made the lane untestable.
function classifyMoscow({ text, sourcePath, dueDate, mustdo, priority }, today = todayDateString()) {
  const lower = normalize(text);
  const overdue = dueDate && dueDate < today;
  const dueToday = dueDate && dueDate === today;
  const urgentNow = URGENT_NOW.some((token) => lower.includes(token));

  // MUST needs something that actually says "now": Nick said so, a date says so,
  // or the words say so. Not merely that the task is about a customer.
  if (mustdo || priority === 'high' || overdue || dueToday || urgentNow) return 'must';
  if (DOMAIN_TERMS.some((token) => lower.includes(token))) return 'should';
  if (normalize(sourcePath).includes('meetings/') || lower.includes('follow up') || lower.includes('reply') || lower.includes('send')) return 'should';
  if (lower.includes('capture') || lower.includes('brainstorm') || lower.includes('idea')) return 'could';
  return 'should';
}

function priorityFromMoscow(moscow, existingPriority, dueDate, today = todayDateString()) {
  if (existingPriority === 'high') return 'high';
  if (moscow === 'must') return 'high';
  if (dueDate && dueDate <= today) return 'high';
  if (moscow === 'should') return 'normal';
  if (moscow === 'wont') return 'low';
  return 'low';
}

function triageTodo({ text, sourcePath, dueDate, mustdo = false, priority = null, metadata = null }, today = todayDateString()) {
  const meta = metadata || {};
  const context = meta.context || classifyContext(text, sourcePath);
  const moscow = meta.moscow || classifyMoscow({ text, sourcePath, dueDate, mustdo, priority }, today);
  const computedPriority = priorityFromMoscow(moscow, priority, dueDate, today);
  const overdue = dueDate ? dueDate < today : false;
  const dueToday = dueDate ? dueDate === today : false;
  // `context === 'queue'` used to sit in this list on its own — no due date, no
  // must flag, no priority. And classifyContext assigns `queue` for any of sla /
  // ticket / queue / customer / escalat appearing anywhere in the text, so
  // "Make amends to Customer Portal" was in *Must Move Today* because of the
  // word "Customer". In this job that keyword set matches most of the work,
  // which is why four of five rows in the lane carried the same tag.
  //
  // Queue work is still real work — it just has to earn today the same way
  // everything else does.
  const needsToday = mustdo || moscow === 'must' || overdue || dueToday;
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
  }, todayStr);
  const ageDays = taskAgeDays({ ...task, meta }, todayStr);
  const stale = ageDays != null && ageDays >= triage.followThroughDays && !triage.needsToday;
  return {
    ...task,
    meta,
    context: triage.context,
    moscow: triage.moscow,
    priority: triage.priority,
    needsToday: triage.needsToday,
    // triageTodo has always computed these and decorateTask has never passed
    // them on — so `buildFollowThroughCandidate`'s `|| task.overdue ||
    // task.dueToday` arms were reading undefined and could never fire. Nothing
    // looked broken because the ageDays arm carried the filter on its own.
    overdue: triage.overdue,
    dueToday: triage.dueToday,
    followThroughDays: triage.followThroughDays,
    ageDays,
    stale,
  };
}

/**
 * Why this row is in the lane, in the order the qualifying test actually ran.
 *
 * The card claims these "protect your day", so it has to be able to say which
 * of the reasons applied — a generic "Must move today" is the classifier
 * marking its own homework. Now that a MUST needs a real signal, the reason is
 * always nameable, so there is no honest case for a generic string.
 */
function laneReason(task, todayStr = todayDateString()) {
  if (task.overdue) return `Overdue — was due ${task.due_date}`;
  if (task.dueToday) return 'Due today';
  if (task.mustdo) return 'You marked this a must';
  if (task.meta?.moscow === 'must') return 'You rated this a MUST';
  if (task.moscow === 'must') return 'Reads as urgent, not just important';
  if (task.priority === 'high') return 'Priority 1';
  return 'High-signal task';
}

/**
 * Planner's percentComplete for a Microsoft-backed row, or null.
 *
 * `syncMicrosoftTasks` renders it as a "(75%)" suffix on the mirror line, so
 * this reads back a number NEURO itself wrote. Null — never 0 — when there is
 * no marker: Planner omits the suffix at 0%, but so does a To Do task that has
 * no such field at all, and "not started" is a different fact from "this kind
 * of task cannot say". Only the marker NEURO writes counts, so a percentage a
 * human typed into a NEURO task's own text is not mistaken for Planner state.
 */
function msPercentComplete(task) {
  if (task.task_id != null) return null;              // NEURO owns it; status is the field
  if (!task.ms_id) return null;                       // not a Microsoft row
  const m = /\((\d{1,3})%\)/.exec(task.text || '');
  if (!m) return null;
  const pct = Number(m[1]);
  return pct >= 0 && pct <= 100 ? pct : null;
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
      // ⚠ `id` is a DISPLAY KEY, not a task id. parseVaultTodos numbers todos as
      // it walks them, so lane row `id: 28` is simply the 28th todo it saw —
      // measured live, that row was "Follow up with Liam" while task 28 in the
      // DB is "Review Molly's Guild website request". Completing by this number
      // ticks off an unrelated task, silently, in the one place Nick looks to
      // find what he owes. Anything acting on a row must use `task_id`.
      id: task.id || `${task.filePath || task.source}-${task.lineNumber || index}`,
      // The real identity, and the reason the lane can now be actioned at all.
      // Null for a file-backed row, where filePath + lineNumber is the identity
      // instead — the same owner order completeTask uses everywhere else.
      task_id: task.task_id != null ? task.task_id : null,
      ms_id: task.ms_id || null,
      text: task.text,
      priority: task.priority,
      moscow: task.moscow,
      context: task.context,
      due_date: task.due_date || null,
      source: task.source || null,
      // Carried so the lane can show WORK ALREADY STARTED rather than treating
      // every row as untouched. This whitelist is explicit, so a field absent
      // here is silently undefined on the client — which is how `overdue` and
      // `dueToday` came to be read as undefined by `buildFollowThroughCandidate`
      // (#73/#74). The WIP badge and its toggle both key on this.
      status: task.status || 'open',
      // ⚠ Planner progress that ALREADY EXISTS, recovered from the text.
      //
      // `syncMicrosoftTasks` writes Planner's percentComplete into the mirror
      // line as a "(75%)" suffix, so the number is already on screen — Nick's
      // Must Move lane shows "Re-instate reglar 121s with team (75%)" and that
      // 75 is Planner's, not something he typed. Nothing had ever read it back,
      // so NEURO could not tell a task three-quarters done from an untouched
      // one, and a WIP button that blindly PATCHed percentComplete=50 would
      // have REDUCED it — destroying real progress in a shared board his team
      // reads. Parsed here rather than in the client because the format is
      // NEURO's own output and the rule belongs with a test.
      percentComplete: msPercentComplete(task),
      filePath: task.filePath || null,
      lineNumber: task.lineNumber != null ? task.lineNumber : null,
      ageDays: task.ageDays,
      // The scorer's reason wins when there is one — it knows more. Otherwise
      // name the test that actually put this row here.
      why: task._scoreReason || laneReason(task, todayStr),
      sourcePath: task.meta?.sourcePath || task.sourcePath || null,
    }));
}

function buildFollowThroughCandidate(tasks, todayStr = todayDateString()) {
  const ranked = (tasks || [])
    .map((task) => decorateTask(task, todayStr))
    .filter((task) => task.moscow !== 'could' && task.moscow !== 'wont')
    .filter((task) => task.ageDays == null || task.ageDays >= task.followThroughDays || task.stale || task.overdue || task.dueToday)
    .sort((a, b) => {
      // MoSCoW first — same ranking as the Today lane, so the nudge and the
      // lane agree on what matters. Without this a stale 'should' outranks a must.
      const am = a.moscow === 'must' ? 0 : 1;
      const bm = b.moscow === 'must' ? 0 : 1;
      if (am !== bm) return am - bm;
      if ((b._score || 0) !== (a._score || 0)) return (b._score || 0) - (a._score || 0);
      return (b.ageDays || 0) - (a.ageDays || 0);
    });

  const top = ranked[0];
  if (!top) return null;

  const sourceLabel = top.meta?.sourcePath ? top.meta.sourcePath.split('/').pop().replace(/\.md$/i, '') : null;
  // null when we have nothing to add — otherwise we render "still open (still open)"
  const staleText = top.ageDays != null && top.ageDays > 0 ? `${top.ageDays}d old` : top.overdue ? 'overdue' : null;
  const qualifier = staleText ? ` (${staleText})` : '';
  const from = sourceLabel ? ` from ${sourceLabel}` : '';
  return {
    text: top.text,
    context: top.context,
    sourcePath: top.meta?.sourcePath || top.sourcePath || null,
    sourceLabel,
    message: `"${top.text}" is still open${qualifier}${from}. Move it or kill it.`,
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
