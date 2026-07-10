import { useSaraState } from '../../state/saraState';
import './FocusView.css';

// Focus v0 — one thing, timeboxed (WS post-WS2A).
//
// The narrowest SARA view: the single current do-next and nothing competing with it.
// A pure representation of `useSaraState()` — it owns NO data. The do-next, its
// reason, timebox and defer history come from the WS1 engine's focus domain; the
// "then" peek comes from the shared placeholder presentation; the clock is the shared
// clock. The screen formats and orders only (charter principle 7).
//
// Honesty: there is no running countdown here. A live timer would need a start-time in
// shared state, which the WS1 contract does not provide, so the timebox is shown as the
// target it is — not a fabricated screen-owned clock. No telemetry, no WS3 dependency.

export default function FocusView() {
  const {
    status,
    error,
    model,
    presentation,
    runQuickAction,
    focusAssist,
    actionFeedback,
    interruptionNotice,
    dismissInterruptionNotice,
  } = useSaraState();

  if (status === 'connecting') {
    return (
      <section className="product focus-product focus-product--message">
        <p className="product__summary">Waking SARA…</p>
      </section>
    );
  }
  if (status === 'disconnected' || !model) {
    return (
      <section className="product focus-product focus-product--message">
        <p className="product__summary focus-product__error">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p>
      </section>
    );
  }

  const focus = model.domains?.focus;
  const goal = focus?.current;
  const nextAction = focusAssist?.nextAction;
  const secondaryAction = focusAssist?.secondaryAction;
  const canWait = focusAssist?.canWait || [];
  // The escalation ladder is indexed by how many times this has been deferred.
  const nudge = goal?.deferCount > 0 ? focus?.deferEscalation?.[Math.min(goal.deferCount - 1, (focus.deferEscalation.length || 1) - 1)] : null;
  const then = presentation.upNext?.[0];

  if (!goal) {
    return (
      <section className="product focus-product focus-product--message" aria-label="Focus">
        <p className="product__summary">Nothing set — pick the highest-leverage thing and start.</p>
      </section>
    );
  }

  return (
    <section className="product focus-product" aria-label="Focus">
      <header className="product__hero focus-product__hero">
        <p className="product__eyebrow">Focus</p>
        <h2 className="product__title">{goal.title}</h2>
        {goal.reason && <p className="product__summary">{goal.reason}</p>}
        <div className="product__meta">
          {typeof goal.timeboxMins === 'number' && (
            <span className="product__pill">{goal.timeboxMins} min timebox</span>
          )}
          {goal.deferCount > 0 && (
            <span className="product__pill focus-product__pill--warning">Deferred x{goal.deferCount}</span>
          )}
          <span className="product__pill">One thing only</span>
        </div>
      </header>

      {interruptionNotice?.viewId === 'focus' && (
        <section className="product__banner focus-product__interrupt" aria-live="assertive">
          <div>
            <p className="product__section-title">SARA brought this forward</p>
            <p className="focus-product__interrupt-title">{interruptionNotice.title}</p>
            <p className="product__summary">{interruptionNotice.detail}</p>
          </div>
          <button type="button" className="product__button focus-product__interrupt-dismiss" onClick={dismissInterruptionNotice}>
            Dismiss
          </button>
        </section>
      )}

      <div className="product__grid">
        <section className="product__section product__section--span-7">
          <p className="product__section-title">Commit now</p>
          <div className="focus-product__actions" aria-label="Focus actions">
            <button
              type="button"
              className="product__button focus-product__button focus-product__button--primary"
              data-action="start-focus"
              onClick={() => runQuickAction('start-focus', { action: nextAction })}
            >
              {nextAction?.label || 'Start'}
            </button>
            <button
              type="button"
              className="product__button focus-product__button"
              data-action="defer"
              onClick={() => runQuickAction('defer-focus', { itemId: goal.id, itemType: goal.itemType })}
            >
              Defer
            </button>
            <button
              type="button"
              className="product__button focus-product__button"
              data-action="done"
              onClick={() => runQuickAction('done-focus', { itemId: goal.id, itemType: goal.itemType, detail: goal.title })}
            >
              Done
            </button>
          </div>
          {nextAction && (
            <div className="focus-product__action-brief">
              <p className="product__section-title">Do this now</p>
              <p className="focus-product__action-title">{nextAction.label}</p>
              <p className="product__summary">{nextAction.reason || goal.reason}</p>
              <div className="product__meta">
                {nextAction.target && <span className="product__pill">{nextAction.target}</span>}
                {nextAction.urgency && <span className="product__pill">{nextAction.urgency}</span>}
              </div>
            </div>
          )}
          {actionFeedback && <p className="focus-product__feedback">{actionFeedback}</p>}
        </section>

        <section className="product__section product__section--span-5">
          <p className="product__section-title">What happens next</p>
          {secondaryAction ? (
            <div className="focus-product__next">
              <p className="focus-product__next-time">Then</p>
              <p className="focus-product__next-label">{secondaryAction.label}</p>
              <p className="product__summary">{secondaryAction.reason}</p>
            </div>
          ) : then ? (
            <div className="focus-product__next">
              <p className="focus-product__next-time">{then.time}</p>
              <p className="focus-product__next-label">{then.label}</p>
            </div>
          ) : (
            <p className="product__summary">No follow-on item is lined up yet. Clear this one and SARA will refresh the runway.</p>
          )}
        </section>

        {canWait.length > 0 && (
          <section className="product__section product__section--span-12">
            <p className="product__section-title">Tracked, but can wait</p>
            <ul className="product__list">
              {canWait.slice(0, 3).map((item) => (
                <li key={`${item.focusItemId || item.label}-${item.target || 'wait'}`} className="product__card">
                  <p className="product__card-title">{item.label}</p>
                  <p className="product__card-detail">{item.reason}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {nudge && (
          <section className="product__banner product__section--span-12">
            <p className="product__section-title">Escalation</p>
            <p className="focus-product__nudge">{nudge}</p>
          </section>
        )}
      </div>
    </section>
  );
}
