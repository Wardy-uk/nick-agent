'use strict';

/**
 * How to render a pending SARA action so it can be approved SAFELY.
 *
 * This exists because the approval screen and the executor have to agree, and
 * the only way they stay agreed is if the description is derived on the server,
 * next to `suggestion-engine.executeAction`, from the SAME stored payload the
 * executor will read. Rebuilding the summary in the frontend gives you a screen
 * free to drift from what actually sends — which for outbound email is the
 * whole risk.
 *
 * Three things every entry owes the caller:
 *
 *   1. `body` — the full text, verbatim, for anything outbound. Not a summary.
 *      You cannot approve an email to a direct report from a one-line gist.
 *   2. `blockers` — the executor's own `{ ok:false }` guards, restated. A
 *      non-empty list means approve is DISABLED and the reason is on screen,
 *      rather than an approve that quietly fails.
 *   3. `warnings` — things that are true, survivable, and worth reading first
 *      (this one emails eight people; this one has no stored address).
 *
 * Only guards that can be checked from the payload alone live here. Anything
 * needing I/O (does the waiting-on item still exist, is Microsoft signed in) is
 * the executor's to discover and report — a blocker that needs a Graph call is
 * a blocker that makes the list slow and still sometimes wrong.
 *
 * `KIND` drives how loud the card is:
 *   outbound — leaves the building. Real email, real Teams DM, real invites.
 *   write    — changes NEURO or the vault. Reversible, internal.
 *   navigate — changes nothing; approving it just moves the screen.
 */

const OUTBOUND = 'outbound';
const WRITE = 'write';
const NAVIGATE = 'navigate';

const str = (v) => (v == null ? '' : String(v));
const trimmed = (v) => str(v).trim();

/** Graph's emailAddress is { name, address }; our helpers use { name, email }. Take either. */
function addressOf(person) {
  if (!person) return null;
  return person.email || person.address || null;
}

function field(label, value, opts = {}) {
  const v = trimmed(value);
  return v ? { label, value: v, mono: Boolean(opts.mono) } : null;
}

