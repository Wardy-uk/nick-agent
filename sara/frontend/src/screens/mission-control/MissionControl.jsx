import { useState } from 'react';
import { useSaraState } from '../../state/saraState';
import { SARA_VIEWS } from '../../state/views';
import './MissionControl.css';

// Mission Control — "JARVIS fusion" ambient HUD (WS2-WP4 redesign).
//
// A presence-first home screen: a pulsing central orb inside rotating reticle rings,
// framed by four glass readout cards, a header greeting + live clock, and a footer
// action row. Pure representation of shared state (charter principle 7).
//
// EYES-ON MODE (NOVA): the same orb/rings shell, but the four cards repopulate with the
// "needs Nick's eyes on" signal from model.nova — approvals waiting, overdue customers,
// exceptions. It auto-activates when SARA places you at work (location context/label),
// and can be toggled manually via the rail's eye button. Only the cards + core label
// change; the orb, rings, header and footer are untouched.

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function greeting(date) {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}
function formatState(activity) {
  return String(activity || 'online').replace(/[-_]/g, ' ').toUpperCase();
}
function humanise(s) {
  return typeof s === 'string'
    ? s.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    : null;
}

// whatMattersNow tone -> readout value colour class
const TONE_CLASS = { urgent: 'a', attention: 'w', watch: 'g' };

// Left nav rail items (full-bleed JARVIS view owns its own nav).
const NAV = [
  { id: SARA_VIEWS.BRIEFING, icon: '⌂', label: 'Home' },
  { id: SARA_VIEWS.QUEUE, icon: '▤', label: 'Queue' },
  { id: SARA_VIEWS.TEAM, icon: '👥', label: 'Team' },
  { id: SARA_VIEWS.FOCUS, icon: '◎', label: 'Focus' },
  { id: SARA_VIEWS.TODOS, icon: '☑', label: 'Tasks' },
  { id: SARA_VIEWS.VAULT, icon: '▦', label: 'Vault' },
  { id: SARA_VIEWS.CAPTURE, icon: '✎', label: 'Capture' },
  { id: SARA_VIEWS.SARA, icon: '◴', label: 'SARA' },
  { id: SARA_VIEWS.STANDUP, icon: '◇', label: 'Standup' },
  { id: SARA_VIEWS.SETTINGS, icon: '⚙', label: 'Settings' },
];

