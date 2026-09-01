import React, { useState, useEffect } from 'react';
import { apiUrl } from '../api';
import PersonDetail from './PersonDetail';
import WaitingOn from './WaitingOn';
import './PeopleBoard.css';

// Current direct reports, grouped for display. Leavers and people who move to
// another manager come out of here AND get `archived: true` in their People note
// — the note is what the backend scan reads, this list is what the board draws.
//
// This copy was the one kept up to date: when #13 found the same roster typed
// out in six other places, all six had drifted and this one had not. It is kept
// hardcoded because it carries PeopleHR ids and display notes that no People
// note holds — but it is still a copy, so if it ever disagrees with the vault,
// the vault wins. `GET /api/team-health/roster` is the derived truth.
const TEAMS = {
  '2nd Line Technical Support': [
    { name: 'Abdi Mohamed', id: 'D2V00471', role: '2nd Line Support Analyst' },
    { name: 'Luke Scaife', id: 'D2V00506', role: '2nd Line Support Analyst' },
    { name: 'Stephen Mitchell', id: 'D2V00391', role: 'Support Analyst', note: 'Trialling queue hygiene lead' },
    { name: 'Sebastian Broome', id: 'D2V00500', role: '2nd Line Support Analyst' },
  ],
  '1st Line Customer Care': [
    { name: 'Adele Norman-Swift', id: 'D2V00427', role: 'Customer Service Agent' },
    { name: 'Heidi Power', id: 'D2V00505', role: 'Customer Service Agent', note: 'Active improvement window' },
    { name: 'Hope Goodall', id: '520', role: 'Customer Service Agent', note: 'Transitioning to call-taking' },
    { name: 'Maria Pappa', id: 'D2V00403', role: 'Customer Service Agent' },
    { name: 'Naomi Wentworth', id: 'D2V00509', role: 'Customer Service Agent', note: 'Confluence triage guide owner' },
    { name: 'Nathan Rutland', id: 'D2V00269', role: 'Senior Customer Service Agent' },
    { name: 'Zoe Rees', id: '517', role: 'Customer Service Agent' },
  ],
  'Digital Design': [
    { name: 'Isabel Busk', id: 'D2V00359', role: 'Digital Design Executive' },
    { name: 'Kayleigh Russell', id: 'D2V00318', role: 'Digital Design Executive' },
  ],
};

function getSaraStatus(person, vaultData, summaries, detectedLast) {
  const fm = vaultData?.frontmatter || {};
  const empStatus = (fm['employment-status'] || '').toLowerCase();
  const status = (fm.status || '').toLowerCase();
  const tags = (vaultData?.tags || []).map(t => t.toLowerCase());
  const tasks = summaries?.[person.name]?.tasks || [];
  const overdueTasks = tasks.filter(t => t.overdue);

  const s121 = get121Status(fm, detectedLast);

  // A booking that has been and gone with nothing written, over a gap that is ALSO past
  // its cadence date, is an overdue 1-2-1 wearing a diary entry. It reads as overdue —
  // the label still says what happened, so the "write it up or rebook" prompt survives.
  if (s121?.status === 'overdue' || (s121?.status === 'unwritten' && s121?.daysOverdue)) {
    return { word: 'overdue', tone: 'danger', reason: s121.label };
  }
  if (status === 'risk' || empStatus.includes('improvement')) return { word: 'slipping', tone: 'danger', reason: empStatus || 'Flagged at risk' };
  if (empStatus.includes('probation')) return { word: 'watch', tone: 'warning', reason: 'Probation' };
  if (tags.includes('blocked') || status === 'blocked') return { word: 'blocked', tone: 'warning', reason: 'Tagged blocked' };
  if (s121?.status === 'due-soon') return { word: 'watch', tone: 'warning', reason: s121.label };
  // A 1-2-1 that happened but was never written up isn't "overdue" — nothing
  // needs booking. It's a gap in the record, so it watches rather than alarms.
  if (s121?.status === 'unwritten') return { word: 'watch', tone: 'warning', reason: s121.label };
  if (overdueTasks.length > 0) return { word: 'watch', tone: 'warning', reason: `${overdueTasks.length} overdue task${overdueTasks.length > 1 ? 's' : ''}` };
  if (status === 'flag' || person.note) return { word: 'watch', tone: 'warning', reason: person.note || 'Flagged' };
  return { word: 'solid', tone: 'ok', reason: '' };
}

function buildTeamSaraLine(teams, peopleData, personSummaries, oneToOnes) {
  const allPeople = Object.values(teams).flat();
  const statuses = allPeople.map(p => getSaraStatus(p, peopleData[p.name], personSummaries, latest121(oneToOnes, p.name)));
  const overdue = statuses.filter(s => s.word === 'overdue' || s.word === 'slipping');
  const watching = statuses.filter(s => s.word === 'watch');
  const solid = statuses.filter(s => s.word === 'solid');

  const parts = [];
  if (overdue.length > 0) parts.push(`${overdue.length} need attention.`);
  if (watching.length > 0) parts.push(`${watching.length} on watch.`);
  if (solid.length > 0 && overdue.length === 0) parts.push(`${solid.length} solid.`);
  if (overdue.length === 0 && watching.length === 0) parts.push('Team looks good right now.');

  const overdueNames = allPeople
    .filter((_, i) => statuses[i].word === 'overdue')
    .map(p => p.name.split(' ')[0]);
  if (overdueNames.length > 0 && overdueNames.length <= 3) {
    parts.push(`${overdueNames.join(', ')} — 1-2-1 overdue.`);
  }

  return parts.join(' ');
}