const PRESENTERS = {
  // ── navigation: approving these writes nothing ──────────────────────────

  open_ticket: (p) => ({
    label: 'Open ticket',
    kind: NAVIGATE,
    summary: p.ticketKey ? `Jump to ${p.ticketKey}` : `Jump to the ${p.filter || 'queue'}`,
    fields: [field('Ticket', p.ticketKey, { mono: true }), field('Filter', p.filter)],
  }),

  open_task: (p) => ({
    label: 'Open tasks',
    kind: NAVIGATE,
    summary: `Jump to ${p.filter ? `tasks (${p.filter})` : 'your task list'}`,
    fields: [field('Filter', p.filter)],
  }),

  open_email: (p) => ({
    label: 'Open inbox',
    kind: NAVIGATE,
    summary: 'Jump to the inbox',
    fields: [field('Filter', p.filter)],
  }),

  open_standup: () => ({
    label: 'Open standup',
    kind: NAVIGATE,
    summary: 'Jump to the standup',
    fields: [],
  }),

  // ── outbound: these leave the building ──────────────────────────────────

  // Gate 1 of 2. Approving this SENDS NOTHING — it writes the words and queues
  // a separate reply_email carrying them. Saying so on the card is the point:
  // an approve button that looks like it sends and doesn't is its own bug.
  draft_reply: (p) => ({
    label: 'Draft a reply',
    kind: WRITE,
    summary: `Write a reply to ${p.from || 'the sender'} — nothing is sent`,
    note: 'Gate 1 of 2. This drafts the words and queues a separate send for you to approve. Nothing leaves until that second approval.',
    fields: [
      field('From', p.from),
      field('Subject', p.subject),
    ],
    body: trimmed(p.body) || null,
    bodyLabel: p.body ? 'Draft so far' : null,
    blockers: p.emailId ? [] : ['No emailId on this action — there is no thread to reply to.'],
    warnings: p.body ? [] : ['No draft stored yet, so approving asks the model to write one. You approve the words at gate 2.'],
  }),

  // Gate 2. This one really sends.
  reply_email: (p) => {
    const explicit = Array.isArray(p.to) ? p.to.map(t => addressOf(t) || str(t)).filter(Boolean) : [];
    const blockers = [];
    if (!p.emailId) blockers.push('No emailId on this action — there is no thread to reply to.');
    if (!trimmed(p.body)) blockers.push('No body stored — there is nothing to send.');
    return {
      label: 'Send email reply',
      kind: OUTBOUND,
      summary: `Send this reply${p.subject ? ` on "${p.subject}"` : ''}`,
      fields: [
        field('Subject', p.subject),
        // Empty means Graph replies to the thread's own participants. Say that
        // rather than leaving the recipient line blank on an outbound send.
        { label: 'To', value: explicit.length ? explicit.join(', ') : 'the sender on the original thread', mono: explicit.length > 0 },
        p.replyAll ? field('Mode', 'reply-all') : null,
      ],
      body: trimmed(p.body) || null,
      bodyLabel: 'This is what will be sent',
      blockers,
      warnings: p.replyAll ? ['Reply-all: everyone on the original thread receives this.'] : [],
    };
  },

  chase_commitment: (p) => {
    const to = p.to || {};
    const email = addressOf(to);
    return {
      label: 'Chase a commitment',
      kind: OUTBOUND,
      summary: `Ask ${p.person || 'them'} where a commitment got to`,
      fields: [
        field('Person', p.person),
        {
          label: 'To',
          value: email
            || `not stored${to.status ? ` (${to.status})` : ''} — the directory is asked on approval`,
          mono: Boolean(email),
        },
        field('Channel', p.channel === 'teams' ? 'Teams DM, falling back to email' : 'Email'),
        field('From note', p.sourcePath),
      ],
      body: trimmed(p.body) || null,
      bodyLabel: 'This is what will be sent',
      blockers: p.waitingKey ? [] : ['No waiting-on key on this action — nothing to chase.'],
      // NOT a blocker: the executor re-resolves a missing address and refuses
      // rather than guessing. But an unresolvable name fails at approve time,
      // so say where the address is set before that happens.
      warnings: email ? [] : ['No address stored. Approving resolves it from the directory, and a name that comes back ambiguous will fail — set one on the People board under Waiting on.'],
      // The address editor is scoped to chase_commitment and lives beside the
      // commitment it belongs to. Point at it rather than building a second one.
      link: email ? null : { view: 'people', text: 'Set the address on the People board' },
    };
  },

  chase_agenda: (p) => {
    const email = addressOf(p.organizer);
    const blockers = [];
    if (!p.eventId) blockers.push('No eventId on this action.');
    if (!trimmed(p.body)) blockers.push('No chaser text stored — there is nothing to send.');
    if (!email) blockers.push('No organiser address — there is nowhere to send it.');
    return {
      label: 'Ask what a meeting is for',
      kind: OUTBOUND,
      summary: `Email ${p.organizer?.name || 'the organiser'} about "${p.subject || 'their meeting'}"`,
      fields: [
        field('Meeting', p.subject),
        { label: 'To', value: email || 'unknown', mono: Boolean(email) },
        field('Reply subject', p.subject ? `Re: ${p.subject}` : null),
      ],
      body: trimmed(p.body) || null,
      bodyLabel: 'This is what will be sent',
      blockers,
    };
  },

  respond_meeting: (p) => {
    const verb = { decline: 'Decline', accept: 'Accept', tentative: 'Tentatively accept' }[p.response || 'decline'];
    return {
      label: 'Respond to an invite',
      kind: OUTBOUND,
      summary: `${verb} "${p.subject || p.eventId}"${p.proposedNewTime ? ', proposing a new time' : ''}`,
      fields: [
        field('Meeting', p.subject),
        field('Response', verb),
        field('New time proposed', p.proposedNewTime),
      ],
      body: trimmed(p.comment) || null,
      bodyLabel: p.comment ? 'Comment the organiser will see' : null,
      blockers: p.eventId ? [] : ['No eventId on this action.'],
      // Graph refuses a counter-proposal on an accept, and the executor reports
      // it as a failure. Cheaper to say so before the button than after.
      warnings: (p.response === 'accept' && p.proposedNewTime)
        ? ['Graph will not take a counter-proposal on an accept — this will fail.']
        : [],
    };
  },

  schedule_focus_block: (p) => {
    const attendees = Array.isArray(p.attendees) ? p.attendees : [];
    const blockers = [];
    // Only a start that was GIVEN and is unparseable blocks. No start at all is
    // fine — the executor defaults to the next half hour.
    if (p.start && Number.isNaN(new Date(p.start).getTime())) {
      blockers.push(`Unparseable start time: ${p.start}`);
    }
    const minutes = Number(p.minutes) > 0 ? Number(p.minutes) : 60;
    return {
      label: 'Book time in the diary',
      kind: attendees.length ? OUTBOUND : WRITE,
      summary: `Create "${p.subject || 'Focus block'}"${p.start ? '' : ' at the next half hour'} for ${minutes} min`,
      fields: [
        field('Subject', p.subject || 'Focus block'),
        field('Starts', p.start || 'next half hour'),
        field('Length', `${minutes} min`),
        field('Location', p.location),
        attendees.length
          ? { label: 'Invites', value: attendees.map(a => addressOf(a) || str(a.name) || str(a)).filter(Boolean).join(', '), mono: true }
          : null,
      ],
      body: trimmed(p.body) || null,
      bodyLabel: p.body ? 'Event body' : null,
      blockers,
      warnings: attendees.length
        ? [`Graph emails a real invite to ${attendees.length} ${attendees.length === 1 ? 'person' : 'people'}.`]
        : [],
    };
  },

  // ── writes: internal and reversible ─────────────────────────────────────

  complete_task: (p) => {
    const where = [];
    if (p.taskId) where.push(`NEURO task #${p.taskId}`);
    if (p.msId) where.push('Microsoft To Do / Planner');
    if (p.filePath) where.push(`the vault line in ${p.filePath}`);
    return {
      label: 'Complete a task',
      kind: p.msId ? OUTBOUND : WRITE,
      summary: where.length ? `Tick off ${where.join(', ')}` : 'Tick off a task',
      fields: [
        field('Task', p.text),
        field('NEURO id', p.taskId, { mono: true }),
        field('Microsoft id', p.msId, { mono: true }),
        field('Vault line', p.filePath ? `${p.filePath}:${p.lineNumber}` : null, { mono: true }),
      ],
      blockers: (p.taskId || p.msId) ? [] : ['Needs a taskId or an msId — there is nothing to complete.'],
    };
  },

  capture_todo: (p) => ({
    label: 'Create a task',
    kind: WRITE,
    summary: `Add "${str(p.text).slice(0, 80)}" to your tasks`,
    fields: [
      field('Task', p.text),
      field('MoSCoW', p.metadata?.moscow),
      field('Priority', p.metadata?.priority),
      field('Due', p.metadata?.dueDate || p.dueDate),
      field('From note', p.sourcePath),
    ],
    blockers: trimmed(p.text) ? [] : ['No task text on this action.'],
  }),

  escalate_ticket: (p) => ({
    label: 'Escalate a ticket',
    kind: OUTBOUND,
    summary: `Escalate ${p.ticketKey || 'a ticket'} in NOVA`,
    fields: [
      field('Ticket', p.ticketKey, { mono: true }),
      field('Reason', p.reasonLabel || p.reason),
      field('Due date', p.dueDate),
    ],
    body: trimmed(p.comment) || null,
    bodyLabel: p.comment ? 'Internal comment NOVA will add' : null,
    blockers: p.ticketKey ? [] : ['No ticketKey on this action.'],
    warnings: ['NOVA raises the priority and tightens the due date. Internal comment only — the customer sees nothing.'],
  }),
};

