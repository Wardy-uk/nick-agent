import { useEffect, useMemo, useState } from 'react';
import { apiFetch, apiUrl } from '../api';
import { completeTask } from '../completeTask';
import actionSurfaces from '../../../../shared/action-surfaces.cjs';
import './NotificationActionCard.css';

const { resolveNueroUrl, resolveSaraLitePlan } = actionSurfaces;

function trimItems(list, limit) {
  return Array.isArray(list) ? list.slice(0, limit) : [];
}

export default function NotificationActionCard({ intent, onDismiss, onNavigate }) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const [answers, setAnswers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [doneIds, setDoneIds] = useState({});
  const plan = useMemo(() => resolveSaraLitePlan(intent), [intent]);
  const kind = plan.kind;
  const nueroUrl = useMemo(() => resolveNueroUrl(intent, apiUrl('/')), [intent]);
  const handledInSara = plan.canHandle && plan.presentation !== 'handoff';

  useEffect(() => {
    let active = true;

    async function load() {
      setState({ loading: true, data: null, error: null });

      if (!handledInSara) {
        if (!active) return;
        setState({ loading: false, data: null, error: null });
        return;
      }

      try {
        let data = null;

        if (kind === 'standup') data = await apiFetch('/api/standup/questions');
        else if (kind === 'eod') data = await apiFetch('/api/standup/eod/questions');
        else if (kind === 'journal') data = await apiFetch('/api/journal/prompts');
        else if (kind === 'todo') data = await apiFetch('/api/todos/focus?filter=overdue&limit=5');
        else if (kind === 'meeting') {
          const eventId = intent?.payload?.eventId;
          data = eventId
            ? await apiFetch(`/api/meeting-prep/${encodeURIComponent(eventId)}`)
            : await apiFetch('/api/meeting-prep');
        } else if (kind === 'brain') data = await apiFetch('/api/vault-hygiene/lint');

        if (!active) return;

        if (kind === 'standup' || kind === 'eod') {
          setAnswers(new Array((data.questions || []).length).fill(''));
        }
        if (kind === 'journal') {
          setAnswers((data.prompts || []).map(() => ''));
        }

        setState({ loading: false, data, error: null });
      } catch (error) {
        if (!active) return;
        setState({ loading: false, data: null, error: error.message });
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [handledInSara, intent, kind]);

  function openNuero() {
    if (!nueroUrl) return;
    window.open(nueroUrl, '_blank', 'noopener,noreferrer');
  }

  async function submitGuided() {
    setSaving(true);
    try {
      if (kind === 'standup') {
        await apiFetch('/api/standup/submit-guided', {
          method: 'POST',
          body: JSON.stringify({ answers }),
        });
      } else if (kind === 'eod') {
        await apiFetch('/api/standup/eod/submit-guided', {
          method: 'POST',
          body: JSON.stringify({ answers }),
        });
      } else if (kind === 'journal') {
        const entries = (state.data?.prompts || []).map((prompt, index) => ({
          prompt,
          response: answers[index] || '',
        }));
        await apiFetch('/api/journal/save', {
          method: 'POST',
          body: JSON.stringify({ entries, date: state.data?.date }),
        });
      }
      setState((current) => ({
        ...current,
        data: { ...(current.data || {}), completed: true },
      }));
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
    } finally {
      setSaving(false);
    }
  }

  async function completeTodo(item) {
    if (!item) return;
    setDoneIds((current) => ({ ...current, [item.id]: true }));
    try {
      // Shared with the Tasks view — this used to have no task_id branch, so a
      // NEURO-owned task posted a null filePath to /toggle and never completed.
      await completeTask(item);
      setState((current) => ({
        ...current,
        data: {
          ...(current.data || {}),
          items: (current.data?.items || []).filter((entry) => entry.id !== item.id),
        },
      }));
    } catch (error) {
      setState((current) => ({ ...current, error: error.message }));
      setDoneIds((current) => ({ ...current, [item.id]: false }));
    }
  }

  const title = intent?.title || 'SARA nudge';
  const note = nueroUrl ? `${title} • ${nueroUrl}` : title;
  const canSubmit = answers.some((entry) => String(entry || '').trim());

  return (
    <section className="notif card">
      <div className="notif__top">
        <div>
          <div className="notif__eyebrow">Notification action</div>
          <div className="notif__title">{note}</div>
        </div>
        <button type="button" className="notif__close" onClick={onDismiss} aria-label="Dismiss notification panel">✕</button>
      </div>

      {state.loading && <div className="notif__status">Loading the next action…</div>}
      {state.error && <div className="notif__status err">{state.error}</div>}

      {!state.loading && !state.error && !handledInSara && (
        <div className="notif__body">
          <p className="notif__lede">This one needs the full NUERO desktop companion rather than SARA mobile.</p>
          <div className="notif__actions">
            {nueroUrl && (
              <button type="button" className="notif__btn notif__btn--primary" onClick={openNuero}>
                Open in NUERO
              </button>
            )}
            <button type="button" className="notif__btn" onClick={onDismiss}>Dismiss</button>
          </div>
        </div>
      )}

      {!state.loading && !state.error && handledInSara && kind === 'standup' && (
        <div className="notif__body">
          <p className="notif__lede">{state.data?.briefing || 'Morning standup ready.'}</p>
          {trimItems(state.data?.questions, 3).map((question, index) => (
            <label className="notif__field" key={question}>
              <span>{question}</span>
              <textarea
                value={answers[index] || ''}
                onChange={(event) => {
                  const next = answers.slice();
                  next[index] = event.target.value;
                  setAnswers(next);
                }}
                rows={3}
              />
            </label>
          ))}
          <div className="notif__actions">
            <button type="button" className="notif__btn notif__btn--primary" disabled={!canSubmit || saving} onClick={submitGuided}>
              {saving ? 'Saving…' : state.data?.completed ? 'Saved' : 'Write standup'}
            </button>
            <button type="button" className="notif__btn" onClick={() => onNavigate('focus')}>Focus tab</button>
          </div>
        </div>
      )}

      {!state.loading && !state.error && handledInSara && kind === 'eod' && (
        <div className="notif__body">
          <p className="notif__lede">{state.data?.briefing || 'End-of-day wrap-up ready.'}</p>
          {trimItems(state.data?.questions, 3).map((question, index) => (
            <label className="notif__field" key={question}>
              <span>{question}</span>
              <textarea
                value={answers[index] || ''}
                onChange={(event) => {
                  const next = answers.slice();
                  next[index] = event.target.value;
                  setAnswers(next);
                }}
                rows={3}
              />
            </label>
          ))}
          <div className="notif__actions">
            <button type="button" className="notif__btn notif__btn--primary" disabled={!canSubmit || saving} onClick={submitGuided}>
              {saving ? 'Saving…' : state.data?.completed ? 'Saved' : 'Write EOD'}
            </button>
            <button type="button" className="notif__btn" onClick={() => onNavigate('focus')}>Focus tab</button>
          </div>
        </div>
      )}

      {!state.loading && !state.error && handledInSara && kind === 'journal' && (
        <div className="notif__body">
          <p className="notif__lede">Tonight’s reflection is ready here.</p>
          {trimItems(state.data?.prompts, 3).map((prompt, index) => (
            <label className="notif__field" key={prompt}>
              <span>{prompt}</span>
              <textarea
                value={answers[index] || ''}
                onChange={(event) => {
                  const next = answers.slice();
                  next[index] = event.target.value;
                  setAnswers(next);
                }}
                rows={3}
              />
            </label>
          ))}
          <div className="notif__actions">
            <button type="button" className="notif__btn notif__btn--primary" disabled={!canSubmit || saving} onClick={submitGuided}>
              {saving ? 'Saving…' : state.data?.completed ? 'Saved' : 'Save journal'}
            </button>
            <button type="button" className="notif__btn" onClick={() => onNavigate('brain')}>Brain tab</button>
          </div>
        </div>
      )}

      {!state.loading && !state.error && handledInSara && kind === 'todo' && (
        <div className="notif__body">
          <p className="notif__lede">{state.data?.framing || 'Top overdue items ready to clear.'}</p>
          {trimItems(state.data?.items, 5).map((item) => (
            <div className="notif__list-item" key={item.id}>
              <div>
                <div className="notif__item-title">{item.text}</div>
                <div className="notif__item-meta">{item.source || 'Vault'}{item.due_date ? ` • due ${item.due_date.split('T')[0]}` : ''}</div>
              </div>
              <button
                type="button"
                className="notif__btn notif__btn--small"
                disabled={Boolean(doneIds[item.id])}
                onClick={() => completeTodo(item)}
              >
                {doneIds[item.id] ? 'Done…' : 'Done'}
              </button>
            </div>
          ))}
          {trimItems(state.data?.items, 5).length === 0 && <div className="notif__status">No overdue items left.</div>}
          <div className="notif__actions">
            <button type="button" className="notif__btn" onClick={() => onNavigate('focus')}>Focus tab</button>
            <button type="button" className="notif__btn" onClick={() => onNavigate('capture')}>Capture follow-up</button>
          </div>
        </div>
      )}

      {!state.loading && !state.error && handledInSara && kind === 'meeting' && (
        <div className="notif__body">
          {state.data?.meeting ? (
            <>
              <div className="notif__item-title">{state.data.meeting.subject}</div>
              <div className="notif__item-meta">
                {state.data.meeting.startFormatted}{state.data.meeting.endFormatted ? `–${state.data.meeting.endFormatted}` : ''}
                {typeof state.data.meeting.minutesAway === 'number' ? ` • in ${state.data.meeting.minutesAway}m` : ''}
              </div>
              {trimItems(state.data.meeting.prep?.suggestedTopics, 3).map((topic) => (
                <div className="notif__bullet" key={topic}>{topic}</div>
              ))}
              {trimItems(state.data.meeting.prep?.checklist, 2).map((item) => (
                <div className="notif__bullet" key={item}>{item}</div>
              ))}
            </>
          ) : (
            <div className="notif__status">No meeting prep found.</div>
          )}
          <div className="notif__actions">
            <button type="button" className="notif__btn notif__btn--primary" onClick={() => onNavigate('prep')}>Open Prep</button>
            <button type="button" className="notif__btn" onClick={() => onNavigate('capture')}>Capture note</button>
          </div>
        </div>
      )}

      {!state.loading && !state.error && handledInSara && kind === 'brain' && (
        <div className="notif__body">
          <p className="notif__lede">Vault hygiene is ready for a quick pass.</p>
          <div className="notif__grid">
            <div><strong>{state.data?.counts?.broken ?? 0}</strong><span>broken</span></div>
            <div><strong>{state.data?.counts?.orphans ?? 0}</strong><span>orphans</span></div>
            <div><strong>{state.data?.counts?.stale ?? 0}</strong><span>stale</span></div>
          </div>
          <div className="notif__actions">
            <button type="button" className="notif__btn notif__btn--primary" onClick={() => onNavigate('brain')}>Open Brain</button>
            <button type="button" className="notif__btn" onClick={() => onNavigate('capture')}>Capture note</button>
          </div>
        </div>
      )}

      {!state.loading && !state.error && !handledInSara && !nueroUrl && (
        <div className="notif__status">No linked NUERO destination was included with this notification.</div>
      )}
    </section>
  );
}
