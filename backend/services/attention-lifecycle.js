'use strict';

/**
 * Attention lifecycle — the durable identity of a surfaced thing.
 *
 * Full contract: `docs/attention-contract.md`.
 *
 * ── What this is NOT ────────────────────────────────────────────────────────
 * It is not a second decision engine. `decision-engine` stays the one place
 * something becomes worth surfacing and `attention.gate()` stays the one place
 * context re-ranks it. This layer adds no candidates, changes no ranking, and
 * must never be the reason something is hidden that the gate would have shown.
 *
 * It does exactly one new thing: it remembers. Before it, an attention item
 * lived for one HTTP request, so nothing could be acknowledged, no notification
 * knew what it was about, and a dismissal was indistinguishable from a snooze.
 *
 * ── The split ───────────────────────────────────────────────────────────────
 * Everything that JUDGES is pure and takes its clock as an argument — the
 * `pi-health.assess()` / `state-of-play.assess()` split. The rules are the
 * product, so they pin without a database, a vault or a Pi. Only `reconcile`,
 * `act` and `sweep` touch storage.
 */

const db = require('../db/database');
const settingsStore = require('./attention-settings');

// How long an open record survives with no fresh sighting before it ages out.
//
// ⚠ Absence is NEVER treated as completion. The pool is capped (FOCUS_MAX 7),
// suppressible and occasionally unreadable, so an item vanishing from one
// evaluation is weak evidence of anything — this is the codebase's own
// "an absence is not a zero" rule, and reading it as "done" would put work in
// the wins ledger nobody did. An aged-out record therefore becomes `expired`
// (its moment passed, Nick decided nothing), never `resolved` (acted on).
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// A meeting card is about a moment. Fifteen minutes after it starts, "you have a
// meeting in 10 minutes" is not a stale card, it is a false one.
const MEETING_GRACE_MS = 15 * 60 * 1000;

const DEFER_REASONS = new Set(['not-now', 'no-context', 'waiting-on-someone', 'too-big', 'unspecified']);

const STATES = {
  ACTIVE: 'active',
  ACKNOWLEDGED: 'acknowledged',
  DEFERRED: 'deferred',
  SUPPRESSED: 'suppressed',
  RESOLVED: 'resolved',
  EXPIRED: 'expired',
};

// ── Pure: identity ───────────────────────────────────────────────────────────

function _slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/**
 * The identity of the THING, stable across evaluations. PURE.
 *
 * ⚠ Deliberately NOT the engine's item id, which is unstable by construction:
 * `collectOverdueTodos` emits `todo-overdue-top` when one task is overdue and
 * `todo-overdue-summary` when two are, so a dismissal recorded against one
 * silently stopped applying the moment a second task went overdue. Likewise a
 * nudge id is a database row recreated daily, so keying on it would open a new
 * record every morning and lose the thread within a day.
 *
 * The key names the thing the card is ABOUT: this task, this meeting, this
 * ticket, the urgent-email pile.
 */
function dedupeKeyFor(card) {
  if (!card || typeof card !== 'object') return null;
  // An explicit key wins. This is how a NOTIFICATION says which pool item it is
  // about — see `dedupeKeyForPush` — rather than being guessed from its type and
  // colliding with a real card.
  if (card.dedupeKey) return String(card.dedupeKey);
  const type = String(card.type || 'unknown');
  const meta = card.meta && typeof card.meta === 'object' ? card.meta : {};
  const id = String(card.id || '');

  switch (type) {
    case 'meeting':
      // `cal-<event_id>` — strip the prefix so the key names the event itself.
      return `meeting:${id.startsWith('cal-') ? id.slice(4) : id}`;
    case 'escalation':
      // One escalation names itself. Several are ONE thing — "the pile" — and
      // must keep one key, or every arrival and reply would churn the identity.
      return meta.ticket_key ? `escalation:${meta.ticket_key}` : 'escalation:group';
    case 'nova_flag':
      return `nova_flag:${meta.ticketKey || id}`;
    case 'nudge':
      // The nudge TYPE, never the row id: nudge rows are recreated daily.
      return `nudge:${meta.type || id}`;
    case 'email':
      // The lane, not the top email — the card is about the pile, and the pile
      // is the same thing when its newest member changes.
      return `email:${id === 'email-delegate' ? 'delegate' : 'urgent'}`;
    case 'todo':
      // The title IS the task's own text (the engine leads with the task, not
      // the pile), and no task id is carried through, so the normalised text is
      // the only stable identity available. Same normalisation shape as
      // task-store's dedupe_key.
      return `todo:${_slug(card.title)}`;
    case 'imports':
      return 'imports:pending';
    case 'plan_closure':
      return 'plan_closure';
    default:
      return `${type}:${id || _slug(card.title)}`;
  }
}

