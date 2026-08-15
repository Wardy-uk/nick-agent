import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './WaitingOn.css';

/**
 * Waiting on — what other people owe Nick.
 *
 * The backend for this has been live and migrated since 15 Aug (287 items, 29
 * people, oldest 107 days) with no way to reach it. This is that way.
 *
 * Grouped by person, worst offender first, oldest-first within a person (Q11) —
 * because the question is never "what is the oldest commitment", it is "what
 * does Naomi owe me", asked once per 1-2-1.
 *
 * PULL-ONLY (Q14). Nothing here notifies, and `chase` QUEUES for approval — it
 * never sends. A chase goes to a direct report, and an automated one reads as
 * surveillance.
 */

const SNOOZE_PRESETS = [
  { label: 'Tomorrow', days: 1 },
  { label: 'Next week', days: 7 },
  { label: '2 weeks', days: 14 },
];

// Rows shown per person before "N older". Oldest-first ordering means the cut
// is always the least urgent end of the list.
const ITEM_CAP = 5;

/** YYYY-MM-DD n days out, built from local getters — toISOString() shifts the day in BST. */
function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ageLabel(days) {
  if (days >= 365) return `${Math.floor(days / 365)}y`;
  return `${days}d`;
}

function WaitingRow({ item, onAct, busy }) {
  const [snoozing, setSnoozing] = useState(false);
  const [customDate, setCustomDate] = useState('');

  return (
    <div className={`wo-row${item.stale ? ' is-stale' : ''}${item.snoozed ? ' is-snoozed' : ''}`}>
      <div className="wo-row-main">
        <span className="wo-row-text">{item.text}</span>
        <span className="wo-row-meta">
          <span className={`wo-age${item.stale ? ' stale' : ''}`}>{ageLabel(item.ageDays)}</span>
          {item.sourceDate && <span className="wo-src">{item.sourceDate}</span>}
          {item.chaseCount > 0 && (
            <span className="wo-chased">chased {item.chaseCount}×</span>
          )}
          {item.snoozed && <span className="wo-snoozed-tag">snoozed</span>}
        </span>
      </div>

      {snoozing ? (
        <div className="wo-snooze">
          {SNOOZE_PRESETS.map(p => (
            <button
              key={p.days}
              className="wo-btn"
              disabled={busy}
              onClick={() => { setSnoozing(false); onAct('snooze', { until: isoDaysFromNow(p.days) }); }}
            >
              {p.label}
            </button>
          ))}
          <input
            type="date"
            className="wo-date"
            value={customDate}
            onChange={e => setCustomDate(e.target.value)}
          />
          <button
            className="wo-btn"
            disabled={busy || !customDate}
            onClick={() => { setSnoozing(false); onAct('snooze', { until: customDate }); }}
          >
            Until
          </button>
          <button className="wo-btn wo-btn-ghost" onClick={() => setSnoozing(false)}>Cancel</button>
        </div>
      ) : (
        <div className="wo-row-actions">
          {/* Queues a pending action. It does not send — approve it in Actions. */}
          <button className="wo-btn" disabled={busy} onClick={() => onAct('chase')} title="Queue a chase for your approval — nothing sends yet">
            Chase
          </button>
          <button className="wo-btn wo-btn-ok" disabled={busy} onClick={() => onAct('done')} title="They delivered">
            Done
          </button>
          <button className="wo-btn wo-btn-ghost" disabled={busy} onClick={() => onAct('drop')} title="Misparsed, or overtaken by events">
            Drop
          </button>
          <button className="wo-btn wo-btn-ghost" disabled={busy} onClick={() => setSnoozing(true)} title="Hide until a date — it keeps ageing">
            Snooze
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A chase waiting to be approved. Shows the exact words and the exact address —
 * both were resolved and stored when the chase was queued, so this is what will
 * actually go out, not a reconstruction of it.
 *
 * The address is editable because the directory resolves a canonical FIRST name
 * and can be wrong or ambiguous ("Chris" comes back ambiguous), and the only one
 * who knows which Chris is which is Nick.
 */
function QueuedChase({ action, busy, teamsAvailable, onResolve, onRetarget, onChannel }) {
  const to = action.payload?.to || {};
  const channel = action.payload?.channel === 'teams' ? 'teams' : 'email';
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(to.email || '');
  const [err, setErr] = useState(null);

  const save = async () => {
    setErr(null);
    const result = await onRetarget(draft);
    if (result?.ok) setEditing(false);
    else setErr(result?.error || 'Could not update the address');
  };

  return (
    <div className="wo-queued-item">
      <div className="wo-queued-to">
        <span>To {action.payload?.person}</span>
        {!editing && (
          <>
            {to.email
              ? <span className="wo-queued-email">{to.email}</span>
              : <span className="wo-queued-noemail">
                  no address ({to.status || 'unresolved'}) — set one before sending
                </span>}
            <button className="wo-btn wo-btn-ghost" onClick={() => { setDraft(to.email || ''); setEditing(true); }}>
              {to.email ? 'Change' : 'Set address'}
            </button>
            {to.source === 'manual' && <span className="wo-queued-manual">you set this</span>}
          </>
        )}
      </div>

      {editing && (
        <div className="wo-queued-edit">
          <input
            type="email"
            className="wo-queued-input"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            placeholder="name@nurtur.tech"
            spellCheck={false}
            autoCapitalize="none"
          />
          <button className="wo-btn" onClick={save} disabled={!draft.trim()}>Save</button>
          <button className="wo-btn wo-btn-ghost" onClick={() => { setEditing(false); setErr(null); }}>Cancel</button>
        </div>
      )}
      {err && <div className="wo-queued-err">{err}</div>}

      {/* Only offered once ChatMessage.Send is consented. A picker whose only
          working option is the default is noise, and it would imply Teams works
          when it does not. Until then every chase goes by email — the Q9 order
          regardless. */}
      {teamsAvailable && (
        <div className="wo-queued-channel">
          <span>Send via</span>
          {['email', 'teams'].map(c => (
            <button
              key={c}
              className={`wo-btn${channel === c ? ' is-on' : ''}`}
              disabled={busy}
              onClick={() => onChannel(c)}
            >
              {c === 'teams' ? 'Teams DM' : 'Email'}
            </button>
          ))}
        </div>
      )}

      <pre className="wo-queued-body">{action.payload?.body || '(no draft stored — approving will build one)'}</pre>

      <div className="wo-row-actions">
        <button
          className="wo-btn wo-btn-ok"
          disabled={busy || editing || !to.email}
          title={!to.email ? 'Set an address first' : `Sends to ${to.email}`}
          onClick={() => onResolve('approve')}
        >
          {busy
            ? 'Sending…'
            : to.email
              ? `Approve & send ${channel === 'teams' ? 'as a Teams DM' : 'to'} ${to.email}`
              : 'Approve & send'}
        </button>
        <button className="wo-btn wo-btn-ghost" disabled={busy} onClick={() => onResolve('reject')}>
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * @param {string}  [person]      canonical first name — renders one person only, unexpanded
 * @param {boolean} [embedded]    drop the section header (inside a person overlay)
 */
export default function WaitingOn({ person = null, embedded = false }) {
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState({});   // person -> bool
  const [showAll, setShowAll] = useState(false);
  const [showAllItems, setShowAllItems] = useState({});   // person -> bool
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [busyKey, setBusyKey] = useState(null);
  const [flash, setFlash] = useState(null);       // { key, text }

  const [queued, setQueued] = useState([]);       // pending chase_commitment actions
  const [actingId, setActingId] = useState(null);
  const [queuedFlash, setQueuedFlash] = useState(null);   // outcome of the last approve
  const [teamsAvailable, setTeamsAvailable] = useState(false);

  const load = useCallback(() => {
    fetch(apiUrl('/api/waiting-on/by-person'))
      .then(r => r.json())
      .then(d => setGroups(d.people || []))
      .catch(e => setError(e.message));

    // A queued chase had nowhere to be approved — nothing in the app read
    // /api/actions, so pressing Chase dropped the action into a hole. The
    // approval belongs beside the thing being approved anyway.
    fetch(apiUrl('/api/actions'))
      .then(r => r.json())
      .then(d => setQueued((d.pending || []).filter(a => a.type === 'chase_commitment')))
      .catch(() => setQueued([]));

    // Teams DM needs ChatMessage.Send, which is awaiting tenant admin approval.
    // Asking rather than assuming is what makes the choice appear on its own the
    // day consent lands — no code change, no redeploy.
    fetch(apiUrl('/api/microsoft/teams-send-status'))
      .then(r => r.json())
      .then(d => setTeamsAvailable(Boolean(d.available)))
      .catch(() => setTeamsAvailable(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const retarget = async (id, email) => {
    try {
      const res = await fetch(apiUrl(`/api/waiting-on/chase/${id}/recipient`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (data.ok) load();
      return data;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  };

  const setChannel = async (id, channel) => {
    try {
      await fetch(apiUrl(`/api/waiting-on/chase/${id}/channel`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel }),
      });
    } catch { /* the reload tells the truth */ }
    load();
  };

  const resolveQueued = async (id, verb) => {
    setActingId(id);
    setQueuedFlash(null);
    try {
      const res = await fetch(apiUrl(`/api/actions/${id}/${verb}`), { method: 'POST' });
      const data = await res.json();
      // A failed send marks the action `failed`, so it drops straight out of
      // pending and the card just vanishes. Say what happened, or "it didn't
      // send" is indistinguishable from "it sent".
      if (verb === 'approve') {
        setQueuedFlash(data.ok
          ? { ok: true, text: data.detail || 'Sent' }
          : { ok: false, text: data.detail || data.error || 'Send failed' });
      }
    } catch (e) {
      setQueuedFlash({ ok: false, text: e.message });
    }
    setActingId(null);
    load();
  };

  // Snoozed items still come back from the API — hiding them is the whole point
  // of snoozing, but they have to stay reachable or a mis-snooze is unrecoverable.
  const visible = (groups || [])
    .filter(g => (person ? g.person.toLowerCase() === person.toLowerCase() : true))
    .map(g => {
      const items = showSnoozed ? g.items : g.items.filter(i => !i.snoozed);
      return { ...g, items, count: items.length, oldestDays: items[0]?.ageDays ?? 0 };
    })
    .filter(g => g.items.length > 0);

  const snoozedCount = (groups || [])
    .filter(g => (person ? g.person.toLowerCase() === person.toLowerCase() : true))
    .reduce((n, g) => n + g.items.filter(i => i.snoozed).length, 0);

  const act = async (item, action, body = {}) => {
    setBusyKey(item.key);
    setFlash(null);
    const path = action === 'chase'
      ? `chase`
      : action === 'snooze'
        ? `snooze`
        : `resolve`;
    const payload = action === 'chase'
      ? {}
      : action === 'snooze'
        ? { until: body.until }
        : { status: action === 'drop' ? 'dropped' : 'done' };

    try {
      const res = await fetch(apiUrl(`/api/waiting-on/${encodeURIComponent(item.key)}/${path}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) throw new Error(data.error || 'Failed');

      if (action === 'chase') {
        // Deliberately says queued, not sent. Nothing leaves without approval,
        // and the draft appears at the top of this panel for you to read.
        setFlash({ key: item.key, text: 'Queued — read it at the top of this panel, then approve' });
        load();
      } else {
        // done / drop / snooze all take it off this list; re-read rather than
        // patch, so the group counts and ordering stay the backend's answer.
        load();
      }
    } catch (e) {
      setFlash({ key: item.key, text: `Failed: ${e.message}` });
    }
    setBusyKey(null);
  };

  const myQueued = queued.filter(a =>
    !person || String(a.payload?.person || '').toLowerCase() === person.toLowerCase());

  if (error) return <div className="waiting-on wo-error">Waiting-on unavailable: {error}</div>;
  if (!groups) return null;

  if (visible.length === 0 && myQueued.length === 0 && !queuedFlash) {
    if (person) return null;                        // person overlay: silent when clear
    if (snoozedCount > 0) {
      return (
        <div className="waiting-on">
          <div className="wo-head">
            <span className="wo-title">Waiting on</span>
            <button className="wo-toggle" onClick={() => setShowSnoozed(true)}>
              nothing due · {snoozedCount} snoozed
            </button>
          </div>
        </div>
      );
    }
    return null;
  }

  const shown = person || showAll ? visible : visible.slice(0, 5);
  const totalItems = visible.reduce((n, g) => n + g.count, 0);

  return (
    <div className={`waiting-on${embedded ? ' wo-embedded' : ''}`}>
      <div className="wo-head">
        <span className="wo-title">Waiting on</span>
        <span className="wo-summary">
          {person
            ? `${totalItems} outstanding${visible[0] ? ` · oldest ${ageLabel(visible[0].oldestDays)}` : ''}`
            : `${totalItems} outstanding across ${visible.length} ${visible.length === 1 ? 'person' : 'people'}`
              + (visible[0] ? ` · oldest ${ageLabel(visible[0].oldestDays)}` : '')}
        </span>
        {snoozedCount > 0 && (
          <button className="wo-toggle" onClick={() => setShowSnoozed(s => !s)}>
            {showSnoozed ? 'hide snoozed' : `${snoozedCount} snoozed`}
          </button>
        )}
      </div>

      {/* Queued chases, awaiting approval. Shown in full: this sends a real
          email to a direct report, so the exact words are on screen before the
          approve button, not a summary of them. The body was built and stored
          when the chase was queued, so this IS what goes out. */}
      {(myQueued.length > 0 || queuedFlash) && (
        <div className="wo-queued">
          {queuedFlash && (
            <div className={`wo-queued-flash${queuedFlash.ok ? '' : ' bad'}`}>
              {queuedFlash.ok ? '✓ ' : '✗ '}{queuedFlash.text}
            </div>
          )}
          {myQueued.length > 0 && (
            <div className="wo-queued-h">
              {myQueued.length} chase{myQueued.length === 1 ? '' : 's'} waiting for you — nothing has been sent
            </div>
          )}
          {myQueued.map(a => (
            <QueuedChase
              key={a.id}
              action={a}
              busy={actingId === a.id}
              teamsAvailable={teamsAvailable}
              onResolve={verb => resolveQueued(a.id, verb)}
              onRetarget={email => retarget(a.id, email)}
              onChannel={c => setChannel(a.id, c)}
            />
          ))}
        </div>
      )}

      <div className="wo-groups">
        {shown.map((g, gi) => {
          // Worst offender is open on arrival; everyone else is one tap away.
          const isOpen = person ? true : (expanded[g.person] ?? gi === 0);
          return (
            <div key={g.person} className="wo-group">
              {/* In person mode the panel header already says who and how many,
                  so a group header would be the same line twice. */}
              {!person && (
                <button
                  className="wo-group-head"
                  onClick={() => setExpanded(p => ({ ...p, [g.person]: !isOpen }))}
                >
                  <span className="wo-group-name">
                    <span className="wo-caret">{isOpen ? '▾' : '▸'}</span>
                    {g.person}
                  </span>
                  <span className="wo-group-meta">
                    <span className="wo-group-count">{g.count}</span>
                    <span className={`wo-age${g.oldestDays >= 3 ? ' stale' : ''}`}>oldest {ageLabel(g.oldestDays)}</span>
                  </span>
                </button>
              )}

              {isOpen && (() => {
                // The worst offender opens with 13 items, which on a phone is
                // ~1900px of one person and buries the other 28 plus the whole
                // roster below them. Oldest first means the top few are the ones
                // that matter anyway.
                const capped = showAllItems[g.person] ? g.items : g.items.slice(0, ITEM_CAP);
                const hidden = g.items.length - capped.length;
                return (
                <div className="wo-items">
                  {capped.map(item => (
                    <React.Fragment key={item.key}>
                      <WaitingRow
                        item={item}
                        busy={busyKey === item.key}
                        onAct={(action, body) => act(item, action, body)}
                      />
                      {flash?.key === item.key && (
                        <div className={`wo-flash${/^Failed/.test(flash.text) ? ' bad' : ''}`}>{flash.text}</div>
                      )}
                    </React.Fragment>
                  ))}
                  {(hidden > 0 || showAllItems[g.person]) && (
                    <button
                      className="wo-more wo-more-items"
                      onClick={() => setShowAllItems(p => ({ ...p, [g.person]: !p[g.person] }))}
                    >
                      {hidden > 0 ? `${hidden} older` : 'Show fewer'}
                    </button>
                  )}
                </div>
                );
              })()}
            </div>
          );
        })}
      </div>

      {!person && visible.length > 5 && (
        <button className="wo-more" onClick={() => setShowAll(s => !s)}>
          {showAll ? 'Show fewer' : `Show all ${visible.length} people`}
        </button>
      )}
    </div>
  );
}
