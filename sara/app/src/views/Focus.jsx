import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api';
import './Focus.css';

// Focus = the single "what matters now" glance. Default view.
// Renders the brain's /api/focus: an optional SARA briefing, the recommended next
// action, then the prioritised items (tiered, scored, with a reason each).
const URGENCY = ['critical', 'high', 'medium', 'low'];

export default function Focus({ onNavigate }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });
  const [dismissing, setDismissing] = useState({});

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiFetch('/api/focus');
      setState({ loading: false, error: null, data });
    } catch (error) {
      setState({ loading: false, error: error.message, data: null });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function dismiss(item) {
    setDismissing((d) => ({ ...d, [item.id]: true }));
    try {
      await apiFetch('/api/focus/dismiss', {
        method: 'POST',
        body: JSON.stringify({ itemId: item.id, itemType: item.type }),
      });
      setState((s) => ({ ...s, data: { ...s.data, items: s.data.items.filter((i) => i.id !== item.id) } }));
    } catch { /* leave it in place if dismiss fails */ }
    finally { setDismissing((d) => ({ ...d, [item.id]: false })); }
  }

  function openUrl(url) {
    if (!url) return false;
    try {
      window.open(url, '_blank', 'noopener,noreferrer');
      return true;
    } catch {
      return false;
    }
  }

  function handleNavigateForType(type, meta = {}) {
    if (type === 'meeting') {
      onNavigate?.('prep');
      return true;
    }
    if (type === 'imports' || type === 'plaud') {
      onNavigate?.('brain');
      return true;
    }
    if (type === 'journal') {
      onNavigate?.('brain');
      return true;
    }
    if (type === 'capture') {
      onNavigate?.('capture');
      return true;
    }
    if (type === 'chat') {
      onNavigate?.('chat');
      return true;
    }
    return false;
  }

  function handleNextAction(action) {
    if (!action) return;
    if (openUrl(action.url)) return;
    if (action.target === 'meeting-prep') {
      onNavigate?.('prep');
      return;
    }
    if (action.target === 'capture') {
      onNavigate?.('capture');
      return;
    }
    if (action.target === 'standup' || action.target === 'queue' || action.target === 'inbox' || action.target === 'todos' || action.target === 'imports') {
      onNavigate?.('chat');
      return;
    }
    onNavigate?.('focus');
  }

function handleItemClick(item) {
    if (!item) return;
    if (openUrl(item.url || item.meta?.url)) return;
    if (handleNavigateForType(item.type, item.meta)) return;
    if (item.type === 'nudge' && item.meta?.type === 'standup') {
      onNavigate?.('chat');
      return;
    }
    if (item.type === 'nudge' && item.meta?.type === 'eod') {
      onNavigate?.('chat');
      return;
    }
    if (item.type === 'todo' || item.type === 'email' || item.type === 'escalation' || item.type === 'jira_ticket') {
      onNavigate?.('chat');
      return;
    }
  }

  function onItemKeyDown(event, item) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleItemClick(item);
    }
  }

  const { loading, error, data } = state;

  return (
    <section>
      <div className="focus__head">
        <div>
          <h1 className="view__title">Focus</h1>
          <p className="view__lede">What matters right now.</p>
        </div>
        <button className="focus__refresh" type="button" onClick={load} aria-label="Refresh" title="Refresh">↻</button>
      </div>

      {loading && <div className="card">Asking the brain…</div>}

      {error && (
        <div className="card err">
          Couldn’t reach the brain: {error}
          <div className="focus__hint">Check you’re on Tailscale and the PIN is right, or that the NEURO backend is up.</div>
        </div>
      )}

      {data && (
        <>
          {data.sara?.briefing && <div className="focus__briefing card">{data.sara.briefing}</div>}

          {data.nextAction && (
            <button
              type="button"
              className={`focus__next card focus__u--${data.nextAction.urgency || 'medium'} focus__tap`}
              onClick={() => handleNextAction(data.nextAction)}
            >
              <div className="focus__next-label">Next</div>
              <div className="focus__next-title">{data.nextAction.label}</div>
              {data.nextAction.reason && <div className="focus__next-reason">{data.nextAction.reason}</div>}
            </button>
          )}

          {(!data.items || data.items.length === 0) && (
            <div className="card focus__clear">Nothing pressing. You’re clear. 🎉</div>
          )}

          {(data.items || [])
            .slice()
            .sort((a, b) => URGENCY.indexOf(a.urgency) - URGENCY.indexOf(b.urgency) || (b.score || 0) - (a.score || 0))
            .map((item) => (
              <div
                className={`card focus__item focus__u--${item.urgency || 'low'} focus__tap`}
                key={item.id}
                role="button"
                tabIndex={0}
                onClick={() => handleItemClick(item)}
                onKeyDown={(event) => onItemKeyDown(event, item)}
              >
                <div className="focus__item-main">
                  <div className="focus__item-title">{item.title}</div>
                  {item.reason && <div className="focus__item-reason">{item.reason}</div>}
                  <div className="focus__item-meta">
                    <span className={`focus__badge focus__badge--${item.urgency || 'low'}`}>{item.urgency || 'low'}</span>
                    <span className="focus__type">{item.type}</span>
                    {typeof item.score === 'number' && <span className="focus__score">{Math.round(item.score)}</span>}
                  </div>
                </div>
                <button
                  className="focus__dismiss"
                  type="button"
                  onClick={(event) => { event.stopPropagation(); dismiss(item); }}
                  disabled={dismissing[item.id]}
                  aria-label="Dismiss"
                  title="Dismiss"
                >✕</button>
              </div>
            ))}
        </>
      )}
    </section>
  );
}