export default function MissionControl() {
  const { status, error, model, now, presentation, currentView, setCurrentView, runQuickAction } =
    useSaraState();
  // Eyes-On override: null = follow location (auto), true/false = manual hold.
  const [eyesOverride, setEyesOverride] = useState(null);

  if (status === 'connecting') {
    return (
      <section className="jv jv--msg" aria-label="Mission Control">
        <p className="jv__msg-text">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="jv jv--msg" aria-label="Mission Control">
        <p className="jv__msg-text jv__msg-text--err">
          SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.
        </p>
      </section>
    );
  }

  const name = model.user?.name || 'Nick';
  const activity = model.inference?.activity || model.sara?.status || 'online';
  const conf = model.confidence || {};
  const confPct =
    typeof conf.score === 'number'
      ? Math.round(conf.score > 1 ? conf.score : conf.score * 100)
      : null;

  const matters = (presentation?.whatMattersNow || []).slice(0, 3);
  const upNext = (presentation?.upNext || [])[0];
  const queue = model.domains?.queue || {};
  const people = model.domains?.people || {};
  const env = model.telemetry?.signals?.environment;

  // SITREP card values
  const locLabel = model.location?.label || humanise(model.location?.zone?.label) || '—';
  const upNextStr = upNext ? `${upNext.time !== 'Next' ? upNext.time + ' ' : ''}${upNext.label}` : '—';

  // QUEUE card: team needing attention (slipping/watch) out of total
  const needAttention = (people.members || []).filter((m) => m.status !== 'solid').length;

  const actions = (presentation?.quickActions || []).slice(0, 4);

  // --- Eyes-On mode -------------------------------------------------------------
  // Auto-on when SARA places you at work (location context 'work', or an office/work
  // label as a GPS-for-now heuristic). A manual toggle holds it on/off until cleared.
  const atWork =
    model.location?.context === 'work' || /office|work/i.test(model.location?.label || '');
  const eyesOn = eyesOverride !== null ? eyesOverride : atWork;
  const nova = model.nova;
  const novaEyes = nova?.eyesOn;
  const novaOk = !!nova?.available;
  const eyesItems = (novaEyes?.items || []).slice(0, 3);
  const nstats = novaEyes?.stats || {};

  const tlHead = eyesOn ? 'Needs your eyes' : 'Priorities';
  const blHead = eyesOn ? 'Workload' : 'Queue';
  const brHead = eyesOn ? 'Status' : 'Conditions';
  const topLeftTarget = eyesOn ? SARA_VIEWS.ATWORK : SARA_VIEWS.FOCUS;
  const topRightTarget = eyesOn ? SARA_VIEWS.ATWORK : SARA_VIEWS.FOCUS;
  const bottomLeftTarget = eyesOn ? SARA_VIEWS.ATWORK : SARA_VIEWS.QUEUE;
  const bottomRightTarget = eyesOn ? SARA_VIEWS.ATWORK : SARA_VIEWS.SETTINGS;

  return (
    <section className="jv" aria-label="Mission Control" data-mode={eyesOn ? 'eyes-on' : 'standard'}>
      {/* left nav rail (full-bleed view owns its own nav) */}
      <nav className="jv__nav" aria-label="SARA views">
        <div className="jv__nav-orb" aria-hidden="true" />
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`jv__nav-btn${currentView === item.id ? ' jv__nav-btn--on' : ''}`}
            onClick={() => setCurrentView(item.id)}
            title={item.label}
            aria-label={item.label}
          >
            {item.icon}
          </button>
        ))}
        {/* Eyes-On toggle — holds the work dashboard on/off regardless of location. */}
        <button
          type="button"
          className={`jv__nav-btn jv__nav-eye${eyesOn ? ' jv__nav-btn--on' : ''}`}
          onClick={() => setEyesOverride(!eyesOn)}
          title={`Eyes On${eyesOverride === null ? ' (auto)' : ''}`}
          aria-label="Eyes On"
          aria-pressed={eyesOn}
        >
          ◉
        </button>
      </nav>

      {/* rotating reticle rings */}
      <div className="jv__reticle" aria-hidden="true">
        <div className="jv__ring jv__ring--1" />
        <div className="jv__ring jv__ring--2" />
        <div className="jv__ring jv__ring--3" />
      </div>

      {/* central pulsing orb */}
      <div className="jv__orbwrap" aria-hidden="true">
        <div className="jv__pulse" />
        <div className="jv__pulse jv__pulse--b" />
        <div className="jv__orb" data-state={model.sara?.status}>
          <div className="jv__glint" />
        </div>
      </div>
      <div className="jv__coreinfo">
        <div className="jv__core-state">{eyesOn ? '◉ EYES ON' : `◇ ${formatState(activity)}`}</div>
        {confPct != null && (
          <div className="jv__core-conf">
            {confPct}% {conf.level || ''} confidence
          </div>
        )}
      </div>

      {/* header */}
      <header className="jv__hdr">
        <div>
          <div className="jv__eyebrow">S.A.R.A · {(model.sara?.status || 'online').toUpperCase()}</div>
          <div className="jv__greet">
            {greeting(now)}, {name}
          </div>
        </div>
        <div className="jv__clock">{formatTime(now)}</div>
      </header>

      {/* TOP-LEFT — Priorities / Needs your eyes */}
      <button
        type="button"
        className="jv__card jv__card--tl jv__card-btn"
        onClick={() => setCurrentView(topLeftTarget)}
      >
        <div className="jv__card-h">{tlHead}</div>
        {eyesOn ? (
          !novaOk ? (
            <div className="jv__li"><span className="jv__li-k">NOVA</span><span className="jv__li-v jv__li-v--w">not connected</span></div>
          ) : novaEyes?.allClear ? (
            <div className="jv__li"><span className="jv__li-k">All clear</span><span className="jv__li-v jv__li-v--g">✓</span></div>
          ) : (
            eyesItems.map((it) => (
              <div className="jv__li" key={it.id}>
                <span className="jv__li-k">{it.title}</span>
                <span className={`jv__li-v jv__li-v--${toneForP(it.priority)}`}>{eyesValue(it)}</span>
              </div>
            ))
          )
        ) : matters.length ? (
          matters.map((m) => (
            <div className="jv__li" key={m.id}>
              <span className="jv__li-k">{m.title}</span>
              <span className={`jv__li-v jv__li-v--${TONE_CLASS[m.tone] || 'g'}`}>{shortDetail(m.detail)}</span>
            </div>
          ))
        ) : (
          <div className="jv__li"><span className="jv__li-k">Queue calm</span></div>
        )}
      </button>

      {/* TOP-RIGHT — Sitrep */}
      <button
        type="button"
        className="jv__card jv__card--tr jv__card-btn"
        onClick={() => setCurrentView(topRightTarget)}
      >
        <div className="jv__card-h">Sitrep</div>
        <div className="jv__li"><span className="jv__li-k">Location</span><span className="jv__li-v">{locLabel}</span></div>
        {eyesOn ? (
          <>
            <div className="jv__li"><span className="jv__li-k">Approvals</span><span className={`jv__li-v jv__li-v--${nstats.approvalsPending ? 'a' : 'g'}`}>{novaOk ? (nstats.approvalsPending ?? 0) : '—'}</span></div>
            <div className="jv__li"><span className="jv__li-k">Overdue</span><span className={`jv__li-v jv__li-v--${nstats.customersOverdue ? 'a' : 'g'}`}>{novaOk ? (nstats.customersOverdue ?? 0) : '—'}</span></div>
          </>
        ) : (
          <>
            <div className="jv__li"><span className="jv__li-k">Up next</span><span className="jv__li-v">{upNextStr}</span></div>
            <div className="jv__li"><span className="jv__li-k">Confidence</span><span className="jv__li-v jv__li-v--g">{confPct != null ? `${confPct}% ${conf.level || ''}` : '—'}</span></div>
          </>
        )}
      </button>

      {/* BOTTOM-LEFT — Queue / Workload */}
      <button
        type="button"
        className="jv__card jv__card--bl jv__card-btn"
        onClick={() => setCurrentView(bottomLeftTarget)}
      >
        <div className="jv__card-h">{blHead}</div>
        {eyesOn ? (
          <>
            <div className="jv__li"><span className="jv__li-k">Approvals waiting</span><span className={`jv__li-v jv__li-v--${nstats.approvalsPending ? 'a' : 'g'}`}>{novaOk ? (nstats.approvalsPending ?? 0) : '—'}</span></div>
            <div className="jv__li"><span className="jv__li-k">Customers overdue</span><span className={`jv__li-v jv__li-v--${nstats.customersOverdue ? 'a' : 'g'}`}>{novaOk ? (nstats.customersOverdue ?? 0) : '—'}</span></div>
            <div className="jv__li"><span className="jv__li-k">Timed out</span><span className="jv__li-v">{novaOk ? (nstats.approvalsTimedOut ?? 0) : '—'}</span></div>
          </>
        ) : (
          <>
            <div className="jv__li"><span className="jv__li-k">Open</span><span className="jv__li-v">{queue.open ?? '—'}</span></div>
            <div className="jv__li"><span className="jv__li-k">Breaching SLA</span><span className={`jv__li-v jv__li-v--${queue.breaching ? 'a' : 'g'}`}>{queue.breaching ?? 0}</span></div>
            <div className="jv__li"><span className="jv__li-k">Team flags</span><span className={`jv__li-v jv__li-v--${needAttention ? 'w' : 'g'}`}>{needAttention ? `${needAttention} need attention` : 'all steady'}</span></div>
          </>
        )}
      </button>

      {/* BOTTOM-RIGHT — Conditions / Status */}
      <button
        type="button"
        className="jv__card jv__card--br jv__card-btn"
        onClick={() => setCurrentView(bottomRightTarget)}
      >
        <div className="jv__card-h">{brHead}</div>
        {eyesOn ? (
          !novaOk ? (
            <div className="jv__li"><span className="jv__li-k">NOVA</span><span className="jv__li-v jv__li-v--w">standby</span></div>
          ) : (
            <>
              <div className="jv__li"><span className="jv__li-k">Exceptions</span><span className={`jv__li-v jv__li-v--${novaEyes?.allClear ? 'g' : 'a'}`}>{novaEyes?.allClear ? 'all clear' : `${(novaEyes?.items || []).length} to action`}</span></div>
              <div className="jv__li"><span className="jv__li-k">Commitments</span><span className="jv__li-v jv__li-v--g">{nstats.commitmentsMet != null ? `${nstats.commitmentsMet}%` : '—'}</span></div>
            </>
          )
        ) : env ? (
          <>
            <div className="jv__li"><span className="jv__li-k">{env.label?.split(':')[0] || 'Sensor'}</span><span className="jv__li-v">{env.state}{env.unit || ''}</span></div>
            <div className="jv__li"><span className="jv__li-k">Telemetry</span><span className="jv__li-v jv__li-v--g">live</span></div>
            <div className="jv__li"><span className="jv__li-k">Source</span><span className="jv__li-v">Home Assistant</span></div>
          </>
        ) : (
          <div className="jv__li"><span className="jv__li-k">Telemetry</span><span className="jv__li-v">standby</span></div>
        )}
      </button>

      {/* footer actions + SARA line */}
      <div className="jv__foot">
        {actions.map((a) => (
          <button
            key={a.id}
            type="button"
            className="jv__act"
            onClick={() => runQuickAction?.(a.action)}
          >
            {a.icon} {a.label}
          </button>
        ))}
        <span className="jv__say">
          ▸ SARA: {eyesOn
            ? (novaOk ? novaEyes?.headline : 'NOVA not connected — set NOVA_BASE_URL to surface approvals.')
            : (model.inference?.summary || 'standing by.')}
        </span>
      </div>
    </section>
  );
}

// keep readout values short so cards stay tidy (word-boundary truncation, no mid-word cuts)
function shortDetail(detail) {
  if (!detail) return '';
  const s = String(detail);
  const m = s.match(/(\d+m SLA|overdue by \d+d|\d+ unseen|×\d+|\d+d)/i);
  if (m) return m[0];
  const tail = s.split('·').pop().trim();
  if (tail.length <= 16) return tail;
  return `${tail.slice(0, 16).replace(/\s+\S*$/, '')}…`;
}

// eyes-on helpers
function toneForP(p) {
  return p >= 3 ? 'a' : p === 2 ? 'w' : 'g';
}
function fmtAgeShort(m) {
  if (typeof m !== 'number') return '';
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}
function eyesValue(it) {
  if (it.kind === 'approval') return it.ageMins != null ? fmtAgeShort(it.ageMins) : 'review';
  if (it.kind === 'overdue') return 'overdue';
  return 'today';
}