/** Every type `suggestion-engine.executeAction` handles. Pinned by the test. */
const KNOWN_TYPES = Object.keys(PRESENTERS);

/**
 * Describe one action for the approval screen.
 *
 * An unknown type still gets a card — it is pending, so it is real, and hiding
 * it would recreate the exact "built but unreachable" hole this list exists to
 * close. It just cannot be approved, because `executeAction` would refuse it.
 */
function describe(action) {
  const payload = action?.payload || {};
  const build = PRESENTERS[action?.type];

  if (!build) {
    return {
      label: action?.type || 'Unknown action',
      kind: WRITE,
      summary: 'No presenter for this action type',
      fields: [],
      body: null,
      bodyLabel: null,
      note: null,
      link: null,
      blockers: [`executeAction has no case for "${action?.type}" — approving it would fail.`],
      warnings: [],
      canApprove: false,
    };
  }

  const out = build(payload) || {};
  const blockers = (out.blockers || []).filter(Boolean);
  return {
    label: out.label || action.type,
    kind: out.kind || WRITE,
    summary: out.summary || '',
    note: out.note || null,
    link: out.link || null,
    fields: (out.fields || []).filter(Boolean),
    body: out.body || null,
    bodyLabel: out.bodyLabel || null,
    blockers,
    warnings: (out.warnings || []).filter(Boolean),
    canApprove: blockers.length === 0,
  };
}

module.exports = { describe, KNOWN_TYPES, OUTBOUND, WRITE, NAVIGATE };
