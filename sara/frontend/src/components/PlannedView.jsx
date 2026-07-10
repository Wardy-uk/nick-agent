import { getView } from '../state/views';

// PlannedView — calm placeholder for a declared-but-not-yet-built view.
//
// Any future product screen can land here until it is implemented without changing the
// shared-state model or the surrounding app shell.
export default function PlannedView({ viewId }) {
  const view = getView(viewId);
  return (
    <section className="planned" aria-label={`${view?.label || 'View'} — planned`}>
      <p className="planned__tag">Cognition Surface</p>
      <h2 className="planned__title">{view?.label || viewId}</h2>
      <p className="planned__blurb">{view?.blurb}</p>
      <p className="planned__note">
        This surface is reserved inside the same shared SARA environment. It will
        inherit the same cognition theme when its live view is wired in.
      </p>
    </section>
  );
}
