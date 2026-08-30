import './Freshness.css';
import { stampFor } from '../mobile/useNickNow';

// The provenance line every local-first screen carries.
//
// It is SILENT when the data is live — a permanent badge saying "everything is
// fine" is one nobody reads by week two, and then it cannot tell them anything
// when it stops being true (the ConnectionStatus rule).
//
// Four states, and they are four different facts:
//   live    — nothing shown.
//   cached  — a real snapshot, from a stated time. Stale, and says so.
//   none    — no snapshot on this device. NOT "nothing is urgent".
//   loading — first paint, nothing asserted yet.
export default function Freshness({ freshness, fetchedAt, error, onRetry, busy }) {
  if (freshness === 'live') return null;
  if (freshness === 'loading') {
    return <div className="fresh fresh--quiet">Asking NEURO…</div>;
  }

  if (freshness === 'none') {
    return (
      <div className="fresh fresh--none">
        <strong>Nothing cached on this device.</strong>
        <span>
          {' '}I couldn&rsquo;t reach NEURO and there&rsquo;s no earlier copy here — so this is
          &ldquo;I can&rsquo;t see your day&rdquo;, not &ldquo;your day is clear&rdquo;.
        </span>
        {error && <span className="fresh__why"> {error}</span>}
        {onRetry && (
          <button type="button" className="fresh__retry" onClick={onRetry} disabled={busy}>
            {busy ? 'Trying…' : 'Try again'}
          </button>
        )}
      </div>
    );
  }

  const stamp = stampFor(fetchedAt);
  return (
    <div className="fresh fresh--cached">
      <strong>Offline — showing what I last saw{stamp ? ` at ${stamp}` : ''}.</strong>
      <span> Things may have moved since.</span>
      {onRetry && (
        <button type="button" className="fresh__retry" onClick={onRetry} disabled={busy}>
          {busy ? 'Trying…' : 'Refresh'}
        </button>
      )}
    </div>
  );
}
