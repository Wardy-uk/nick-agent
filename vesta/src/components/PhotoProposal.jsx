import { useState } from 'react';

/**
 * What the camera thought it saw, waiting to be agreed with.
 *
 * ⚠ THIS IS THE HALF THAT MAKES THE FEATURE SAFE. The server proposes and
 * writes nothing; this is where a person says yes. Every item starts TICKED
 * because the common case is a good list and untick-the-wrong-ones is less work
 * than tick-them-all — but nothing is added until Confirm, and Confirm adds only
 * what is still ticked.
 *
 * ⚠ An item the model could not place comes back with `section: null` and is
 * rendered as a REAL choice she has to make, not defaulted to the first shelf.
 * `catalogue.addItem` refuses a section it does not know, so a guess here would
 * fail at the moment she confirms; and quietly putting the ice cream in the
 * fridge because that section happened to be first is the kind of small wrong
 * fact that makes the whole list stop being trusted.
 */
export default function PhotoProposal({ proposed, sections, onConfirm, onCancel }) {
  const [rows, setRows] = useState(() =>
    proposed.map(p => ({ ...p, keep: true, section: p.section || '' }))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);

  const kept = rows.filter(r => r.keep);
  const unplaced = kept.filter(r => !r.section).length;

  function update(i, patch) {
    setRows(rs => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));
  }

  async function confirm() {
    if (busy || !kept.length || unplaced) return;
    setBusy(true);
    setError(null);
    try {
      // Reported per item rather than as one number: adding is a sequence of
      // real calls and some can fail on their own (already there, section gone).
      const result = await onConfirm(kept.map(r => ({ name: r.name, section: r.section })));
      setDone(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="proposal">
        <p className="proposal__done">
          Added {done.added} thing{done.added === 1 ? '' : 's'}.
          {done.skipped > 0 && <> {done.skipped} {done.skipped === 1 ? 'was' : 'were'} already in.</>}
        </p>
        {/* A failure is named, never folded into the count — "added 6" over a
            run where two did not land is the report lying about the shelf. */}
        {done.failed.length > 0 && (
          <ul className="proposal__failed">
            {done.failed.map(f => (
              <li key={f.name}>{f.name} — {f.why}</li>
            ))}
          </ul>
        )}
        <button className="btn" onClick={onCancel}>Done</button>
      </div>
    );
  }

  return (
    <div className="proposal">
      <p className="proposal__lead">
        Here&rsquo;s what I think I can see. Untick anything wrong &mdash;
        <strong> nothing goes on the list until you say so.</strong>
      </p>

      {proposed.length === 0 ? (
        // ⚠ Distinct wording from a failed read. The server already told these
        // two apart; throwing that away here would put it back.
        <p className="proposal__empty">
          I couldn&rsquo;t see any food in that one. Try another angle?
        </p>
      ) : (
        <ul className="proposal__rows">
          {rows.map((r, i) => (
            <li className={`prow ${r.keep ? '' : 'prow--out'}`} key={`${r.name}-${i}`}>
              <label className="prow__keep">
                <input
                  type="checkbox"
                  checked={r.keep}
                  onChange={e => update(i, { keep: e.target.checked })}
                />
                <span className="prow__name">{r.name}</span>
              </label>
              <select
                className="prow__section"
                value={r.section}
                disabled={!r.keep}
                onChange={e => update(i, { section: e.target.value })}
              >
                <option value="">Where?</option>
                {sections.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </li>
          ))}
        </ul>
      )}

      {unplaced > 0 && (
        <p className="proposal__note">
          {unplaced} {unplaced === 1 ? 'thing needs' : 'things need'} a shelf before I can add {unplaced === 1 ? 'it' : 'them'}.
        </p>
      )}
      {error && <p className="composer__error" role="alert">{error}</p>}

      <div className="proposal__actions">
        <button className="btn btn--quiet" onClick={onCancel} disabled={busy}>Cancel</button>
        {proposed.length > 0 && (
          <button className="btn btn--primary" onClick={confirm} disabled={busy || !kept.length || unplaced > 0}>
            {busy ? 'Adding…' : `Add ${kept.length}`}
          </button>
        )}
      </div>
    </div>
  );
}