// The push types that ARE pool items wearing a different hat. PURE.
//
// This mapping is the point of the whole exercise: `nudges.js` pushes
// `{type:'standup'}` on a timer while `collectNudges` puts a `nudge:standup`
// card on every surface, and until they shared a key those were two independent
// interruptions about one fact — exactly the "must not repeatedly notify Nick
// across widget, push, kiosk and mobile" duplication.
//
// Anything NOT in here is genuinely operational (a watchdog alert, a scheduler
// report) and gets its own namespace, so it can never collide with a real card.
const PUSH_TO_POOL = {
  standup: 'nudge:standup',
  eod: 'nudge:eod',
  journal: 'nudge:journal',
  todo: 'nudge:todo',
  email: 'nudge:email',
  escalation: 'nudge:escalation',
  121: 'nudge:121',
  plan_milestone: 'nudge:plan_milestone',
  escalation_alert: 'escalation:group',
};

/** The record key for a push of `type` about `ref`. PURE. */
function dedupeKeyForPush(type, ref) {
  const t = String(type || 'system');
  if (Object.prototype.hasOwnProperty.call(PUSH_TO_POOL, t)) return PUSH_TO_POOL[t];
  return `operational:${t}:${_slug(ref) || 'general'}`;
}

// ── Pure: evidence ───────────────────────────────────────────────────────────

/**
 * What makes this true, and when we observed it. PURE.
 *
 * ⚠ NEVER invents. An item carrying nothing citable returns `[]`, and that has
 * a real consequence: the notification gate refuses to interrupt on a record
 * with no evidence. Surfacing without evidence is fine — hiding real work
 * because of a bookkeeping gap is the worse error — but an interruption is a
 * claim that something is worth stopping for, and we have to be able to say what.
 */
function evidenceFor(card, now = new Date()) {
  if (!card || typeof card !== 'object') return [];
  const meta = card.meta && typeof card.meta === 'object' ? card.meta : {};
  const seen = now.toISOString();
  const out = [];

  switch (card.type) {
    case 'escalation': {
      const list = Array.isArray(meta.escalations) ? meta.escalations : [];
      for (const e of list) {
        if (!e || !e.key) continue;
        out.push({
          source: 'jira',
          ref: e.key,
          observedAt: e.created || null,
          detail: e.summary || null,
        });
      }
      break;
    }
    case 'meeting':
      if (meta.start) {
        out.push({ source: 'calendar', ref: card.id, observedAt: meta.start, detail: meta.location || null });
      }
      break;
    case 'todo':
      // `source` is the task's provenance — 'vault', 'MS Planner', 'MS ToDo'.
      if (card.title) {
        out.push({
          source: card.source || 'tasks',
          ref: card.title,
          observedAt: meta.dueDate || null,
          detail: Number.isFinite(Number(meta.overdueCount)) ? `${meta.overdueCount} overdue` : null,
        });
      }
      break;
    case 'email':
      if (meta.emailId || meta.from) {
        out.push({
          source: 'email',
          ref: meta.emailId || null,
          observedAt: null,
          detail: meta.subject || meta.from || null,
        });
      }
      break;
    case 'nova_flag':
      if (meta.ticketKey) {
        out.push({
          source: 'nova',
          ref: meta.ticketKey,
          observedAt: null,
          detail: Number.isFinite(Number(meta.riskScore)) ? `risk ${meta.riskScore}` : (meta.summary || null),
        });
      }
      break;
    case 'nudge':
      if (meta.type) {
        out.push({
          source: 'neuro',
          ref: meta.type,
          observedAt: seen,
          detail: Number.isFinite(Number(meta.nagCount)) ? `asked ${meta.nagCount}x` : null,
        });
      }
      break;
    default:
      break;
  }
  return out;
}