// Mirrors one-to-one-detect.cadenceState() on the server. A 1-2-1 already in the
// diary reads "Booked", never "Overdue": `1-2-1-booked` is what is in the
// calendar, `next-1-2-1-due` is only ever when the next one is OWED.
//
// `detectedLast` is the date of the newest 1-2-1 note the DETECTOR found — the
// same list `RecentOneToOnes` renders directly underneath this badge. It has to
// be an input, because the frontmatter stamp only catches up when
// syncPeopleNotes runs at 22:00: for the whole of the day a 1-2-1 is written up,
// the card showed the note's summary and, one line above it, "no note". Same
// rule as everywhere else — a 1-2-1 is DETECTED, not declared, so the stamp is
// the lagging copy and never the arbiter. When the detector is ahead, the due
// date is recomputed from it exactly as syncPeopleNotes will tonight; reading
// the stale `next-1-2-1-due` would only trade "no note" for "overdue by 98d".
function get121Status(frontmatter, detectedLast) {
  const stamped = isoDateOrNull(frontmatter?.['last-1-2-1']);
  const detected = isoDateOrNull(detectedLast);
  // ⚠ Folds on EQUAL as well as newer. Once the 22:00 sync stamps the same date the
  // detector found, a strict `>` stops folding and hands back the STORED due date —
  // which can be stale or, live on 1 Sep 2026, EARLIER than the 1-2-1 it is meant to
  // follow (Isabel Busk: last 25 Aug, stored due 12 Aug, card read "Overdue by 20d" the
  // week after the meeting). Recomputing from last + cadence is always at least as
  // correct as trusting a number nothing maintains.
  const ahead = detected && (!stamped || detected >= stamped);
  const last = ahead ? detected : stamped;
  const due = ahead
    ? addDays(last, cadenceDays(frontmatter?.cadence))
    : isoDateOrNull(frontmatter?.['next-1-2-1-due']);
  const booked = isoDateOrNull(frontmatter?.['1-2-1-booked']);

  const dayDelta = (from) => {
    const d = new Date(`${from}T12:00:00`);
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    return Math.round((d - today) / (1000 * 60 * 60 * 24));
  };

  if (booked) {
    const untilBooked = dayDelta(booked);
    if (untilBooked >= 0) {
      return { status: 'booked', daysUntil: untilBooked, label: untilBooked === 0 ? 'Booked today' : `Booked ${booked}` };
    }
    // Been and gone with nothing written up — a missing note, or a cancellation
    // nobody recorded. Not the same as never having booked one.
    if (!last || last < booked) {
      // ⚠ "Scheduled", never "Met". A booking is a diary entry, not evidence anyone
      // turned up — and the card said "Met 2026-08-21" about a 1-2-1 that never
      // happened. It also must not swallow the overdue fact: Sebastian Broome's stale
      // booking hid a 48-day gap and dropped him off the overdue list entirely.
      const overdueBy = due ? -dayDelta(due) : null;
      const overdueSuffix = overdueBy > 0 ? ` · overdue by ${overdueBy}d` : '';
      return {
        status: 'unwritten',
        daysUntil: untilBooked,
        daysOverdue: overdueBy > 0 ? overdueBy : null,
        label: `Scheduled ${booked} — no note${overdueSuffix}`,
      };
    }
  }

  if (!due) return null;
  const daysUntil = dayDelta(due);
  if (daysUntil < 0) return { status: 'overdue', daysUntil, label: `Overdue by ${Math.abs(daysUntil)}d` };
  if (daysUntil <= 3) return { status: 'due-soon', daysUntil, label: `Due in ${daysUntil}d` };
  return { status: 'ok', daysUntil, label: `Due ${due}` };
}

