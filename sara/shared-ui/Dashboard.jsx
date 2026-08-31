import './Dashboard.css';

// The dashboard — what SARA is showing, beneath what she said.
//
// ⚠ ONE renderer for every kind. `dashboard.kind` is carried for styling and
// for anything that wants to know, but nothing here switches on it: a renderer
// that knows the kinds is a renderer that has to be edited every time a
// dashboard is added, which is how the two apps drifted in the first place. The
// SHAPE is uniform — label, rows, an optional figure, a note, gaps — and the
// server decides what goes in it (`backend/services/sara-surface.js`).
//
// It fetches nothing, ranks nothing and phrases nothing. Every string here
// arrived composed.
//
// ── The rules it holds ──────────────────────────────────────────────────────
//
//   * AN EMPTY DASHBOARD IS NEVER SILENT. If there are no rows there is a note
//     saying why — "you're in something", "I couldn't read your diary",
//     "don't read this as an all-clear". A blank panel and a broken one look
//     identical, and only one of them is good news.
//   * GAPS ARE NAMED, NEVER COUNTED. "I couldn't read 2" tells Nick a number
//     instead of a fact, in the most prominent position on the screen.
//   * AN ASSUMED FIGURE SAYS SO. `ofLabel` carries "30 assumed" rather than
//     "30 planned" when nobody ever said how long — laundering the one into the
//     other is exactly what the estimate rules forbid.

function Row({ row }) {
  return (
    <li className={`dash__row${row.level ? ` dash__row--${row.level}` : ''}`}>
      {row.when && <span className="dash__when">{row.when}</span>}
      <span className="dash__what">{row.what}</span>
      {row.meta && <span className="dash__meta">{row.meta}</span>}
      {/* The evidence line. Meeting prep's rule, generalised: a row whose
          source is unknown must not look identical to a sourced one. */}
      {row.note && <span className="dash__note">{row.note}</span>}
    </li>
  );
}

function Figure({ figure }) {
  return (
    <div className="dash__figure">
      <div className="dash__fignum">
        <b>{figure.value}</b>
        <span>{figure.unit}{figure.ofLabel ? ` · ${figure.ofLabel}` : ''}</span>
      </div>
      {figure.pct !== null && figure.pct !== undefined && (
        // Clamped server-side, because an overrun is normal and a bar past its
        // end reads as broken. The fact rides on `overrun` instead.
        <div className={`dash__meter${figure.overrun ? ' dash__meter--over' : ''}`}>
          <i style={{ width: `${figure.pct}%` }} />
        </div>
      )}
    </div>
  );
}

export default function Dashboard({ dashboard }) {
  if (!dashboard) return null;
  const { kind, label, rows = [], figure = null, note = null, gaps = [] } = dashboard;
  const bare = rows.length === 0 && !figure;

  return (
    <section className={`dash dash--${kind}${bare ? ' dash--bare' : ''}`} aria-label={label}>
      {label && <div className="dash__label">{label}</div>}

      {figure && <Figure figure={figure} />}

      {rows.length > 0 && (
        <ul className="dash__rows">
          {rows.map((r, i) => <Row key={`${r.what}-${i}`} row={r} />)}
        </ul>
      )}

      {/* An empty dashboard is never silent — see the header. */}
      {note && <p className="dash__note dash__note--wide">{note}</p>}

      {/* Named, not counted. */}
      {gaps.length > 0 && (
        <p className="dash__gaps">
          Couldn&rsquo;t read {gaps.map((g) => g.input).join(', ')}.
        </p>
      )}
    </section>
  );
}
