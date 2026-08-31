import Section from './Section.jsx';

/**
 * What could be made out of what is actually in.
 *
 * ⚠ `known: false` means NOTHING IS RECORDED in the kitchen. That is a
 * completely different fact from "there is nothing to eat", and rendering them
 * alike would have her shopping for food that is already in the fridge — or
 * assuming the cupboard is bare because nobody has typed it up. The two get
 * different words here, and neither pretends to be the other.
 *
 * Suggestions are rules, not a model, so each one can name the ingredients it
 * FOUND — the reason it is being offered is on the card and can be disagreed
 * with. A model would invent a recipe needing four things that are not there,
 * convincingly.
 */
export default function Meals({ meals }) {
  if (!meals) return null;

  if (!meals.known) {
    return (
      <Section title="Something to eat">
        <p className="section__empty">
          {meals.why || 'Nothing recorded in the kitchen yet.'}
          <br />
          <span className="section__gap-note">
            That&rsquo;s not the same as an empty fridge &mdash; I just haven&rsquo;t been told what&rsquo;s in.
          </span>
        </p>
      </Section>
    );
  }

  if (!meals.meals || meals.meals.length === 0) {
    return (
      <Section title="Something to eat">
        {/* A stocked kitchen matching no rule is a gap in the RULES, and says so
            rather than implying there is nothing in. */}
        <p className="section__empty">
          {meals.why || "Nothing here matches what I know how to suggest yet."}
        </p>
      </Section>
    );
  }

  return (
    <Section title="Something to eat">
      <ul className="meals">
        {meals.meals.map(m => (
          <li className="meal" key={m.name}>
            <span className="meal__name">{m.name}</span>
            {m.using && m.using.length > 0 && (
              <span className="meal__using">using {m.using.join(', ')}</span>
            )}
          </li>
        ))}
      </ul>
    </Section>
  );
}