// ── Pure: the bounded action set ─────────────────────────────────────────────

/**
 * What Nick may do with this card. PURE, and BOUNDED — a client renders these
 * and nothing else.
 *
 * ⚠ `dismiss` is withheld from an unsuppressable item. An escalation or an
 * imminent meeting is exactly what the engine's `_unsuppressable` flag exists to
 * keep on screen, and offering a button that the engine will refuse to honour is
 * worse than not offering it (`action-presenter`'s blockers rule).
 */
function actionsFor(card) {
  const out = ['acknowledge', 'defer', 'open'];
  // Starting is offered only where a focus session makes sense. A session about
  // "you have a meeting in 10 minutes" is not a session, and a button that
  // cannot mean anything is worse than no button (`action-presenter`'s rule).
  if (isStartable(card)) out.push('start');
  // "Done" always exists on a card Nick can act on. Whether it also closes a
  // TASK is a separate question, answered by `completionTargetFor` — see below.
  out.push('complete');
  if (card && card.unsuppressable === true) return out;
  return [...out, 'dismiss'];
}

/** May a focus session be started on this card? PURE. */
function isStartable(card) {
  return !!card && card.type === 'todo' && !!card.title;
}

/**
 * What "Done" would close, beyond the record itself. PURE.
 *
 * ⚠ Returns a LOOKUP, not an id, and that is forced: `collectOverdueTodos`
 * emits a slug (`todo-overdue-top`) and carries no task id in `meta`, so the
 * only handle on the real row is the task's own text — the same normalised key
 * `focus-session.start` matches on, deliberately reused rather than invented
 * again here.
 *
 * `null` means "resolving this record closes nothing else", which is the
 * correct answer for a meeting, an email pile or a nudge. Guessing a completion
 * for one of those would put work in the ledger nobody did.
 */
function completionTargetFor(card) {
  if (!card || card.type !== 'todo' || !card.title) return null;
  return { kind: 'task', by: 'text', text: String(card.title) };
}

// ── Pure: when may this interrupt ────────────────────────────────────────────

/**
 * What was true when it last interrupted. PURE.
 *
 * ⚠ Deliberately EXCLUDES the text. The governor used to fingerprint the words,
 * so a meeting alert counting down — "in 25 min", "in 10 min" — produced a fresh
 * fingerprint every pass and sailed through the dedupe. A countdown re-rendering
 * is not a state change. An item going `medium` → `critical` is.
 */
function notifySignature(card) {
  if (!card) return '';
  return `${card.urgency || 'none'}|${card.tier ?? 'none'}`;
}

