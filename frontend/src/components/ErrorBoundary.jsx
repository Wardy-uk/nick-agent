import { Component } from 'react';
import './ErrorBoundary.css';

/**
 * One panel throwing must not take the whole app with it.
 *
 * ⚠ This exists because of a real, week-long outage. `StateOfPlay` kept
 * rendering a "Support queue" card after the Jira queue was removed on 27 Aug
 * 2026, so `queue.staleDays` threw on `undefined` every time that view opened.
 * There was no error boundary anywhere in the app, so React unmounted the ENTIRE
 * root — and the reported symptom was not "State of play is broken", it was
 * "a number of menus fail to open", because once the root is gone every
 * subsequent click does nothing until the page is reloaded.
 *
 * Two things follow from that, and they are the whole design:
 *
 *  1. The blast radius is one view. Everything outside the boundary — the
 *     sidebar, the nav, chat — keeps working, so Nick can always get somewhere
 *     else without reloading.
 *
 *  2. It SAYS WHAT BROKE, on screen. A blank panel and a crashed panel look
 *     identical, and neither one tells you which. The message is the thing that
 *     turns "some menus don't work" into a bug report — a silent failure cost a
 *     week here precisely because nothing was ever written down where Nick
 *     could see it.
 *
 * Deliberately NOT a retry-forever wrapper: a component that throws on render
 * will throw again, and a boundary that silently remounts it produces a flicker
 * with no explanation. Retry is a button Nick presses.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // The console is the only place a stack survives; keep it whole.
    console.error('[ErrorBoundary] view crashed:', error, info?.componentStack);
  }

  componentDidUpdate(prev) {
    // A new view is a new chance. Without this the boundary latches and every
    // other menu stays dead too, which is the failure it was built to end.
    if (prev.viewKey !== this.props.viewKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="eb">
        <h2 className="eb__title">This screen hit an error</h2>
        <p className="eb__lead">
          The rest of NEURO is fine — the menu still works, so you can carry on elsewhere.
        </p>
        <pre className="eb__detail">{String(error?.message || error)}</pre>
        <button className="eb__btn" onClick={() => this.setState({ error: null })}>
          Try this screen again
        </button>
      </div>
    );
  }
}
