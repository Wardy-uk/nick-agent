import { useSaraState } from '../../state/saraState';

export default function StandupView() {
  const { status, error, model, presentation } = useSaraState();

  if (status === 'connecting') {
    return <section className="product"><p className="product__summary">Waking SARA…</p></section>;
  }
  if (status === 'disconnected' || !model) {
    return <section className="product"><p className="product__summary">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p></section>;
  }

  const standup = presentation.standup;
  const hour = new Date().getHours();
  const afterCutoff = hour >= 12;
  const summary = afterCutoff
    ? 'Standup reminders are closed for today. Pick it up fresh tomorrow morning.'
    : (model.briefing?.line || 'Morning alignment is ready.');

  return (
    <section className="product" aria-label="Standup">
      <header className="product__hero">
        <p className="product__eyebrow">Standup</p>
        <h2 className="product__title">{afterCutoff ? 'Standup window closed' : 'Morning alignment'}</h2>
        <p className="product__summary">{summary}</p>
        <div className="product__meta">
          <span className="product__pill">{afterCutoff ? 'dismissed after 12pm' : standup.source}</span>
        </div>
      </header>

      <div className="product__grid">
        <section className="product__section product__section--span-4">
          <p className="product__section-title">Yesterday</p>
          <ul className="product__list">
            {standup.yesterday.map((item) => (
              <li key={item} className="product__card">
                <p className="product__card-title">{item}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="product__section product__section--span-4">
          <p className="product__section-title">Carrying forward</p>
          <ul className="product__list">
            {standup.carryForward.map((item) => (
              <li key={item} className="product__card">
                <p className="product__card-title">{item}</p>
              </li>
            ))}
          </ul>
        </section>
        <section className="product__section product__section--span-4">
          <p className="product__section-title">SARA prompts</p>
          <ul className="product__list">
            {standup.prompts.map((item) => (
              <li key={item} className="product__card">
                <p className="product__card-title">{item}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </section>
  );
}
