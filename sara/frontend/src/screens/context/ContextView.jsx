import { useSaraState } from '../../state/saraState';

export default function ContextView() {
  const { status, error, model, presentation } = useSaraState();

  if (status === 'connecting') return <section className="product"><p className="product__summary">Waking SARA…</p></section>;
  if (status === 'disconnected' || !model) {
    return <section className="product"><p className="product__summary">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p></section>;
  }

  const location = model.location;
  const queue = model.domains?.queue;
  const people = model.domains?.people;
  const focus = model.domains?.focus?.current;
  const matters = presentation?.whatMattersNow || [];
  const next = presentation?.upNext || [];
  const notes = model.domains?.vault?.picks || [];

  return (
    <section className="product" aria-label="Context">
      <header className="product__hero">
        <p className="product__eyebrow">Context</p>
        <h2 className="product__title">What is shaping this right now</h2>
        <p className="product__summary">{model.briefing?.line || 'Live context is flowing through the shared state model.'}</p>
        <div className="product__meta">
          <span className="product__pill">{location?.label || 'Unknown location'}</span>
          <span className="product__pill">{model.confidence?.level || 'unknown confidence'}</span>
          <span className="product__pill">{model.dataSource || 'unknown source'}</span>
        </div>
      </header>

      <div className="product__grid">
        <section className="product__section product__section--span-6">
          <p className="product__section-title">Immediate pressure</p>
          <div className="product__rows">
            <div className="product__row">
              <div>
                <p className="product__row-title">Queue</p>
                <p className="product__row-detail">{queue?.summary || 'Queue summary unavailable.'}</p>
              </div>
              {/* ⚠ Not `?? 0`. An unread queue is null, and rendering it as "0 open"
                  turns "SARA could not look" into "there is nothing there". */}
              <span className="product__row-right">
                {queue?.open == null ? 'not readable' : `${queue.open} open`}
              </span>
            </div>
            <div className="product__row">
              <div>
                <p className="product__row-title">Focus</p>
                <p className="product__row-detail">{focus?.reason || 'No active focus set.'}</p>
              </div>
              <span className="product__row-right">{focus?.title || 'Unset'}</span>
            </div>
            <div className="product__row">
              <div>
                <p className="product__row-title">People</p>
                <p className="product__row-detail">{people?.summary || 'People context unavailable.'}</p>
              </div>
              <span className="product__row-right">{people?.meta?.needAttention ?? 0} watched</span>
            </div>
          </div>
        </section>

        <section className="product__section product__section--span-6">
          <p className="product__section-title">What matters now</p>
          <ul className="product__list">
            {matters.length ? matters.map((item) => (
              <li key={item.id} className="product__card">
                <p className="product__card-title">{item.title}</p>
                <p className="product__card-detail">{item.detail}</p>
              </li>
            )) : (
              <li className="product__card">
                <p className="product__card-title">Nothing surfaced yet</p>
                <p className="product__card-detail">SARA has not promoted a live context item right now.</p>
              </li>
            )}
          </ul>
        </section>

        <section className="product__section product__section--span-6">
          <p className="product__section-title">Up next</p>
          <ul className="product__list">
            {next.length ? next.map((item) => (
              <li key={item.id} className="product__card">
                <p className="product__card-title">{item.label}</p>
                <p className="product__card-detail">{item.time}</p>
              </li>
            )) : (
              <li className="product__card">
                <p className="product__card-title">No next step lined up</p>
                <p className="product__card-detail">SARA has not queued a follow-on item.</p>
              </li>
            )}
          </ul>
        </section>

        <section className="product__section product__section--span-6">
          <p className="product__section-title">Supporting notes</p>
          <ul className="product__list">
            {notes.length ? notes.map((note) => (
              <li key={note.path} className="product__card">
                <p className="product__card-title">{note.title}</p>
                <p className="product__card-detail">{note.reason}</p>
              </li>
            )) : (
              <li className="product__card">
                <p className="product__card-title">No notes surfaced</p>
                <p className="product__card-detail">The vault seam has nothing live for this screen yet.</p>
              </li>
            )}
          </ul>
        </section>
      </div>
    </section>
  );
}