function ApprovalPanel({ approvals, onRefresh }) {
  const [expanded, setExpanded] = useState(null); // id of expanded approval
  const [additionalSteps, setAdditionalSteps] = useState({});
  const [emailOverrides, setEmailOverrides] = useState({});
  const [acting, setActing] = useState(null); // id being acted on
  const [statusMsg, setStatusMsg] = useState({});

  if (!approvals.length) return null;

  const handleApprove = async (approval) => {
    setActing(approval.id);
    setStatusMsg({});
    try {
      const res = await fetch(apiUrl(`/api/n8n/121/approve/${approval.id}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentEmail: emailOverrides[approval.id] || approval.agentEmail,
          agentName: approval.agentName,
          additionalSteps: additionalSteps[approval.id] || '',
          worstQaCount: 0,
        })
      });
      const data = await res.json();
      if (data.success) {
        // Auto-download the MD review file
        const date = new Date().toISOString().split('T')[0];
        const fileName = `${date} – ${approval.agentName} 30-Day Performance Review.md`;
        let markdown = approval.markdown || '';
        const extra = (additionalSteps[approval.id] || '').trim();
        if (extra) {
          const lines = extra.split('\n').map(s => '- [ ] ' + s.trim()).filter(s => s.length > 6).join('\n');
          markdown = markdown.replace(/## Tracking/, lines + '\n\n## Tracking');
        }
        const frontmatter = `---\ntype: performance-review\nperson: "[[People/${approval.agentName}|${approval.agentName}]]"\ndate: ${date}\nsource: n8n-workflow\n---\n\n`;
        const blob = new Blob([frontmatter + markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);

        setStatusMsg(prev => ({ ...prev, [approval.id]: { type: 'ok', text: 'Approved — file downloaded, workflow resumed' } }));
        setTimeout(onRefresh, 1500);
      } else {
        setStatusMsg(prev => ({ ...prev, [approval.id]: { type: 'err', text: data.error || 'Approval failed' } }));
      }
    } catch (e) {
      setStatusMsg(prev => ({ ...prev, [approval.id]: { type: 'err', text: e.message } }));
    }
    setActing(null);
  };

  const handleDismiss = async (approval) => {
    setActing(approval.id);
    try {
      await fetch(apiUrl(`/api/n8n/121/dismiss/${approval.id}`), { method: 'POST' });
      onRefresh();
    } catch { /* ignore */ }
    setActing(null);
  };

  return (
    <div className="approval-panel">
      <div className="approval-panel-header">
        <span className="approval-panel-title">Pending Review Approvals</span>
        <span className="approval-badge">{approvals.length}</span>
      </div>
      <div className="approval-list">
        {approvals.map(a => (
          <div key={a.id} className="approval-item">
            <div className="approval-item-header">
              <span className="approval-item-name">{a.agentName}</span>
              <span className="approval-item-date">{new Date(a.receivedAt).toLocaleString()}</span>
            </div>
            {a.subject && <div className="approval-item-subject">{a.subject}</div>}
            <button
              className="approval-preview-toggle"
              onClick={() => setExpanded(expanded === a.id ? null : a.id)}
            >
              {expanded === a.id ? 'Hide Preview' : 'Show Preview'}
            </button>
            {expanded === a.id && (
              <>
                <div
                  className="approval-preview"
                  dangerouslySetInnerHTML={{ __html: (a.draftHtml || '')
                    .replace(/<a[^>]*Approve[^<]*<\/a>/gi, '')
                    .replace(/<a[^>]*approve[^<]*<\/a>/gi, '')
                    .replace(/<div[^>]*>[^<]*expire[^<]*<\/div>/gi, '')
                    .replace(/DRAFT REVIEW/gi, 'REVIEW PREVIEW')
                  }}
                />
                <div className="approval-email-override">
                  <label>Send to email</label>
                  <input
                    type="email"
                    placeholder={a.agentEmail}
                    value={emailOverrides[a.id] || ''}
                    onChange={e => setEmailOverrides(prev => ({ ...prev, [a.id]: e.target.value }))}
                  />
                </div>
                <div className="approval-additional">
                  <label>Additional next steps (one per line, optional)</label>
                  <textarea
                    rows={3}
                    placeholder="e.g. Schedule follow-up with team lead..."
                    value={additionalSteps[a.id] || ''}
                    onChange={e => setAdditionalSteps(prev => ({ ...prev, [a.id]: e.target.value }))}
                  />
                </div>
              </>
            )}
            {statusMsg[a.id] && (
              <div className={`approval-status-msg ${statusMsg[a.id].type}`}>
                {statusMsg[a.id].text}
              </div>
            )}
            <div className="approval-actions">
              <button
                className="approval-btn-approve"
                onClick={() => handleApprove(a)}
                disabled={acting === a.id}
              >
                {acting === a.id ? 'Approving...' : 'Approve & Send'}
              </button>
              <button
                className="approval-btn-dismiss"
                onClick={() => handleDismiss(a)}
                disabled={acting === a.id}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// 1-2-1 prep used to live here (PrepViewer + a Generate Prep button). NOVA owns
// prep now — the card shows what actually happened instead of what was prepped.

/** The date of the newest 1-2-1 the detector can prove happened, if any. */
function latest121(oneToOnes, name) {
  return oneToOnes?.[name]?.[0]?.date || null;
}

/** Days per cadence. Mirrors CADENCES in services/one-to-one-detect.js. */
function cadenceDays(raw) {
  return { weekly: 7, 'bi-weekly': 14, monthly: 28, 'six-weekly': 42, 'bi-monthly': 56 }[normaliseCadence(raw)] || 14;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An ISO date string, or null. Anything else — "Thu Jun 18", "", undefined — is null.
 *
 * ⚠ Dates here must be compared as DATES, never as strings. Several People notes carry
 * `last-1-2-1: Thu Jun 18` (no year), and `"2026-08-20" > "Thu Jun 18"` is FALSE because
 * "2" sorts before "T" — so a string compare silently discarded every detected 1-2-1 for
 * those people and fell back to a stale `next-1-2-1-due`, showing a man seen twelve days
 * ago as months overdue. An unparseable stamp is treated as ABSENT rather than guessed
 * at: a date with no year cannot be placed on a timeline, and the detector always carries
 * a real one. Mirrors isoDateOrNull() in services/one-to-one-detect.js.
 */
function isoDateOrNull(value) {
  const v = String(value == null ? '' : value).trim();
  return ISO_DATE_RE.test(v) ? v : null;
}

function addDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`); // midday: no DST edge on date-only maths
  d.setDate(d.getDate() + days);
  // Local getters, never toISOString() — see CLAUDE.md.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function daysAgo(iso) {
  if (!iso) return null;
  const then = new Date(`${iso}T12:00:00`);
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  return Math.round((now - then) / 86400000);
}

/** The most recent 1-2-1s NEURO can prove happened, newest first. */
function RecentOneToOnes({ meetings }) {
  const [expanded, setExpanded] = useState(false);
  if (!meetings) return null;

  if (!meetings.length) {
    return <div className="person-121-none">No 1-2-1 found in the vault</div>;
  }

  const [latest, ...older] = meetings;
  const ago = daysAgo(latest.date);

  // Date only. The note's title, its highlights and the older list used to render here
  // and made the card a wall of text you had to read to find the one fact you came for.
  // The content lives in the note, and in NOVA's session — this board answers WHEN, not
  // what was said. Older meetings stay behind a click for the rare time they matter.
  return (
    <div className="person-121-recent">
      <div className="person-121-recent-head">
        <span className="person-121-recent-label">Last 1-2-1</span>
        <span className="person-121-recent-date">
          {formatDate(latest.date)}{ago !== null && ` · ${ago}d ago`}
        </span>
      </div>
      {older.length > 0 && (
        <>
          <button className="person-121-more" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Hide' : `${older.length} earlier`}
          </button>
          {expanded && (
            <ul className="person-121-older">
              {older.map((m, i) => (
                <li key={i}>
                  <span className="person-121-older-date">{formatDate(m.date)}</span> {m.title}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

// Nick's booking rules, mirrored client-side so an overridden slot can be
// flagged as it is typed. The backend still owns clash detection — that needs
// the calendar — but weekends and time-of-day are pure arithmetic.
const AM = [10 * 60, 12 * 60];
const PM = [14 * 60, 16 * 60 + 30];

function mins(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function slotWarning(date, time, durationMinutes = 30) {
  if (!date || !time) return null;
  const day = new Date(`${date}T12:00:00`).getDay();
  if (day === 0 || day === 6) return 'That is a weekend.';
  const from = mins(time);
  const to = from + durationMinutes;
  const inAm = from >= AM[0] && to <= AM[1];
  const inPm = from >= PM[0] && to <= PM[1];
  if (inAm || inPm) return null;
  if (from < AM[0]) return 'Before 10:00 — your rule is never at 9am.';
  if (from < PM[0] && to > AM[1]) return 'Runs into 12:00–14:00 — your rule is never over lunch.';
  if (to > PM[1]) return 'Ends after 16:30 — your rule is never after 4.30pm.';
  return 'Outside your usual 10:00–12:00 / 14:00–16:30 windows.';
}

/** Date + time override, shared by both booking dialogs. */
function SlotEditor({ date, time, durationMinutes, onChange, compact }) {
  const warning = slotWarning(date, time, durationMinutes);
  return (
    <div className={`slot-editor${compact ? ' slot-editor-compact' : ''}`}>
      <label>
        {!compact && <span>Set new date</span>}
        <input
          type="date"
          value={date}
          onChange={e => onChange({ date: e.target.value, time })}
        />
      </label>
      <label>
        {!compact && <span>Set new time</span>}
        <input
          type="time"
          step="900"
          value={time}
          onChange={e => onChange({ date, time: e.target.value })}
        />
      </label>
      {warning && <span className="slot-warning" title={warning}>⚠ {warning}</span>}
    </div>
  );
}

/** Recompute the ISO start/end pair from an edited date + time. */
function slotToIso(date, time, durationMinutes) {
  const from = mins(time);
  const to = from + durationMinutes;
  const hhmm = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return { start: `${date}T${time}:00`, end: `${date}T${hhmm(to)}:00`, date };
}

/**
 * Batch booking for everyone whose 1-2-1 is overdue.
 *
 * Same two-step contract as the single booking, and more important here: this
 * can send a dozen real invites at once, so the plan is shown in full — who,
 * when, and which address each invite goes to — before anything is created.
 */
function BookAllDialog({ names, onClose, onBooked }) {
  const [plan, setPlan] = useState(null);
  const [edits, setEdits] = useState({}); // person -> { date, time } overrides
  const [error, setError] = useState('');
  const [booking, setBooking] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    fetch(apiUrl('/api/1to1/plan-all'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ people: names }),
    })
      .then(r => r.json())
      .then(d => { if (d.ok) setPlan(d); else setError(d.error || 'Could not build a plan'); })
      .catch(e => setError(e.message));
  }, []);

  const confirm = async () => {
    setBooking(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/1to1/book-all'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: plan.planned.map(p => {
            const e = edits[p.person];
            const iso = e
              ? slotToIso(e.date, e.time, p.durationMinutes)
              : { start: p.start, end: p.end };
            return {
              person: p.person,
              start: iso.start,
              end: iso.end,
              email: p.attendee?.email || undefined,
              subject: p.subject,
            };
          }),
        }),
      });
      const d = await res.json();
      setResult(d);
      onBooked?.();
    } catch (e) { setError(e.message); }
    setBooking(false);
  };

  const hhmm = iso => iso.split('T')[1].slice(0, 5);

  return (
    <div className="note-editor-overlay" onClick={onClose}>
      <div className="book-dialog book-dialog-wide" onClick={e => e.stopPropagation()}>
        <div className="note-editor-header">
          <span className="note-editor-title">
            {result ? 'Booking results' : `Book all outstanding 1-2-1s${plan ? ` (${plan.planned.length})` : ''}`}
          </span>
          <button className="note-editor-close" onClick={onClose}>x</button>
        </div>

        {result ? (
          <div className="book-dialog-body">
            <div className={result.booked ? 'book-ok' : 'book-error'}>
              {result.booked} booked{result.invited ? `, ${result.invited} invite${result.invited === 1 ? '' : 's'} sent` : ''}
              {result.failed ? ` · ${result.failed} failed` : ''}
            </div>
            <ul className="book-results">
              {(result.results || []).map((r, i) => (
                <li key={i} className={r.ok ? 'ok' : 'bad'}>
                  <span className="book-results-name">{r.person}</span>
                  {r.ok
                    ? <span>{formatDate(r.start?.split('T')[0])} {r.start ? hhmm(r.start) : ''}{r.invited ? '' : ' — no invite'}</span>
                    : <span>{r.error}</span>}
                </li>
              ))}
            </ul>
            <div className="book-actions"><button className="btn btn-primary" onClick={onClose}>Done</button></div>
          </div>
        ) : !plan && !error ? (
          <div className="note-editor-loading">Finding slots for {names.length} people...</div>
        ) : error && !plan ? (
          <div className="book-dialog-body">
            <div className="book-error">{error}</div>
            <div className="book-actions"><button className="btn" onClick={onClose}>Close</button></div>
          </div>
        ) : (
          <div className="book-dialog-body">
            <table className="book-plan">
              <thead>
                <tr><th>Who</th><th>When</th><th>Invite to</th></tr>
              </thead>
              <tbody>
                {plan.planned.map(p => (
                  <tr key={p.person}>
                    <td>{p.person}</td>
                    <td>
                      <SlotEditor
                        compact
                        date={edits[p.person]?.date ?? p.date}
                        time={edits[p.person]?.time ?? hhmm(p.start)}
                        durationMinutes={p.durationMinutes}
                        onChange={next => setEdits(prev => ({ ...prev, [p.person]: next }))}
                      />
                    </td>
                    <td className={p.attendee?.email ? 'book-plan-email' : 'book-plan-noemail'}>
                      {p.attendee?.email || 'no address — no invite'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {plan.notBookable?.length > 0 && (
              <div className="book-warn">
                Excluded — not on a 1-2-1 cadence: {plan.notBookable.map(s => `${s.person} (${s.reason})`).join(', ')}
              </div>
            )}
            {plan.skipped?.length > 0 && (
              <div className="book-warn">
                Couldn't place: {plan.skipped.map(s => s.person).join(', ')} — {plan.skipped[0].reason}
              </div>
            )}
            {plan.withoutInvite?.length > 0 && (
              <div className="book-warn">
                No email resolved for {plan.withoutInvite.join(', ')} — those go in your calendar with no invite.
              </div>
            )}

            <p className="book-caveat">
              Slots are free in your calendar; the team's availability isn't visible to NEURO,
              so these go out as normal invites they can decline. Max 2 a day, 10:00–12:00 or
              14:00–16:30 only.
            </p>
            {error && <div className="book-error">{error}</div>}
            <div className="book-actions">
              <button className="btn" onClick={onClose} disabled={booking}>Cancel</button>
              <button className="btn btn-primary" onClick={confirm} disabled={booking || !plan.planned.length}>
                {booking
                  ? 'Booking...'
                  : `Confirm & send ${plan.planned.filter(p => p.attendee?.email).length} invite${plan.planned.filter(p => p.attendee?.email).length === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Two-step booking. Propose reads the calendar and shows a draft; nothing is
 * created until Confirm, because attendees mean Graph emails a real invite.
 */
function BookDialog({ name, onClose, onBooked }) {
  const [proposal, setProposal] = useState(null);
  const [slot, setSlot] = useState(null); // { date, time } — Nick's override
  const [error, setError] = useState('');
  const [booking, setBooking] = useState(false);
  const [booked, setBooked] = useState(null);

  useEffect(() => {
    fetch(apiUrl('/api/1to1/propose'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person: name }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setProposal(d);
          setSlot({ date: d.date, time: d.start.split('T')[1].slice(0, 5) });
        } else setError(d.error || 'Could not find a slot');
      })
      .catch(e => setError(e.message));
  }, [name]);

  const confirm = async () => {
    setBooking(true);
    setError('');
    try {
      const iso = slotToIso(slot.date, slot.time, proposal.durationMinutes);
      const res = await fetch(apiUrl('/api/1to1/book'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          person: name,
          start: iso.start,
          end: iso.end,
          email: proposal.attendee?.email || undefined,
          subject: proposal.subject,
        }),
      });
      const d = await res.json();
      if (d.ok) { setBooked(d); onBooked?.(); }
      else setError(d.error || 'Booking failed');
    } catch (e) { setError(e.message); }
    setBooking(false);
  };

  // The booked-confirmation reads back from the response, not the proposal —
  // Nick may have overridden the slot before confirming.
  const bookedTime = booked?.event?.start?.split('T')[1]?.slice(0, 5) || slot?.time || '';

  return (
    <div className="note-editor-overlay" onClick={onClose}>
      <div className="book-dialog" onClick={e => e.stopPropagation()}>
        <div className="note-editor-header">
          <span className="note-editor-title">Book 1-2-1 — {name}</span>
          <button className="note-editor-close" onClick={onClose}>x</button>
        </div>

        {booked ? (
          <div className="book-dialog-body">
            <div className="book-ok">
              Booked for {formatDate(booked.event?.start?.split('T')[0])} at {bookedTime}.
              {booked.invited ? ' Invite sent.' : ' No invite — no email address resolved.'}
            </div>
            <div className="book-actions">
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : !proposal && !error ? (
          <div className="note-editor-loading">Finding a slot...</div>
        ) : error && !proposal ? (
          <div className="book-dialog-body">
            <div className="book-error">{error}</div>
            <div className="book-actions"><button className="btn" onClick={onClose}>Close</button></div>
          </div>
        ) : (
          <div className="book-dialog-body">
            <div className="book-slot">
              <span className="book-slot-date">{formatDate(slot.date)}</span>
              <span className="book-slot-time">
                {slot.time}–{slotToIso(slot.date, slot.time, proposal.durationMinutes).end.split('T')[1].slice(0, 5)}
              </span>
            </div>
            <SlotEditor
              date={slot.date}
              time={slot.time}
              durationMinutes={proposal.durationMinutes}
              onChange={setSlot}
            />
            <dl className="book-meta">
              <dt>Invite</dt>
              <dd>{proposal.attendee?.email || <em>not resolved — will book without an invite</em>}</dd>
              <dt>Subject</dt>
              <dd>{proposal.subject}</dd>
              {proposal.dueDate && (<><dt>Was due</dt><dd>{formatDate(proposal.dueDate)}</dd></>)}
              {proposal.lastOneToOne && (
                <><dt>Last 1-2-1</dt><dd>{formatDate(proposal.lastOneToOne.date)}</dd></>
              )}
            </dl>
            <p className="book-caveat">
              Slot is free in your calendar; {name.split(' ')[0]}'s availability isn't visible to
              NEURO, so this goes out as a normal invite they can decline.
            </p>
            {error && <div className="book-error">{error}</div>}
            <div className="book-actions">
              <button className="btn" onClick={onClose} disabled={booking}>Cancel</button>
              <button className="btn btn-primary" onClick={confirm} disabled={booking}>
                {booking ? 'Booking...' : 'Confirm & send invite'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Move an existing 1-2-1. Same two-step contract as BookDialog — proposing reads
 * only, confirming PATCHes the event and Graph mails the attendee an update.
 *
 * The move count is shown BEFORE the confirm, not after, because the whole point
 * is that a 1-2-1 slid for the third time should be visibly the third time.
 */
function RescheduleDialog({ name, onClose, onMoved }) {
  const [proposal, setProposal] = useState(null);
  const [slot, setSlot] = useState(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [moving, setMoving] = useState(false);
  const [moved, setMoved] = useState(null);

  useEffect(() => {
    fetch(apiUrl('/api/1to1/propose-reschedule'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ person: name }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setProposal(d);
          setSlot({ date: d.proposed.date, time: d.proposed.start.split('T')[1].slice(0, 5) });
        } else setError(d.error || 'Could not find a slot to move to');
      })
      .catch(e => setError(e.message));
  }, [name]);

  const confirm = async () => {
    setMoving(true);
    setError('');
    try {
      const iso = slotToIso(slot.date, slot.time, proposal.durationMinutes);
      const res = await fetch(apiUrl('/api/1to1/reschedule'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          person: name,
          eventId: proposal.eventId,
          start: iso.start,
          end: iso.end,
          reason: reason.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (d.ok) { setMoved(d); onMoved?.(); }
      else setError(d.error || 'Move failed');
    } catch (e) { setError(e.message); }
    setMoving(false);
  };

  const first = name.split(' ')[0];

  return (
    <div className="note-editor-overlay" onClick={onClose}>
      <div className="book-dialog" onClick={e => e.stopPropagation()}>
        <div className="note-editor-header">
          <span className="note-editor-title">Move 1-2-1 — {name}</span>
          <button className="note-editor-close" onClick={onClose}>x</button>
        </div>

        {moved ? (
          <div className="book-dialog-body">
            <div className="book-ok">
              Moved to {formatDate(moved.event?.start?.split('T')[0])} at{' '}
              {moved.event?.start?.split('T')[1]?.slice(0, 5)}. {first} has been sent an update.
            </div>
            {moved.moveCount >= 3 && (
              <div className="book-warning">
                That's {moved.moveCount} moves for this 1-2-1.
              </div>
            )}
            <div className="book-actions">
              <button className="btn btn-primary" onClick={onClose}>Done</button>
            </div>
          </div>
        ) : !proposal && !error ? (
          <div className="note-editor-loading">Finding the meeting...</div>
        ) : error && !proposal ? (
          <div className="book-dialog-body">
            <div className="book-error">{error}</div>
            <div className="book-actions"><button className="btn" onClick={onClose}>Close</button></div>
          </div>
        ) : (
          <div className="book-dialog-body">
            {proposal.warning && <div className="book-warning">{proposal.warning}</div>}
            <dl className="book-meta">
              <dt>Currently</dt>
              <dd>
                {formatDate(proposal.current.date)} at {proposal.current.start.split('T')[1].slice(0, 5)}
                {' — '}{proposal.current.subject}
              </dd>
            </dl>
            <div className="book-slot">
              <span className="book-slot-date">{formatDate(slot.date)}</span>
              <span className="book-slot-time">
                {slot.time}–{slotToIso(slot.date, slot.time, proposal.durationMinutes).end.split('T')[1].slice(0, 5)}
              </span>
            </div>
            <SlotEditor
              date={slot.date}
              time={slot.time}
              durationMinutes={proposal.durationMinutes}
              onChange={setSlot}
            />
            <input
              className="book-reason"
              type="text"
              placeholder="Why is it moving? (optional, kept in NEURO only)"
              value={reason}
              onChange={e => setReason(e.target.value)}
            />
            {proposal.previousMoves?.length > 0 && (
              <dl className="book-meta">
                <dt>Moved before</dt>
                <dd>
                  {proposal.previousMoves.map((m, i) => (
                    <div key={i}>
                      {formatDate(m.from?.split('T')[0])} → {formatDate(m.to?.split('T')[0])}
                      {m.reason ? ` (${m.reason})` : ''}
                    </div>
                  ))}
                </dd>
              </dl>
            )}
            <p className="book-caveat">
              This updates the existing meeting rather than cancelling it, so {first} gets a
              "moved" notice and the thread is kept. Their availability isn't visible to NEURO.
            </p>
            {error && <div className="book-error">{error}</div>}
            <div className="book-actions">
              <button className="btn" onClick={onClose} disabled={moving}>Cancel</button>
              <button className="btn btn-primary" onClick={confirm} disabled={moving}>
                {moving ? 'Moving...' : 'Confirm & send update'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NoteEditor({ name, onClose, onSaved }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(name)}`))
      .then(r => r.json())
      .then(d => {
        setContent(d.content || '');
        setLoading(false);
      })
      .catch(() => { setMsg('Failed to load note'); setLoading(false); });
  }, [name]);

  const handleSave = async () => {
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(name)}/raw`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
      });
      if (res.ok) {
        setMsg('Saved');
        if (onSaved) onSaved();
        setTimeout(onClose, 800);
      } else {
        const data = await res.json();
        setMsg(data.error || 'Save failed');
      }
    } catch (e) { setMsg(e.message || 'Save failed'); }
    setSaving(false);
  };

  return (
    <div className="note-editor-overlay" onClick={onClose}>
      <div className="note-editor" onClick={e => e.stopPropagation()}>
        <div className="note-editor-header">
          <span className="note-editor-title">Edit vault note — {name}.md</span>
          <button className="note-editor-close" onClick={onClose}>x</button>
        </div>
        {loading ? (
          <div className="note-editor-loading">Loading...</div>
        ) : (
          <textarea
            className="note-editor-textarea"
            value={content}
            onChange={e => setContent(e.target.value)}
            spellCheck={false}
          />
        )}
        <div className="note-editor-actions">
          {msg && <span className={`update-msg ${msg === 'Saved' ? 'ok' : ''}`}>{msg}</span>}
          <button className="btn btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Mirrors CADENCES in services/one-to-one-detect.js. `n/a` is what takes someone
// out of the rota entirely (maternity, long-term sick) — it has to be reachable
// from the UI or the only way back off cadence is editing the note by hand.
const CADENCE_OPTIONS = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'bi-weekly', label: 'Bi-weekly (2 weeks)' },
  { value: 'monthly', label: 'Monthly (4 weeks)' },
  { value: 'six-weekly', label: 'Six-weekly (6 weeks)' },
  { value: 'bi-monthly', label: 'Bi-monthly (8 weeks)' },
  { value: 'n/a', label: 'Not scheduled (n/a)' },
];

/** Existing notes say "fortnightly"; show that as bi-weekly rather than blank. */
function normaliseCadence(raw) {
  const v = String(raw || '').toLowerCase().trim();
  if (!v || /^(n\/?a|none|-)$/.test(v)) return 'n/a';
  if (/bi[-\s]?month|two[-\s]month/.test(v)) return 'bi-monthly';
  // ⚠ MUST sit above the bare /week/ rule below: "six weekly" contains "week", so a
  // lower placement silently resolves it to WEEKLY (7 days) instead of 42.
  if (/six[-\s]?week|6[-\s]?week/.test(v)) return 'six-weekly';
  if (/month/.test(v)) return 'monthly';
  if (/bi[-\s]?week|fortnight|two[-\s]week/.test(v)) return 'bi-weekly';
  if (/week/.test(v)) return 'weekly';
  return 'bi-weekly';
}

function UpdateForm({ name, frontmatter, onClose, onSaved }) {
  const fm = frontmatter || {};
  const [last121, setLast121] = useState(fm['last-1-2-1'] || '');
  const [next121, setNext121] = useState(fm['next-1-2-1-due'] || '');
  const [cadence, setCadence] = useState(normaliseCadence(fm.cadence));
  const [employmentStatus, setEmploymentStatus] = useState(fm['employment-status'] || 'Permanent');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const cadenceChanged = cadence !== normaliseCadence(fm.cadence);

  const handleSave = async () => {
    if (!last121 && !next121 && !notes.trim() && !employmentStatus && !cadenceChanged) { setMsg('Fill in at least one field'); return; }
    setSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(name)}/update`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          last121: last121 || undefined,
          // Only send the date when it was edited — otherwise the backend can't
          // tell "leave it alone" from "recompute it from the new cadence".
          next121Due: next121 && next121 !== (fm['next-1-2-1-due'] || '') ? next121 : undefined,
          cadence: cadenceChanged ? cadence : undefined,
          employmentStatus: employmentStatus || undefined,
          notes: notes.trim() || undefined
        })
      });
      if (res.ok) {
        setMsg('Saved');
        if (onSaved) onSaved();
        setTimeout(onClose, 1200);
      } else {
        const data = await res.json();
        setMsg(data.error || 'Save failed');
      }
    } catch { setMsg('Save failed'); }
    setSaving(false);
  };

  return (
    <div className="update-form">
      <div className="update-form-header">
        <span className="update-form-title">Update 1-2-1 — {name}</span>
        <button className="update-form-close" onClick={onClose}>x</button>
      </div>
      <label className="update-label">Last 1-2-1
        <input type="date" className="update-input" value={last121} onChange={e => setLast121(e.target.value)} />
      </label>
      <label className="update-label">Next 1-2-1 due
        <input type="date" className="update-input" value={next121} onChange={e => setNext121(e.target.value)} />
      </label>
      <label className="update-label">Cadence
        <select className="update-input" value={cadence} onChange={e => setCadence(e.target.value)}>
          {CADENCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </label>
      {cadenceChanged && (
        <span className="update-hint">
          {cadence === 'n/a'
            ? 'Takes them out of the rota — no due date, never booked.'
            : 'The next due date will be recalculated from the last 1-2-1.'}
        </span>
      )}
      <label className="update-label">Employment Status
        <select className="update-input" value={employmentStatus} onChange={e => setEmploymentStatus(e.target.value)}>
          <option value="Permanent">Permanent</option>
          <option value="Probation">Probation</option>
          <option value="Improvement Window">Improvement Window</option>
          <option value="Notice">Notice</option>
          <option value="Contractor">Contractor</option>
        </select>
      </label>
      <label className="update-label">Notes
        <textarea className="update-textarea" rows={3} placeholder="Key points from meeting..." value={notes} onChange={e => setNotes(e.target.value)} />
      </label>
      <div className="update-actions">
        {msg && <span className={`update-msg ${msg === 'Saved' ? 'ok' : ''}`}>{msg}</span>}
        <button className="btn btn-primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
      </div>
    </div>
  );
}

export default function PeopleBoard() {
  const [peopleData, setPeopleData] = useState({});
  const [n8nConfigured, setN8nConfigured] = useState(false);
  const [running121, setRunning121] = useState(null); // person name currently running
  const [snapshotResult, setSnapshotResult] = useState(null); // { name, data }
  const [editingPerson, setEditingPerson] = useState(null); // person name being updated
  const [editingNote, setEditingNote] = useState(null); // person name whose raw note is being edited
  const [bookingFor, setBookingFor] = useState(null); // person name being booked
  const [movingFor, setMovingFor] = useState(null);   // person whose 1-2-1 is being moved
  const [bookingAll, setBookingAll] = useState(null); // names being batch-booked
  const [oneToOnes, setOneToOnes] = useState(null); // { [name]: [{date,title,highlights}] }
  const [autoExpanded, setAutoExpanded] = useState(() => sessionStorage.getItem('people-auto-expanded') === 'true');
  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [selectedPerson, setSelectedPerson] = useState(null);
  const [viewMode, setViewMode] = useState('reports'); // reports | other
  const [personSummaries, setPersonSummaries] = useState({});
  // Recordings NOVA is holding for approval, keyed by person. Fetched separately and
  // failing silently: it crosses the bridge to another machine, and the board must render
  // exactly the same when NOVA is unreachable.
  const [pendingTranscripts, setPendingTranscripts] = useState({});

  // Auto-expand removed — was opening overdue 1-2-1 forms on every page visit

  useEffect(() => {
    // Fetch vault notes for each person
    const allPeople = Object.values(TEAMS).flat();
    allPeople.forEach(person => {
      fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(person.name)}`))
        .then(res => res.json())
        .then(data => {
          setPeopleData(prev => ({ ...prev, [person.name]: data }));
        })
        .catch(() => {});
    });

    // Fetch per-person tasks + decisions
    fetch(apiUrl('/api/1to1/pending-transcripts'))
      .then(r => r.json())
      .then(j => {
        if (!j?.ok) return;
        const byName = {};
        for (const a of j.agents || []) if (a.agentName) byName[a.agentName] = a.count;
        setPendingTranscripts(byName);
      })
      .catch(() => {});

    fetch(apiUrl('/api/person/summary/all'))
      .then(r => r.json())
      .then(d => setPersonSummaries(d.people || {}))
      .catch(() => {});

    // Detected 1-2-1 history — what actually happened, read from meeting notes
    fetchOneToOnes();

    // Check n8n status + pending approvals
    fetch(apiUrl('/api/n8n/status'))
      .then(r => r.json())
      .then(d => setN8nConfigured(d.configured))
      .catch(() => {});
    fetchApprovals();
    // Poll for new approvals every 10s
    const approvalTimer = setInterval(fetchApprovals, 10000);
    return () => clearInterval(approvalTimer);
  }, []);

  const fetchOneToOnes = (refresh = false) => {
    fetch(apiUrl(`/api/1to1/recent${refresh ? '?refresh=1' : ''}`))
      .then(r => r.json())
      .then(d => setOneToOnes(d.byPerson || {}))
      .catch(() => setOneToOnes({}));
  };

  const fetchApprovals = () => {
    fetch(apiUrl('/api/n8n/121/pending'))
      .then(r => r.json())
      .then(d => {
        setPendingApprovals(d.approvals || []);
        // Auto-dismiss snapshot banner once an approval appears
        if (d.approvals?.length > 0) setSnapshotResult(null);
      })
      .catch(() => {});
  };

  const [snapshotOpts, setSnapshotOpts] = useState({}); // { [name]: { lookbackDays, nextStepsDays } }

  const getOpts = (personName) => snapshotOpts[personName] || { lookbackDays: 31, nextStepsDays: 31 };
  const setOpts = (personName, patch) => setSnapshotOpts(prev => ({
    ...prev,
    [personName]: { ...getOpts(personName), ...patch }
  }));

  const run121 = async (personName, mode = '30day') => {
    setRunning121(personName);
    setSnapshotResult(null);
    setEditingPerson(null);
    const opts = getOpts(personName);
    const fm = peopleData[personName]?.frontmatter || {};
    const isProbationary = /probation/i.test(fm['employment-status'] || '');
    try {
      const res = await fetch(apiUrl('/api/n8n/121'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nameHint: personName,
          mode,
          lookbackDays: opts.lookbackDays,
          nextStepsDays: opts.nextStepsDays,
          isProbationary
        })
      });
      const data = await res.json();
      setSnapshotResult({ name: personName, data });
      // Refresh approvals after a delay (n8n takes time to process)
      setTimeout(fetchApprovals, 15000);
      setTimeout(fetchApprovals, 30000);
    } catch (e) {
      setSnapshotResult({ name: personName, data: { success: false, error: e.message } });
    }
    setRunning121(null);
  };

  const saraLine = buildTeamSaraLine(TEAMS, peopleData, personSummaries, oneToOnes);

  // Everyone the board is currently showing an overdue 1-2-1 badge for. Driving
  // this off the same get121Status the cards use keeps the button honest — it
  // books exactly who you can see is overdue, nobody else.
  const overdueNames = Object.values(TEAMS).flat()
    .filter(p => get121Status(peopleData[p.name]?.frontmatter, latest121(oneToOnes, p.name))?.status === 'overdue')
    .map(p => p.name);

  return (
    <div className="people-board">
      {/* SARA team assessment */}
      <div className="team-sara">
        <div className="team-sara-main">
          <span className="team-sara-label">SARA</span>
          <p className="team-sara-line">{saraLine}</p>
        </div>
        {overdueNames.length > 0 && (
          <button
            className="team-sara-book-all"
            onClick={() => setBookingAll(overdueNames)}
            title={`Plan 1-2-1s for: ${overdueNames.join(', ')}`}
          >
            Book all outstanding ({overdueNames.length})
          </button>
        )}
      </div>

      {/* What the team owes Nick. Grouped by person, worst offender first — and
          deliberately above the roster, because it is the thing you act on.
          Covers everyone the meeting notes mention, not just direct reports. */}
      <WaitingOn />

      <div className="people-header">
        <h2 className="people-title">Team</h2>
        <div className="people-toggle">
          <button
            className={`people-toggle-btn ${viewMode === 'reports' ? 'active' : ''}`}
            onClick={() => setViewMode('reports')}
          >Reports</button>
          <button
            className={`people-toggle-btn ${viewMode === 'other' ? 'active' : ''}`}
            onClick={() => setViewMode('other')}
          >Other</button>
        </div>
      </div>

      {viewMode === 'reports' && <ApprovalPanel approvals={pendingApprovals} onRefresh={fetchApprovals} />}

      {bookingAll && (
        <BookAllDialog
          names={bookingAll}
          onClose={() => setBookingAll(null)}
          onBooked={() => {
            // next-1-2-1-due moved for everyone booked — refresh the badges
            bookingAll.forEach(n => {
              fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(n)}`))
                .then(r => r.json())
                .then(data => setPeopleData(prev => ({ ...prev, [n]: data })))
                .catch(() => {});
            });
          }}
        />
      )}

      {bookingFor && (
        <BookDialog
          name={bookingFor}
          onClose={() => setBookingFor(null)}
          onBooked={() => {
            fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(bookingFor)}`))
              .then(r => r.json())
              .then(data => setPeopleData(prev => ({ ...prev, [bookingFor]: data })))
              .catch(() => {});
          }}
        />
      )}

      {movingFor && (
        <RescheduleDialog
          name={movingFor}
          onClose={() => setMovingFor(null)}
          onMoved={() => {
            // next-1-2-1-due moved with the meeting, so the card must re-read.
            fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(movingFor)}`))
              .then(r => r.json())
              .then(data => setPeopleData(prev => ({ ...prev, [movingFor]: data })))
              .catch(() => {});
          }}
        />
      )}

      {editingNote && (
        <NoteEditor
          name={editingNote}
          onClose={() => setEditingNote(null)}
          onSaved={() => {
            fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(editingNote)}`))
              .then(r => r.json())
              .then(data => setPeopleData(prev => ({ ...prev, [editingNote]: data })))
              .catch(() => {});
          }}
        />
      )}

      {snapshotResult && (
        <div className={`snapshot-result ${snapshotResult.data.success ? 'success' : 'error'}`}>
          <div className="snapshot-header">
            <span className="snapshot-title">1-2-1 Snapshot: {snapshotResult.name}</span>
            <button className="snapshot-close" onClick={() => setSnapshotResult(null)}>x</button>
          </div>
          <div className="snapshot-body">
            {snapshotResult.data.success ? (
              <div className="snapshot-message">{snapshotResult.data.message}</div>
            ) : (
              <div className="snapshot-error">{snapshotResult.data.error || 'Workflow failed'}</div>
            )}
          </div>
        </div>
      )}

      {viewMode === 'other' && (
        <AllPeopleSection
          excludeNames={Object.values(TEAMS).flat().map(p => p.name)}
          onSelect={setSelectedPerson}
          expanded={true}
        />
      )}

      {viewMode === 'reports' && Object.entries(TEAMS).map(([teamName, members]) => (
        <div key={teamName} className="team-group">
          <h3 className="team-name">{teamName}</h3>
          <div className="team-cards">
            {members.map(person => {
              const vaultData = peopleData[person.name];
              const tags = vaultData?.tags || [];
              const fm = vaultData?.frontmatter || {};
              const sara = getSaraStatus(person, vaultData, personSummaries, latest121(oneToOnes, person.name));
              const isRunning = running121 === person.name;

              return (
                <div key={person.id} className={`person-card sara-status-${sara.tone}`} data-person={person.name}>
                  <div className="person-header" onClick={() => setSelectedPerson(person.name)} style={{ cursor: 'pointer' }}>
                    <span className="person-name person-name-clickable">{person.name}</span>
                    <span className={`sara-status-badge sara-status-${sara.tone}`}>{sara.word}</span>
                  </div>
                  <span className="person-role">{person.role}</span>
                  {sara.reason && <span className="sara-status-reason">{sara.reason}</span>}
                  {(() => {
                    const s121 = get121Status(fm, latest121(oneToOnes, person.name));
                    if (!s121) return null;
                    return (
                      <span className={`person-121-status person-121-${s121.status}`}>
                        {s121.label}
                      </span>
                    );
                  })()}
                  {person.note && <span className="person-note">{person.note}</span>}
                  <RecentOneToOnes meetings={oneToOnes?.[person.name]} />
                  {tags.length > 0 && (
                    <div className="person-tags">
                      {tags.map(tag => (
                        <span key={tag} className="person-tag">#{tag}</span>
                      ))}
                    </div>
                  )}
                  {!vaultData?.exists && (
                    <span className="person-no-note">No vault note</span>
                  )}
                  {/* A count, not the list. The actions themselves are on the People
                      note and in NOVA's 1-2-1 — three copies of the same text was two
                      too many, and it is the NUMBER that tells you whether to worry. */}
                  {personSummaries[person.name]?.tasks?.length > 0 && (
                    <div className="person-card-tasks">
                      <span className="person-card-task-count">
                        ☐ {personSummaries[person.name].tasks.length} action{personSummaries[person.name].tasks.length === 1 ? '' : 's'} owed
                      </span>
                    </div>
                  )}
                  {/* A Plaud recording NOVA is holding for this person, waiting to be
                      approved. Surfaced here because this is the board Nick looks at to
                      decide who needs attention, and an unapproved transcript means the
                      1-2-1 has not been written up anywhere yet. */}
                  {pendingTranscripts[person.name] > 0 && (
                    <div className="person-121-transcript-pending">
                      🎙 {pendingTranscripts[person.name]} recording{pendingTranscripts[person.name] === 1 ? '' : 's'} awaiting approval in NOVA
                    </div>
                  )}
                  {personSummaries[person.name]?.decisions?.length > 0 && (
                    <div className="person-card-decisions">
                      {personSummaries[person.name].decisions.map((d, i) => (
                        <div key={i} className="person-card-decision">
                          <span className="person-card-decision-date">{d.date}</span> {d.text}
                        </div>
                      ))}
                    </div>
                  )}
                  {n8nConfigured && (() => {
                    const opts = getOpts(person.name);
                    const empStatus = fm['employment-status'] || '';
                    const isProb = /probation/i.test(empStatus);
                    return (
                      <div className="person-snapshot-opts">
                        <label className="snapshot-opt">
                          <span>Lookback</span>
                          <select
                            value={opts.lookbackDays}
                            onChange={e => setOpts(person.name, { lookbackDays: Number(e.target.value) })}
                          >
                            <option value={7}>7 days</option>
                            <option value={14}>14 days</option>
                            <option value={31}>31 days</option>
                          </select>
                        </label>
                        <label className="snapshot-opt">
                          <span>Next steps</span>
                          <select
                            value={opts.nextStepsDays}
                            onChange={e => setOpts(person.name, { nextStepsDays: Number(e.target.value) })}
                          >
                            <option value={7}>7 days</option>
                            <option value={14}>14 days</option>
                            <option value={31}>31 days</option>
                          </select>
                        </label>
                        {empStatus && (
                          <span className={`person-emp-status${isProb ? ' probation' : ''}`}>{empStatus}</span>
                        )}
                        <span className={`person-cadence${normaliseCadence(fm.cadence) === 'n/a' ? ' off' : ''}`}>
                          {CADENCE_OPTIONS.find(o => o.value === normaliseCadence(fm.cadence))?.label}
                        </span>
                      </div>
                    );
                  })()}
                  <div className="person-card-actions">
                    {vaultData?.exists && (
                      <button
                        className="person-update-btn"
                        onClick={() => setEditingPerson(editingPerson === person.name ? null : person.name)}
                      >
                        Update 1-2-1
                      </button>
                    )}
                    {vaultData?.exists && (
                      <button
                        className="person-edit-btn"
                        onClick={() => setEditingNote(person.name)}
                        title="Edit raw vault note"
                      >
                        Edit Note
                      </button>
                    )}
                    <button
                      className="person-book-btn"
                      onClick={() => setBookingFor(person.name)}
                      title="Find the next free slot and send an invite"
                    >
                      Book now
                    </button>
                    <button
                      className="person-move-btn"
                      onClick={() => setMovingFor(person.name)}
                      title="Move the existing 1-2-1 — updates the meeting, never cancels it"
                    >
                      Move
                    </button>
                    {n8nConfigured && (
                      <button
                        className={`person-121-btn ${isRunning ? 'running' : ''}`}
                        onClick={() => run121(person.name)}
                        disabled={isRunning || running121 !== null}
                      >
                        {isRunning ? 'Running...' : '1-2-1 Snapshot'}
                      </button>
                    )}
                    {n8nConfigured && person.note && /improvement window/i.test(person.note) && (
                      <button
                        className={`person-weekly-btn ${isRunning ? 'running' : ''}`}
                        onClick={() => run121(person.name, 'weekly')}
                        disabled={isRunning || running121 !== null}
                      >
                        {isRunning ? 'Running...' : 'Weekly Review'}
                      </button>
                    )}
                  </div>
                  {editingPerson === person.name && (
                    <UpdateForm
                      name={person.name}
                      frontmatter={fm}
                      onClose={() => setEditingPerson(null)}
                      onSaved={() => {
                        fetch(apiUrl(`/api/obsidian/people/${encodeURIComponent(person.name)}`))
                          .then(r => r.json())
                          .then(data => setPeopleData(prev => ({ ...prev, [person.name]: data })))
                          .catch(() => {});
                      }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Person detail overlay */}
      {selectedPerson && (
        <PersonDetail name={selectedPerson} onClose={() => setSelectedPerson(null)} />
      )}
    </div>
  );
}

function AllPeopleSection({ excludeNames, onSelect, expanded: defaultExpanded = false }) {
  const [people, setPeople] = useState(null);
  const [expanded, setExpanded] = useState(defaultExpanded);

  useEffect(() => {
    fetch(apiUrl('/api/person/list'))
      .then(r => r.json())
      .then(d => {
        const all = d.people || [];
        const filtered = all.filter(name => !excludeNames.some(ex => ex.toLowerCase() === name.toLowerCase()));
        setPeople(filtered);
      })
      .catch(() => setPeople([]));
  }, []);

  if (!people || people.length === 0) return null;

  return (
    <div className="team-section" style={{ marginTop: 24 }}>
      <button
        className="team-name"
        onClick={() => setExpanded(!expanded)}
        style={{ cursor: 'pointer', background: 'none', border: 'none', color: 'inherit', font: 'inherit', padding: 0, textAlign: 'left', width: '100%' }}
      >
        {expanded ? '▾' : '▸'} Other People ({people.length})
      </button>
      {expanded && (
        <div className="team-cards" style={{ marginTop: 8 }}>
          {people.map(name => (
            <div
              key={name}
              className="person-card"
              onClick={() => onSelect(name)}
              style={{ cursor: 'pointer' }}
            >
              <div className="person-header">
                <span className="person-name person-name-clickable">{name}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

