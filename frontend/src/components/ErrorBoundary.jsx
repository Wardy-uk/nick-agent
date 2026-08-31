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
 *
 * ── The ONE error that is safe to retry automatically ────────────────────────
 *
 * A failed dynamic import is the exception, because it is not a bug in the view
 * at all — it means this tab is running an index.html from before the last
 * deploy and is asking for a hashed chunk that no longer exists. The code is
 * fine; the page is just old. Reloading genuinely fixes it, and nothing else
 * will: "Try this screen again" re-runs the same import against the same dead
 * URL for ever.
 *
 * It became reachable the moment the panels were code-split — until then there
 * were no chunk fetches to fail. It is paired with a server-side fix: a missing
 * asset now 404s instead of being answered with index.html, which is what made
 * the message read "importing a module script failed" rather than naming a file.
 *
 * ⚠ The reload is ONE-SHOT, guarded in sessionStorage. If a chunk is genuinely
 * missing rather than merely stale, an unguarded reload is an infinite refresh
 * loop that locks Nick out of the whole app — far worse than the dead panel it
 * was trying to fix. After one attempt it stops and says so.
 */
const RELOAD_GUARD = 'neuro_chunk_reload';

export function isStaleChunkError(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
  return (
    // Chrome / Firefox
    text.includes('failed to fetch dynamically imported module')
    || text.includes('error loading dynamically imported module')
    // Safari and iOS — the wording Nick actually saw
    || text.includes('importing a module script failed')
    // The MIME complaint, when a shell was served in place of a chunk
    || (text.includes('module script') && text.includes('mime type'))
    || text.includes('chunkloaderror')
  );
}

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

    // A stale chunk is the one failure a reload actually fixes. Once only.
    if (isStaleChunkError(error)) {
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(RELOAD_GUARD) === '1'; } catch {}
      if (!alreadyTried) {
        try { sessionStorage.setItem(RELOAD_GUARD, '1'); } catch {}
        // `reload()` re-requests index.html, which is served no-cache, so the
        // fresh chunk hashes come with it.
        window.location.reload();
      }
    }
  }

  componentDidUpdate(prev) {
    // A new view is a new chance. Without this the boundary latches and every
    // other menu stays dead too, which is the failure it was built to end.
    if (prev.viewKey !== this.props.viewKey && this.state.error) {
      this.setState({ error: null });
    }
    // A view that opened cleanly proves the tab is on a current build, so the
    // one-shot reload is available again. Without this the guard latches for the
    // whole tab session and the NEXT deploy's stale chunk gets no auto-recovery.
    if (prev.viewKey !== this.props.viewKey && !this.state.error) {
      try { sessionStorage.removeItem(RELOAD_GUARD); } catch {}
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // A stale chunk that survived the one-shot reload. Retrying the import is
    // pointless here, so the button offered is the one that can still work.
    if (isStaleChunkError(error)) {
      return (
        <div className="eb">
          <h2 className="eb__title">This screen is from an older version</h2>
          <p className="eb__lead">
            NEURO was updated while this tab was open, so this screen’s code is no longer
            on the server. Reloading picks up the new version — the rest of NEURO still works.
          </p>
          <pre className="eb__detail">{String(error?.message || error)}</pre>
          <button
            className="eb__btn"
            onClick={() => {
              try { sessionStorage.removeItem(RELOAD_GUARD); } catch {}
              window.location.reload();
            }}
          >
            Reload NEURO
          </button>
        </div>
      );
    }

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
