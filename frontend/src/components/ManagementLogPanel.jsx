import { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './ManagementLogPanel.css';

/**
 * Management Actions & Conversations Log — PIP competencies 3 and 4.
 *
 * ⚠ Its own view since 7 Sep 2026 (Nick's call). It was a section inside
 * WeeklyRiskPanel, and two things were wrong with that. The log is a RUNNING
 * RECORD with its own life — it belongs to one week's report no more than the
 * task store belongs to the standup — and, more concretely, there had never
 * been a way to add to it: `POST /api/weekly-risk/log` shipped with no caller
 * in either frontend, so the only routes in were the seed script and a curl. A
 * compliance log you cannot add to from a screen you can find is one that stops
 * being kept, which is the failure it exists to prevent.
 *
 * Weekly Risk keeps the compliance PICTURE read-only and links here. One
 * mutating surface, not two — two forms over one table are two forms free to
 * disagree about what an entry is.
 *
 * The load-bearing honesty rule, restated wherever it is visible: Nick chooses
 * when a conversation HAPPENED; he cannot choose when it was LOGGED. The server
 * stamps that from its own clock and refuses an earlier one unless the caller
 * names a non-manual source. The gap between the two IS competency 3, and a
 * freely backdatable stamp makes the measurement unfalsifiable — the difference
 * between evidence and a self-report.
 */

const TYPES = [
  { id: 'conversation', label: 'Conversation' },
  { id: 'concern', label: 'Concern' },
  { id: 'action', label: 'Action' },
];
const STATUSES = ['open', 'in-progress', 'blocked', 'done'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Local, never toISOString() — the same rule the service follows. */
function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtUk(iso) {
  if (!iso) return '—';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  if (!y || !m || !d) return String(iso);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

function fmtStamp(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * A blank entry. `entryDate` defaults to today because most conversations are
 * logged the day they happen — but it is EDITABLE, because the ones worth
 * catching are the ones that are not.
 */
function emptyDraft() {
  return { type: 'conversation', summary: '', person: '', owner: 'Nick', entryDate: todayLocal(), dueDate: '', action: '' };
}

export default function ManagementLogPanel({ onNavigate }) {
  const [log, setLog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  const [draft, setDraft] = useState(emptyDraft);
  // ⚠ The receipt is READ BACK from the assessment, never taken from the POST's
  // own response. A write that only decorated its own reply would look
  // identical, and "it says it saved" is exactly the assurance this log exists
  // to replace with evidence.
  const [logged, setLogged] = useState(null);

  // Which row is expanded. One at a time, so there is only ever one unsaved
  // draft in flight — TodoPanel's rule.
  const [editing, setEditing] = useState(null);
  const [editDraft, setEditDraft] = useState(null);

  const [filter, setFilter] = useState({ status: 'open', type: 'all', q: '' });

  // Suggestions from PLAUD meeting notes. Loaded separately from the log
  // because it walks the vault — the log must render instantly whether or not
  // the vault is reachable.
  const [suggest, setSuggest] = useState(null);
  const [openSuggestion, setOpenSuggestion] = useState(null);
  const [sDraft, setSDraft] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/weekly-risk/log'));
      const body = await res.json();
      if (body.error) throw new Error(body.error);
      setLog(body);
      setError(null);
    } catch (e) {
      // ⚠ "I could not read the log" and "the log is empty" are opposite facts.
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSuggestions = useCallback(async () => {
    try {
      const body = await fetch(apiUrl('/api/weekly-risk/log-suggestions')).then(r => r.json());
      setSuggest(body);
    } catch (e) {
      // ⚠ A failure is a NAMED GAP, never an empty list — "nothing to suggest"
      // and "I could not read the vault" license opposite conclusions.
      setSuggest({ ok: false, suggestions: [], gaps: [e.message], skipped: {} });
    }
  }, []);

  useEffect(() => { load(); loadSuggestions(); }, [load, loadSuggestions]);

  async function send(path, method, body) {
    const res = await fetch(apiUrl(path), {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${method} failed`);
    return data;
  }

  async function addEntry() {
    const summary = draft.summary.trim();
    if (!summary) {
      setNotice({ tone: 'bad', text: 'Say what it was — an entry with no summary cannot be followed to resolution.' });
      return;
    }
    setBusy('add');
    setNotice(null);
    try {
      const created = await send('/api/weekly-risk/log', 'POST', {
        type: draft.type,
        summary,
        person: draft.person.trim() || null,
        owner: draft.owner.trim() || null,
        entryDate: draft.entryDate || undefined,
        dueDate: draft.dueDate || null,
        action: draft.action.trim() || null,
      });

      // Read it back through the assessment, so the receipt states what the
      // compliance view actually holds rather than what the form just sent.
      const fresh = await fetch(apiUrl('/api/weekly-risk/log')).then(r => r.json());
      setLog(fresh);
      const row = (fresh.rows || []).find(r => r.id === created.id) || created;
      setLogged({
        id: created.id,
        summary: row.summary,
        entryDate: row.entry_date,
        loggedAt: row.logged_at,
        late: (fresh.lateLogged || []).find(l => l.id === created.id) || null,
        missingOwner: (fresh.missingOwner || []).some(m => m.id === created.id),
        missingDue: (fresh.missingDue || []).some(m => m.id === created.id),
        hrPending: (fresh.hrUnknown || []).some(h => h.id === created.id),
      });
      setDraft(emptyDraft());
    } catch (e) {
      // ⚠ The draft is KEPT. Losing what he typed is how a log stops being kept.
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  function openSuggest(sg) {
    if (openSuggestion === sg.id) { setOpenSuggestion(null); setSDraft(null); return; }
    setOpenSuggestion(sg.id);
    setSDraft({
      type: sg.type,
      summary: sg.summary,
      // ⚠ A note naming two or three reports has no single subject, so `person`
      // comes back null rather than guessing the first one. Nick picks.
      person: sg.person || '',
      owner: 'Nick',
      entryDate: sg.entryDate,
      dueDate: '',
      action: '',
    });
  }

  /**
   * Log a suggestion.
   *
   * `payload` is the edited draft when the card is open, and the suggestion's
   * own defaults when it is logged straight from the header — Nick's ask,
   * 7 Sep 2026: most cards need no editing, and making him expand one to act on
   * it is the friction this whole section exists to remove.
   */
  async function acceptSuggestion(sg, payload) {
    setBusy(`sg${sg.id}`);
    setNotice(null);
    try {
      const out = await send('/api/weekly-risk/log-suggestions/accept', 'POST', { id: sg.id, ...payload });
      setOpenSuggestion(null);
      setSDraft(null);
      setNotice({
        tone: 'ok',
        text: out.contemporaneous
          ? `Logged as #${out.row.id}, recorded against the date the note itself was written.`
          : `Logged as #${out.row.id}. That note carries no timestamp, so this is recorded as logged today — it will show as logged late.`,
      });
      load();
      loadSuggestions();
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Log it straight from the header, with the suggestion's own values.
   *
   * ⚠ Except when the note names more than one report: `person` is null there
   * BY DESIGN — the service refuses to guess which of two or three people a
   * conversation was about — so this opens the card and says what is needed
   * rather than logging a compliance record against nobody. A one-tap action
   * that quietly does something different is worse than one that asks.
   */
  function quickAccept(sg) {
    if (sg.people.length > 1) {
      openSuggest(sg);
      setNotice({ tone: 'bad', text: `That note names ${sg.people.length} people — pick who it was with before logging it.` });
      return;
    }
    acceptSuggestion(sg, {
      type: sg.type,
      summary: sg.summary,
      person: sg.person,
      owner: 'Nick',
      entryDate: sg.entryDate,
      dueDate: '',
      action: '',
    });
  }

  async function dismissSuggestion(id) {
    setBusy(`sg${id}`);
    try {
      await send('/api/weekly-risk/log-suggestions/dismiss', 'POST', { id });
      setNotice({ tone: 'ok', text: 'Dismissed — it will not be offered again.' });
      loadSuggestions();
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  function openEdit(row) {
    if (editing === row.id) { setEditing(null); setEditDraft(null); return; }
    setEditing(row.id);
    setEditDraft({
      summary: row.summary || '',
      person: row.person || '',
      owner: row.owner || '',
      entryDate: row.entry_date || '',
      dueDate: row.due_date || '',
      status: row.status || 'open',
      action: row.action || '',
      notes: row.notes || '',
    });
  }

  /**
   * Save the whole card in ONE patch, on a deliberate press.
   *
   * ⚠ `entryDate` is editable here and `loggedAt` is not offered at all — the
   * stamp is the server's and the API refuses to take one from a manual caller.
   * Correcting the date a conversation happened is a legitimate fix; deciding
   * when it was written down is not a thing anyone gets to do.
   */
  async function saveEdit(id) {
    setBusy(`edit${id}`);
    setNotice(null);
    try {
      await send(`/api/weekly-risk/log/${id}`, 'PATCH', {
        summary: editDraft.summary.trim(),
        person: editDraft.person.trim() || null,
        owner: editDraft.owner.trim() || null,
        entryDate: editDraft.entryDate || null,
        dueDate: editDraft.dueDate || null,
        status: editDraft.status,
        action: editDraft.action.trim() || null,
        notes: editDraft.notes.trim() || null,
      });
      setEditing(null);
      setEditDraft(null);
      setNotice({ tone: 'ok', text: 'Saved.' });
      load();
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Close an item. The server stamps `resolved_date` when none is given —
   * competency 4 measures how long things stayed open, so an item closed with
   * no date is uncountable.
   */
  async function closeRow(id) {
    setBusy(`edit${id}`);
    try {
      await send(`/api/weekly-risk/log/${id}`, 'PATCH', { status: 'done' });
      setNotice({ tone: 'ok', text: 'Closed, and dated today. It stops counting as overdue.' });
      load();
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  async function setHr(id, inPeopleHr) {
    setBusy(`hr${id}`);
    try {
      await send(`/api/weekly-risk/log/${id}`, 'PATCH', { hrLogged: inPeopleHr });
      setNotice({
        tone: 'ok',
        text: inPeopleHr ? 'Recorded: in People HR.' : 'Recorded: NOT in People HR — this will go in the report.',
      });
      load();
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Drop a row that was never Nick's management action.
   *
   * ⚠ Deliberately NOT the same as answering "No" to People HR, which writes a
   * CONFIRMED gap and reaches Chris as a finding — using that to clear an item
   * nothing to do with Nick would manufacture a compliance failure against him.
   * Destructive with no undo, so the confirm names the item rather than asking
   * about whichever row the mouse is near.
   */
  async function removeRow(id, label) {
    const warning = `Remove this from the management log?\n\n${label}\n\nThis deletes the row. It cannot be undone.`;
    if (!window.confirm(warning)) return;
    setBusy(`hr${id}`);
    try {
      await send(`/api/weekly-risk/log/${id}`, 'DELETE');
      setNotice({ tone: 'ok', text: 'Removed from the management log.' });
      load();
    } catch (e) {
      setNotice({ tone: 'bad', text: e.message });
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <div className="ml-panel"><p className="ml-loading">Reading the management log…</p></div>;

  if (error) {
    return (
      <div className="ml-panel">
        <p className="ml-error">
          Could not read the management log — {error}. This is <strong>not</strong> an empty log;
          nothing here can be trusted until it loads.
        </p>
        <button type="button" className="ml-toggle" onClick={load}>try again</button>
      </div>
    );
  }

  const rows = (log?.rows || []).filter(r => {
    const closed = r.status === 'done' || r.resolved_date;
    if (filter.status === 'open' && closed) return false;
    if (filter.status === 'done' && !closed) return false;
    if (filter.type !== 'all' && r.type !== filter.type) return false;
    if (filter.q) {
      const hay = `${r.summary || ''} ${r.person || ''} ${r.owner || ''}`.toLowerCase();
      if (!hay.includes(filter.q.toLowerCase())) return false;
    }
    return true;
  });

  const lateIds = new Set((log?.lateLogged || []).map(l => l.id));
  const noOwnerIds = new Set((log?.missingOwner || []).map(m => m.id));
  const noDueIds = new Set((log?.missingDue || []).map(m => m.id));
  const overdueById = new Map((log?.overdue || []).map(o => [o.id, o]));

  return (
    <div className="ml-panel">
      <header className="ml-header">
        <div>
          <h2>Management log</h2>
          <p className="ml-sub">
            Conversations, concerns and actions — PIP competencies 3 and 4.
            {onNavigate && (
              <button type="button" className="ml-link" onClick={() => onNavigate('weekly-risk')}>
                weekly report
              </button>
            )}
          </p>
        </div>
        <button type="button" className="ml-toggle" onClick={load}>refresh</button>
      </header>

      {notice && <div className={`ml-notice ml-notice-${notice.tone}`}>{notice.text}</div>}

      {/* ── Suggested from PLAUD ──────────────────────────────────────────
          Above the blank form deliberately: most of what belongs on this log is
          already recorded, and asking Nick to retype it is the friction that
          keeps the log behind. Every card still has to be opened, read and
          accepted — nothing here writes on its own. */}
      {suggest && (suggest.suggestions.length > 0 || suggest.ok === false || suggest.gaps?.length > 0) && (
        <section className="ml-section">
          <h3>
            Suggested from your recordings
            {suggest.suggestions.length > 0 && <span className="ml-count"> {suggest.suggestions.length}</span>}
          </h3>

          {/* ⚠ Three distinct renderings. An unreadable vault must never look
              like a clean sweep. */}
          {suggest.ok === false ? (
            <p className="ml-warn-line">
              Could not read your meeting notes, so nothing is being suggested. This is <strong>not</strong> a
              sign there is nothing to log.{suggest.gaps?.length ? ` ${suggest.gaps.join(' ')}` : ''}
            </p>
          ) : (
            <>
              <p className="ml-hint">
                Meetings PLAUD recorded that name someone who reports to you, and are not already on the log.
                Formal 1-2-1s are excluded. Nothing is logged until you accept it.
              </p>
              {suggest.gaps?.length > 0 && (
                <p className="ml-warn-line">Partly read: {suggest.gaps.join(' ')}</p>
              )}
            </>
          )}

          {suggest.suggestions.map(sg => (
            <div key={sg.id} className={`ml-sg ${openSuggestion === sg.id ? 'ml-sg-open' : ''}`}>
              <div
                className="ml-sg-head" role="button" tabIndex={0}
                onClick={() => openSuggest(sg)}
                onKeyDown={e => { if (e.key === 'Enter') openSuggest(sg); }}
              >
                <div className="ml-sg-text">
                  <span className="ml-summary">{sg.summary}</span>
                  <span className="ml-meta">
                    <span>{fmtUk(sg.entryDate)}</span>
                    <span>{sg.people.join(', ')}</span>
                    {sg.meetingType && <span>{sg.meetingType}</span>}
                    {/* ⚠ Stated, never applied silently — accepting this writes
                        it as logged on the note's own date, and that is the one
                        thing here that changes a compliance figure. */}
                    {sg.contemporaneous
                      ? <span>records as logged {fmtUk(sg.recordedAt)}</span>
                      : <span className="ml-bad">no timestamp — would log as today</span>}
                  </span>
                </div>

                {/* ⚠ Both actions on the COLLAPSED row — Nick's ask, 7 Sep 2026.
                    Most cards need no editing, and making him expand one to act
                    on it is the friction this section exists to remove. Clicks
                    are stopped, or pressing either would also toggle the card
                    open underneath the button. Opening it stays available for
                    the ones worth rewording first. */}
                <div className="ml-sg-buttons" onClick={e => e.stopPropagation()}>
                  <button type="button" onClick={() => quickAccept(sg)} disabled={busy === `sg${sg.id}`}>
                    {busy === `sg${sg.id}` ? 'Logging…' : 'Log it'}
                  </button>
                  <button
                    type="button" className="ml-sg-no"
                    onClick={() => dismissSuggestion(sg.id)} disabled={busy === `sg${sg.id}`}
                  >
                    Not a management conversation
                  </button>
                </div>
              </div>

              {openSuggestion === sg.id && sDraft && (
                <div className="ml-edit" onClick={e => e.stopPropagation()}>
                  <div className="ml-row">
                    <label>
                      Kind
                      <select value={sDraft.type} onChange={e => setSDraft({ ...sDraft, type: e.target.value })}>
                        {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                      </select>
                    </label>
                    <label>
                      Who with
                      {/* Two or three named reports means no single subject, so
                          it is a choice rather than a guess. */}
                      {sg.people.length > 1 ? (
                        <select value={sDraft.person} onChange={e => setSDraft({ ...sDraft, person: e.target.value })}>
                          <option value="">— pick one —</option>
                          {sg.people.map(p => <option key={p} value={p}>{p}</option>)}
                        </select>
                      ) : (
                        <input
                          type="text" value={sDraft.person}
                          onChange={e => setSDraft({ ...sDraft, person: e.target.value })}
                        />
                      )}
                    </label>
                    <label>
                      When it happened
                      <input
                        type="date" value={sDraft.entryDate}
                        onChange={e => setSDraft({ ...sDraft, entryDate: e.target.value })}
                      />
                    </label>
                  </div>

                  <label className="ml-field">
                    What was it
                    {/* The note's TITLE, which describes the meeting rather than
                        the management action. Worth rewriting before this goes
                        anywhere near Chris. */}
                    <textarea
                      rows={2} value={sDraft.summary}
                      onChange={e => setSDraft({ ...sDraft, summary: e.target.value })}
                    />
                  </label>

                  <div className="ml-row">
                    <label>
                      Owner
                      <input
                        type="text" value={sDraft.owner}
                        onChange={e => setSDraft({ ...sDraft, owner: e.target.value })}
                      />
                    </label>
                    <label>
                      Due
                      <input
                        type="date" value={sDraft.dueDate}
                        onChange={e => setSDraft({ ...sDraft, dueDate: e.target.value })}
                      />
                    </label>
                  </div>

                  <label className="ml-field">
                    Follow-up <span className="ml-optional">(optional)</span>
                    <textarea
                      rows={2} value={sDraft.action}
                      onChange={e => setSDraft({ ...sDraft, action: e.target.value })}
                    />
                  </label>

                  <p className="ml-hint">
                    From <code>{sg.sourcePath}</code>.
                    {sg.contemporaneous
                      ? ' The recording is the contemporaneous record, so this logs against the date the note was written rather than today.'
                      : ' That note carries no usable timestamp, so this logs as written down today and will show as logged late.'}
                  </p>

                  <div className="ml-actions">
                    {/* The edited version. The header's button logs the
                        suggestion as it stands; this one logs what is on
                        screen. */}
                    <button type="button" onClick={() => acceptSuggestion(sg, sDraft)} disabled={busy === `sg${sg.id}`}>
                      {busy === `sg${sg.id}` ? 'Logging…' : 'Log it with these changes'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}

          {/* ⚠ No silent caps. A filter that removed two thirds of what it found
              reads as "there was nothing else" unless it says so. */}
          {suggest.skipped && (
            <p className="ml-hint">
              Read {suggest.scanned} meeting notes.
              {suggest.skipped.oneToOne ? ` ${suggest.skipped.oneToOne} were formal 1-2-1s.` : ''}
              {suggest.skipped.tooManyPeople ? ` ${suggest.skipped.tooManyPeople} named four or more of the team, so they read as team meetings rather than management conversations.` : ''}
              {suggest.skipped.alreadyLogged ? ` ${suggest.skipped.alreadyLogged} are already on the log.` : ''}
              {suggest.skipped.dismissed ? ` ${suggest.skipped.dismissed} you have dismissed.` : ''}
            </p>
          )}
        </section>
      )}

      {/* ── Log something ─────────────────────────────────────────────── */}
      <section className="ml-section">
        <h3>Log a conversation</h3>
        <div className="ml-add">
          <div className="ml-row">
            <label>
              Kind
              <select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value })}>
                {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <label>
              Who with
              <input
                type="text" placeholder="e.g. Naomi"
                value={draft.person}
                onChange={e => setDraft({ ...draft, person: e.target.value })}
              />
            </label>
            <label>
              When it happened
              <input
                type="date" value={draft.entryDate}
                onChange={e => setDraft({ ...draft, entryDate: e.target.value })}
              />
            </label>
          </div>

          <label className="ml-field">
            What was it
            <textarea
              rows={2}
              placeholder="One line. What was discussed, raised or agreed."
              value={draft.summary}
              onChange={e => setDraft({ ...draft, summary: e.target.value })}
            />
          </label>

          <div className="ml-row">
            <label>
              Owner
              <input
                type="text" placeholder="Nick"
                value={draft.owner}
                onChange={e => setDraft({ ...draft, owner: e.target.value })}
              />
            </label>
            <label>
              Due
              <input
                type="date" value={draft.dueDate}
                onChange={e => setDraft({ ...draft, dueDate: e.target.value })}
              />
            </label>
          </div>

          <label className="ml-field">
            Follow-up <span className="ml-optional">(optional)</span>
            <textarea
              rows={2}
              placeholder="What happens next, and by whom."
              value={draft.action}
              onChange={e => setDraft({ ...draft, action: e.target.value })}
            />
          </label>

          {/* ⚠ Said out loud, because it is what makes the record evidence
              rather than a self-report — and because a form with a date field
              otherwise looks like a way to make a late entry look on time. */}
          <p className="ml-hint">
            You choose when it <em>happened</em>. NEURO stamps when it was <em>logged</em>, from its own
            clock — that gap is the two-working-day standard, and it is not editable from here.
          </p>

          <div className="ml-actions">
            <button type="button" onClick={addEntry} disabled={busy === 'add'}>
              {busy === 'add' ? 'Logging…' : 'Log it'}
            </button>
          </div>
        </div>

        {/* The receipt. Every line is read back from the assessment, and it
            stays until dismissed — a confirmation that fades is one you cannot
            check. */}
        {logged && (
          <div className={`ml-receipt ${logged.late ? 'ml-receipt-late' : ''}`}>
            <p className="ml-receipt-head">Logged as <strong>#{logged.id}</strong> — {logged.summary}</p>
            <ul>
              <li>Happened {fmtUk(logged.entryDate)} · written down {fmtStamp(logged.loggedAt)}</li>
              {logged.late ? (
                <li className="ml-bad">
                  <strong>{logged.late.workingDays} working days</strong> between the two — past the
                  two-day standard, and it will appear in the report as logged late. That is the
                  correct record of what happened.
                </li>
              ) : (
                <li>Inside the two-working-day standard.</li>
              )}
              {logged.missingOwner && <li className="ml-bad">No owner — competency 3 needs one on every open item.</li>}
              {logged.missingDue && <li className="ml-bad">No due date — competency 3 needs one on every open item.</li>}
              {logged.hrPending && <li>Not yet answered for People HR — it is below, and says nothing to Chris until you answer.</li>}
            </ul>
            <button type="button" className="ml-toggle" onClick={() => setLogged(null)}>dismiss</button>
          </div>
        )}
      </section>

      {/* ── Where it stands ───────────────────────────────────────────── */}
      <section className="ml-section">
        <h3>Where it stands</h3>
        <div className="ml-stats">
          <div className="ml-stat">
            <span className="ml-stat-value">{log.totals.open}</span>
            <span className="ml-stat-label">Open</span>
          </div>
          <div className={`ml-stat ${log.overdueCount ? 'ml-tone-warn' : ''}`}>
            <span className="ml-stat-value">{log.overdueCount}</span>
            <span className="ml-stat-label">Overdue</span>
          </div>
          <div className={`ml-stat ${log.breachesFiveDay.length ? 'ml-tone-bad' : ''}`}>
            <span className="ml-stat-value">{log.breachesFiveDay.length}</span>
            <span className="ml-stat-label">Over 5 working days</span>
          </div>
          <div className={`ml-stat ${log.lateLogged.length ? 'ml-tone-warn' : ''}`}>
            <span className="ml-stat-value">{log.lateLogged.length}</span>
            <span className="ml-stat-label">Logged late</span>
          </div>
          <div className="ml-stat">
            <span className="ml-stat-value">{log.totals.rows}</span>
            <span className="ml-stat-label">Entries in total</span>
          </div>
        </div>

        {/* ⚠ Three answers, not one. Reporting an unrecorded baseline as 0 told
            Nick an outstanding PIP deliverable was already met — the bug of
            7 Sep 2026. See management-log.assessBaseline. */}
        {log.baseline.known === false ? (
          <p className="ml-warn-line">
            Competency 4 baseline at {fmtUk(log.baseline.date)}: <strong>not recorded</strong> —
            {' '}{log.baseline.reason} This is <strong>not</strong> zero · target 0 by {fmtUk(log.baseline.targetDate)}
          </p>
        ) : (
          <p className="ml-hint">
            Competency 4 baseline at {fmtUk(log.baseline.date)}: <strong>{log.baseline.count}</strong>
            {log.baseline.source === 'agreed' ? ' (agreed with Chris)' : ' (counted from the log)'}
            {' '}({log.baseline.stillOpen} still open) · target 0 by {fmtUk(log.baseline.targetDate)}
          </p>
        )}

        {log.hrGap.length > 0 && (
          <p className="ml-warn-line">
            {log.hrGap.length} conversation{log.hrGap.length === 1 ? '' : 's'}/concern{log.hrGap.length === 1 ? '' : 's'} confirmed
            {' '}<strong>not</strong> in People HR — this goes in the report.
          </p>
        )}
      </section>

      {/* ── People HR, asked once per item ────────────────────────────── */}
      {log.hrUnknown?.length > 0 && (
        <section className="ml-section">
          <h3>Is this in People HR?</h3>
          {/* Unknown is a question, never a claim. It appears in nothing Chris
              receives until it is answered. */}
          <p className="ml-hint">NEURO has never been told, so it says nothing in the report either way.</p>
          {log.hrUnknown.map(h => (
            <div key={h.id} className="ml-hr-row">
              <span>{h.person ? `${h.person} — ` : ''}{h.summary}</span>
              <span className="ml-hr-buttons">
                <button type="button" onClick={() => setHr(h.id, true)} disabled={busy === `hr${h.id}`}>Yes</button>
                <button type="button" onClick={() => setHr(h.id, false)} disabled={busy === `hr${h.id}`}>No</button>
                {/* ⚠ Its own button, never folded into "No" — see removeRow. */}
                <button
                  type="button" className="ml-hr-drop" disabled={busy === `hr${h.id}`}
                  onClick={() => removeRow(h.id, `${h.person ? `${h.person} — ` : ''}${h.summary}`)}
                >
                  Not mine
                </button>
              </span>
            </div>
          ))}
        </section>
      )}

      {/* ── Everything on the log ─────────────────────────────────────── */}
      <section className="ml-section">
        <h3>Entries</h3>
        <div className="ml-filters">
          <select value={filter.status} onChange={e => setFilter({ ...filter, status: e.target.value })}>
            <option value="open">Open</option>
            <option value="done">Closed</option>
            <option value="all">All</option>
          </select>
          <select value={filter.type} onChange={e => setFilter({ ...filter, type: e.target.value })}>
            <option value="all">Every kind</option>
            {TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <input
            type="text" placeholder="Search summary, person or owner"
            value={filter.q}
            onChange={e => setFilter({ ...filter, q: e.target.value })}
          />
          <span className="ml-count">{rows.length} of {log.totals.rows}</span>
        </div>

        {rows.length === 0 ? (
          /* ⚠ A filter finding nothing is not an empty log, and the words say
             which — otherwise a narrow filter reads as a record nobody kept. */
          <p className="ml-empty">
            {log.totals.rows === 0
              ? 'Nothing logged yet. Anything you log above appears here.'
              : `No entries match this filter — the log itself holds ${log.totals.rows}.`}
          </p>
        ) : (
          <ul className="ml-list">
            {rows.map(r => {
              const od = overdueById.get(r.id);
              const open = editing === r.id;
              return (
                <li key={r.id} className={`ml-item ${open ? 'ml-item-open' : ''}`}>
                  <div
                    className="ml-item-head" role="button" tabIndex={0}
                    onClick={() => openEdit(r)}
                    onKeyDown={e => { if (e.key === 'Enter') openEdit(r); }}
                  >
                    <div className="ml-item-main">
                      <span className={`ml-kind ml-kind-${r.type}`}>{r.type}</span>
                      <span className="ml-summary">{r.summary}</span>
                    </div>
                    <div className="ml-meta">
                      <span className="ml-id">#{r.id}</span>
                      {r.person && <span>{r.person}</span>}
                      <span>{r.owner || <em className="ml-bad">unowned</em>}</span>
                      <span>{fmtUk(r.entry_date)}</span>
                      {r.due_date
                        ? (
                          <span className={od ? 'ml-bad' : undefined}>
                            due {fmtUk(r.due_date)}{od ? ` · ${od.workingDaysOverdue}d over` : ''}
                          </span>
                        )
                        : <em className="ml-bad">no due date</em>}
                      <span className={`ml-status ml-status-${r.status}`}>{r.status}</span>
                      {lateIds.has(r.id) && <span className="ml-bad">logged late</span>}
                    </div>
                  </div>

                  {open && editDraft && (
                    /* Clicks are stopped at the wrapper, or the card closes
                       under the button being pressed — TaskControls' trap. */
                    <div className="ml-edit" onClick={e => e.stopPropagation()}>
                      <label className="ml-field">
                        What was it
                        <textarea
                          rows={2} value={editDraft.summary}
                          onChange={e => setEditDraft({ ...editDraft, summary: e.target.value })}
                        />
                      </label>

                      <div className="ml-row">
                        <label>
                          Who with
                          <input
                            type="text" value={editDraft.person}
                            onChange={e => setEditDraft({ ...editDraft, person: e.target.value })}
                          />
                        </label>
                        <label>
                          Owner
                          <input
                            type="text" value={editDraft.owner}
                            onChange={e => setEditDraft({ ...editDraft, owner: e.target.value })}
                          />
                        </label>
                        <label>
                          Status
                          <select
                            value={editDraft.status}
                            onChange={e => setEditDraft({ ...editDraft, status: e.target.value })}
                          >
                            {STATUSES.map(x => <option key={x} value={x}>{x}</option>)}
                          </select>
                        </label>
                      </div>

                      <div className="ml-row">
                        <label>
                          When it happened
                          <input
                            type="date" value={editDraft.entryDate}
                            onChange={e => setEditDraft({ ...editDraft, entryDate: e.target.value })}
                          />
                        </label>
                        <label>
                          Due
                          <input
                            type="date" value={editDraft.dueDate}
                            onChange={e => setEditDraft({ ...editDraft, dueDate: e.target.value })}
                          />
                        </label>
                      </div>

                      <label className="ml-field">
                        Follow-up
                        <textarea
                          rows={2} value={editDraft.action}
                          onChange={e => setEditDraft({ ...editDraft, action: e.target.value })}
                        />
                      </label>

                      <label className="ml-field">
                        Notes
                        <textarea
                          rows={2} value={editDraft.notes}
                          onChange={e => setEditDraft({ ...editDraft, notes: e.target.value })}
                        />
                      </label>

                      {/* ⚠ The one field that is NOT offered, said where the
                          edit happens and not only in the add form. */}
                      <p className="ml-hint">
                        Written down {fmtStamp(r.logged_at)} — the server&rsquo;s stamp, not editable.
                        {noOwnerIds.has(r.id) && ' This item has no owner.'}
                        {noDueIds.has(r.id) && ' It has no due date.'}
                      </p>

                      <div className="ml-actions">
                        <button type="button" onClick={() => saveEdit(r.id)} disabled={busy === `edit${r.id}`}>
                          {busy === `edit${r.id}` ? 'Saving…' : 'Save'}
                        </button>
                        {r.status !== 'done' && (
                          <button type="button" onClick={() => closeRow(r.id)} disabled={busy === `edit${r.id}`}>
                            Close it
                          </button>
                        )}
                        <button
                          type="button" className="ml-hr-drop" disabled={busy === `hr${r.id}`}
                          onClick={() => removeRow(r.id, r.summary)}
                        >
                          Not mine
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
