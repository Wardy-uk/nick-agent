/**
 * A block on the home screen, and the one place that knows the difference
 * between the ways a block can have nothing in it.
 *
 * ⚠ Three renderings, deliberately distinct, because conflating them is how
 * this surface starts lying:
 *
 *   • a GAP  — we could not read it. Says so, and names why.
 *   • EMPTY  — we read it, there is nothing there. Good news, usually.
 *   • absent — no permission to see it at all. Handled by the CALLER, which
 *              does not mount this component. An empty calendar and no right to
 *              see the calendar are not the same fact and must not share a box.
 *
 * "I couldn't read the kitchen" and "the fridge is empty" send her to different
 * shops.
 *
 * ⚠ EMPTY DOES NOT REPLACE THE CHILDREN — it is a line ABOVE them. The first
 * version rendered `empty ? <message> : children`, which hid every add form on
 * exactly the screens that had nothing in them yet: an empty task list hid its
 * own composer and an empty kitchen hid all three shelves and their inputs. So
 * the app was unusable from a standing start and became usable only once
 * something had been added by other means — which is the worst possible
 * direction for that bug to point.
 *
 * A GAP still replaces the children, and that difference is deliberate: "there
 * is nothing here" is a fact you can act on, while "I could not read this" means
 * the controls would be operating against a state nobody knows.
 */
export default function Section({ title, gap, empty, children, action }) {
  return (
    <section className="section">
      <header className="section__head">
        <h2 className="section__title">{title}</h2>
        {action}
      </header>

      {gap ? (
        <p className="section__gap" role="status">
          <span className="section__gap-lead">I couldn&rsquo;t read this.</span>{' '}
          {gap}
          <br />
          <span className="section__gap-note">
            Don&rsquo;t treat it as nothing &mdash; it means I couldn&rsquo;t look.
          </span>
        </p>
      ) : (
        <>
          {empty && <p className="section__empty">{empty}</p>}
          {children}
        </>
      )}
    </section>
  );
}
