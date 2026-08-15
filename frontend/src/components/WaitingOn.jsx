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
  }, []);

  useEffect(() => { load(); }, [load]);

  const resolveQueued = async (id, verb) => {
    setActingId(id);
    try {
      await fetch(apiUrl(`/api/actions/${id}/${verb}`), { method: 'POST' });
    } catch { /* the reload below tells the truth either way */ }
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

  if (visible.length === 0 && myQueued.length === 0) {
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
      {myQueued.length > 0 && (
        <div className="wo-queued">
          <div className="wo-queued-h">
            {myQueued.length} chase{myQueued.length === 1 ? '' : 's'} waiting for you — nothing has been sent
          </div>
          {myQueued.map(a => (
            <div key={a.id} className="wo-queued-item">
              <div className="wo-queued-to">To {a.payload?.person}</div>
              <pre className="wo-queued-body">{a.payload?.body || '(no draft stored — approving will build one)'}</pre>
              <div className="wo-row-actions">
                <button className="wo-btn wo-btn-ok" disabled={actingId === a.id} onClick={() => resolveQueued(a.id, 'approve')}>
                  {actingId === a.id ? 'Sending…' : 'Approve & send'}
                </button>
                <button className="wo-btn wo-btn-ghost" disabled={actingId === a.id} onClick={() => resolveQueued(a.id, 'reject')}>
                  Discard
                </button>
              </div>
            </div>
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