function _parse(json, fallback) {
  if (json == null) return fallback;
  try {
    const v = JSON.parse(json);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/**
 * May this record interrupt Nick right now? PURE — settings and clock in,
 * a verdict and a REASON out.
 *
 * A refusal always names itself, because the whole point of the control surface
 * is that Nick can see why SARA went quiet. A silent system and a working one
 * look identical, which is the failure the push log was added to end.
 *
 * @param {object} record   an attention_records row
 * @param {object} settings from attention-settings.read()
 * @param {object} opts     {now, critical}
 */
function shouldNotify(record, settings, opts = {}) {
  const now = opts.now || new Date();
  const critical = opts.critical === true;

  if (!record) return { allowed: false, reason: 'no attention record' };

  // 1. Lifecycle. Only an active record may interrupt — this is the whole point
  //    of acknowledgement: seen means it stops asking, without being hidden.
  if (record.state !== STATES.ACTIVE) {
    return { allowed: false, reason: `record is ${record.state}` };
  }

  // 2. Evidence. Operational records (a watchdog alert, a scheduler report) are
  //    exempt: their evidence is that a job on this box said so, and refusing to
  //    tell Nick the disk is full because the alert has no Jira key would be the
  //    rule eating the thing it exists to protect.
  if (!record.operational) {
    const evidence = _parse(record.evidence, []);
    if (!Array.isArray(evidence) || evidence.length === 0) {
      return { allowed: false, reason: 'no evidence to cite' };
    }
  }

  // 3. Has anything meaningful changed since it last interrupted?
  const signature = `${record.urgency || 'none'}|${record.tier ?? 'none'}`;
  if (record.notified_at && record.notify_signature === signature) {
    return { allowed: false, reason: 'already notified, nothing changed' };
  }

  // 4. Nick's controls. Critical bypasses these and ONLY these — an escalation
  //    at 23:00 still gets through, but it never bypasses 1-3, so the same
  //    escalation cannot arrive twice.
  if (!critical) {
    if (!settings || settings.enabled === false) {
      return { allowed: false, reason: 'notifications are off' };
    }
    if (settingsStore.isPaused(settings, now)) {
      return { allowed: false, reason: `SARA is paused until ${settings.pausedUntil}` };
    }
    if (settingsStore.isQuietAt(settings, now)) {
      return { allowed: false, reason: 'quiet hours' };
    }
    if (settings.interruptionLevel === 'critical-only') {
      return { allowed: false, reason: 'interruption level is critical-only' };
    }
    if (settings.interruptionLevel === 'normal' && record.urgency === 'low') {
      return { allowed: false, reason: 'low urgency below the interruption level' };
    }
    // The domain split. Unknown domain is treated as WORK, the same asymmetry
    // `shared/task-domain.cjs` argues: a personal item mistaken for work merely
    // stays visible, a work item mistaken for personal goes missing on a Saturday.
    const domain = record.domain === 'personal' ? 'personal' : 'work';
    if (settings.domains && settings.domains[domain] === false) {
      return { allowed: false, reason: `${domain} notifications are off` };
    }
  }

  return { allowed: true, reason: null, signature };
}

/** When this card stops being true, if it is time-bound at all. PURE. */
function expiryFor(card) {
  if (card && card.type === 'meeting' && card.meta && card.meta.start) {
    const start = new Date(card.meta.start).getTime();
    if (Number.isFinite(start)) return new Date(start + MEETING_GRACE_MS).toISOString();
  }
  return null;
}

// ── Persistence ──────────────────────────────────────────────────────────────

let _seq = 0;
function _newId(now) {
  _seq = (_seq + 1) % 100000;
  return `att_${now.getTime().toString(36)}_${_seq.toString(36)}`;
}

function _event(recordId, event, at, detail) {
  try {
    db.logAttentionEvent(recordId, event, at, detail);
  } catch (e) {
    console.warn('[Attention] Could not log event:', e.message);
  }
}

function _shape(card, now, confidence) {
  const meta = card.meta && typeof card.meta === 'object' ? card.meta : {};
  return {
    dedupeKey: dedupeKeyFor(card),
    type: card.type || 'unknown',
    title: card.title || null,
    say: card.say || null,
    reason: card.reason || null,
    tab: card.tab || null,
    urgency: card.urgency || null,
    tier: card.tier ?? null,
    score: card.score ?? null,
    domain: meta.domain || null,
    confidence: confidence || null,
    evidence: evidenceFor(card, now),
    actions: actionsFor(card),
    // The engine's own item id rides along so `dismiss` can teach
    // `decision-engine.dismiss()`, which is keyed on ITS id and not on ours.
    // It is unstable (that is why it is not the identity) but it is correct at
    // the moment of the sighting, which is the only moment dismissal uses it.
    meta: { ...meta, _engineId: card.id || null },
    lastSeenAt: now.toISOString(),
  };
}

/**
 * Open or refresh a record for one card, and return the row.
 *
 * ⚠ A re-sighting refreshes the VOLATILE half only. It never touches state,
 * `defer_until` or `notified_at`: a fresh sighting is evidence the thing still
 * exists, not Nick changing his mind. Letting the generator reset a deferral
 * would make "snooze" mean "snooze until the next poll", which at a 60-second
 * ambient refresh is no snooze at all.
 */
function upsert(card, { now = new Date(), confidence = null, operational = false } = {}) {
  const shaped = _shape(card, now, confidence);
  if (!shaped.dedupeKey) return null;

  const existing = db.getOpenAttentionRecord(shaped.dedupeKey);
  if (existing) {
    // ⚠ An OPERATIONAL sighting never overwrites an existing record. A push
    // carries only what its caller happened to pass — `nudges.js` sends a type
    // and a sentence — while the pool record carries the engine's urgency, tier,
    // evidence and nag count. Touching it here would flatten a `high` nudge to
    // the push path's default and quietly reset the escalation the nag tone is
    // built on. The push is here to READ the record, not to define it.
    if (operational) return existing;
    return db.touchAttentionRecord(existing.id, shaped);
  }

  const id = _newId(now);
  const at = now.toISOString();
  const row = db.insertAttentionRecord({
    ...shaped,
    id,
    state: STATES.ACTIVE,
    operational,
    firstSeenAt: at,
    stateChangedAt: at,
  });
  _event(id, 'opened', at, shaped.reason || null);
  return row;
}

/**
 * Reconcile a gated feed against stored records.
 *
 * `cards` are what the gate chose to SURFACE. Records are opened for those, and
 * for `held` — the items the gate dropped — because a dropped item is held, not
 * gone, and it must keep its identity so that acknowledging it in a quiet moment
 * still counts when it comes back.
 */
function reconcile(cards, { now = new Date(), confidence = null, held = [] } = {}) {
  const records = [];
  const at = now.toISOString();

  for (const card of Array.isArray(cards) ? cards : []) {
    if (!card || card.kind === 'context') continue;  // the frame is not a job
    const row = upsert(card, { now, confidence });
    if (!row) continue;
    if (!row.surfaced_at) {
      db.markAttentionSurfaced(row.id, at);
      _event(row.id, 'surfaced', at, card.reason || null);
      row.surfaced_at = at;
    }
    records.push(row);
  }

  // Held items get a record but are NOT marked surfaced — they never reached a
  // screen, and stamping them would make the history claim they had.
  for (const card of Array.isArray(held) ? held : []) {
    if (!card || card.kind === 'context') continue;
    upsert(card, { now, confidence });
  }

  return records;
}

/** A deferred record whose window has passed returns to active on its own. */
function releaseDeferrals(now = new Date()) {
  const at = now.toISOString();
  let released = 0;
  for (const row of db.getExpiredDeferrals(at)) {
    db.setAttentionState(row.id, STATES.ACTIVE, at, {});
    _event(row.id, 'surfaced', at, `deferral ended (${row.defer_reason || 'unspecified'})`);
    released += 1;
  }
  return released;
}

/**
 * Age out records nothing has seen for a while.
 *
 * ⚠ Only ever runs while the pool is READABLE. Expiring records during an
 * outage would quietly clear the board on the strength of not having looked —
 * the exact false all-clear this whole layer exists to prevent.
 */
function sweep({ now = new Date(), poolAvailable = false } = {}) {
  const at = now.toISOString();
  let expired = 0;
  if (!poolAvailable) return { expired, skipped: 'pool unavailable' };

  for (const row of db.getOpenAttentionRecords()) {
    if (row.operational) continue;   // an ops alert has no pool to be absent from
    const lastSeen = new Date(row.last_seen_at).getTime();
    const stale = Number.isFinite(lastSeen) && now.getTime() - lastSeen > STALE_AFTER_MS;
    const meta = _parse(row.meta, {});
    const past = row.type === 'meeting' && meta.start
      ? new Date(new Date(meta.start).getTime() + MEETING_GRACE_MS).getTime() < now.getTime()
      : false;
    if (!stale && !past) continue;
    // EXPIRED, not resolved: Nick decided nothing, and a record of what he
    // actually chose must not be padded with things that merely timed out.
    db.setAttentionState(row.id, STATES.EXPIRED, at, { resolution: past ? 'moment-passed' : 'aged-out' });
    _event(row.id, 'expired', at, past ? 'its moment passed' : 'no fresh evidence');
    expired += 1;
  }
  return { expired };
}

/**
 * Nick acted on a card.
 *
 * ⚠ Dismissal teaches suppression; it NEVER touches the canonical work.
 * Dismissing a card about an overdue task does not complete, delete or
 * reschedule that task — the card is NEURO's opinion about what deserves
 * attention, and disagreeing with the opinion is not doing the job.
 */
function act(recordId, action, opts = {}) {
  const now = opts.now || new Date();
  const at = now.toISOString();
  const row = db.getAttentionRecord(recordId);
  if (!row) return { ok: false, error: 'no such attention record' };
  if (![STATES.ACTIVE, STATES.ACKNOWLEDGED, STATES.DEFERRED].includes(row.state)) {
    return { ok: false, error: `record is ${row.state} and cannot be changed` };
  }

  switch (action) {
    // ⚠ Starting changes NOTHING about the record. A focus session is Nick
    // picking the thing up, not finishing it, and the whole reason the old
    // "Do it" button was wrong is that it recorded an outcome at the moment the
    // work BEGAN. The event is kept as evidence (Work Package C reads it); the
    // state is left exactly where it was.
    case 'start':
      _event(recordId, 'started', at, opts.note || null);
      return { ok: true, record: row };

    // Explicit confirmation from Nick, and the ONLY path that resolves. The
    // underlying task is closed too where one can be found — never guessed, and
    // never silently skipped: `taskCompleted` and `taskWhy` ride back so the
    // surface can say what actually happened rather than implying both.
    case 'complete': {
      let taskCompleted = false;
      let taskWhy = 'nothing to complete';
      const target = completionTargetFor({
        type: row.type,
        title: row.title,
      });
      if (target) {
        try {
          const taskStore = require('./task-store');
          const match = db.getTaskByDedupeKey(taskStore.dedupeKey(target.text));
          if (!match) {
            taskWhy = 'no matching task in the store';
          } else if (match.status === 'done') {
            taskWhy = 'task was already done';
          } else {
            // ⚠ `task-store.setStatus` owns the outcome-note hold
            // (`task-blocks`), so a held tick comes back held rather than being
            // forced through here. Its refusal is reported, not swallowed.
            const updated = taskStore.setStatus(match.id, 'done');
            taskCompleted = !(updated && updated.held);
            taskWhy = taskCompleted
              ? `task #${match.id} completed`
              : `task #${match.id} is held — ${(updated && updated.held && updated.held.reason) || 'awaiting a write-up'}`;
          }
        } catch (e) {
          taskWhy = e.message;
        }
      }
      _event(recordId, 'resolved', at, taskCompleted ? `done — ${taskWhy}` : `done — ${taskWhy}`);
      return {
        ok: true,
        taskCompleted,
        taskWhy,
        record: db.setAttentionState(recordId, STATES.RESOLVED, at, { resolution: 'completed' }),
      };
    }

    case 'acknowledge':
      _event(recordId, 'acknowledged', at, opts.note || null);
      return { ok: true, record: db.setAttentionState(recordId, STATES.ACKNOWLEDGED, at, {}) };

    case 'defer': {
      const mins = Number(opts.minutes);
      if (!Number.isFinite(mins) || mins <= 0) return { ok: false, error: 'defer needs a positive minutes' };
      const capped = Math.min(mins, 7 * 24 * 60);
      const reason = DEFER_REASONS.has(opts.reason) ? opts.reason : 'unspecified';
      const until = new Date(now.getTime() + capped * 60000).toISOString();
      _event(recordId, 'deferred', at, `${capped}m — ${reason}`);
      return { ok: true, record: db.setAttentionState(recordId, STATES.DEFERRED, at, { deferUntil: until, deferReason: reason }) };
    }

    case 'dismiss': {
      const actions = _parse(row.actions, []);
      if (Array.isArray(actions) && !actions.includes('dismiss')) {
        return { ok: false, error: 'this item cannot be dismissed' };
      }
      // Teach the engine, using the id it knows. The engine's suppression is
      // keyed on ITS id, so the record carries it in meta for exactly this.
      try {
        const engineId = _parse(row.meta, {})._engineId;
        if (engineId) require('./decision-engine').dismiss(engineId, row.type);
      } catch (e) {
        console.warn('[Attention] Could not teach suppression:', e.message);
      }
      _event(recordId, 'dismissed', at, opts.reason || null);
      return { ok: true, record: db.setAttentionState(recordId, STATES.SUPPRESSED, at, { resolution: 'dismissed' }) };
    }

    case 'resolve':
      _event(recordId, 'resolved', at, opts.note || 'acted');
      return { ok: true, record: db.setAttentionState(recordId, STATES.RESOLVED, at, { resolution: opts.resolution || 'acted' }) };

    default:
      return { ok: false, error: `unknown action: ${action}` };
  }
}

/**
 * Record that a notification went out (or did not), against its record.
 * Never allowed to throw: the push has already left, and a bookkeeping error
 * must not become a delivery error (`sent-replies`' rule).
 */
function recordNotification(recordId, { allowed, reason, signature, now = new Date() }) {
  const at = now.toISOString();
  try {
    if (allowed) {
      db.markAttentionNotified(recordId, at, signature || null);
      _event(recordId, 'notified', at, reason || null);
    } else {
      _event(recordId, 'notify-refused', at, reason || null);
    }
  } catch (e) {
    console.warn('[Attention] Could not record notification:', e.message);
  }
}

/** A stored row, rendered for a client. Parses the JSON columns once, here. */
function present(row) {
  if (!row) return null;
  return {
    recordId: row.id,
    dedupeKey: row.dedupe_key,
    // The decision-engine item id this record was last seen as.
    //
    // ⚠ UNSTABLE by construction — `collectOverdueTodos` emits
    // `todo-overdue-top` for one overdue task and `todo-overdue-summary` for
    // two — which is exactly why `dedupe_key` and not this is the identity.
    // It is exposed for ONE job: a legacy surface still reading `/api/focus`
    // holds an engine id and nothing else, and this is the only way it can find
    // the canonical record to act on. Anything with a `recordId` in hand must
    // use that; anything storing this is storing something that changes.
    engineId: _parse(row.meta, {})._engineId || null,
    type: row.type,
    state: row.state,
    title: row.title,
    say: row.say,
    reason: row.reason,
    tab: row.tab,
    urgency: row.urgency,
    tier: row.tier,
    domain: row.domain,
    operational: row.operational === 1,
    confidence: _parse(row.confidence, null),
    evidence: _parse(row.evidence, []),
    actions: _parse(row.actions, []),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    surfacedAt: row.surfaced_at,
    notifiedAt: row.notified_at,
    deferUntil: row.defer_until,
    deferReason: row.defer_reason,
    resolution: row.resolution,
  };
}

module.exports = {
  // pure
  dedupeKeyFor,
  dedupeKeyForPush,
  evidenceFor,
  actionsFor,
  isStartable,
  completionTargetFor,
  notifySignature,
  shouldNotify,
  expiryFor,
  // stateful
  upsert,
  reconcile,
  releaseDeferrals,
  sweep,
  act,
  recordNotification,
  present,
  STATES,
  DEFER_REASONS,
  STALE_AFTER_MS,
};
