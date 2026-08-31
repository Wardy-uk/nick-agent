import Section from './Section.jsx';

/**
 * Where Nick is in the house.
 *
 * ⚠ IT KNOWS WHERE HIS WATCH IS, WHICH IS NOT QUITE THE SAME THING, and the
 * wording has to carry that. Proven on the day it was built: he showered while
 * the watch sat on a bedroom surface and the room read `bedroom` with full
 * confidence for eight minutes. So this never says "Nick is in the kitchen" as
 * a bare fact — it says where he was last picked up, which is what was actually
 * measured and is still perfectly useful for "is he upstairs or down".
 *
 * ⚠ Three renderings stay distinct, the `Section` rule applied to a person:
 *
 *   • a room        — he was picked up there
 *   • can't tell    — the sensors could not place him. NOT "he's out": he may
 *                     be in a room with no sensor, or the watch may be off.
 *   • not mounted   — no `presence` scope. The caller does not render this at
 *                     all, so no permission and no reading never share a box.
 *
 * "I don't know where he is" and "he's out" send her looking in different
 * places, and merging them is how this surface starts lying.
 *
 * The room name is all that arrives from the server — no signal strengths, no
 * history, no timestamps. There is deliberately nothing else here to render.
 */

// Rooms read better with the article the house uses for them. Anything not
// listed falls through unchanged rather than being mangled into a guess.
const IN_ROOM = {
  'living-room': 'the living room',
  kitchen: 'the kitchen',
  bedroom: 'the bedroom',
};

export default function Presence({ presence }) {
  // ⚠ THE SCOPE IS GRANTED AND THE SERVER SENT NOTHING. That is not "no
  // permission" — the caller already checked the scope before mounting this —
  // so it is a stale client talking to a server that does not send the block, or
  // a server that failed to build it. Rendering null was the first version and
  // it is exactly the failure this app is built to refuse: an empty screen that
  // looks identical to a working one with nothing to say. Caught in the wild
  // within the hour, hunting a section that was silently absent.
  if (!presence) {
    return (
      <Section title="Nick" gap="I asked where he is and got no answer. Try reloading.">
        {null}
      </Section>
    );
  }

  if (!presence.known) {
    return (
      <Section title="Nick">
        <p className="presence__unknown">
          I can&rsquo;t tell which room Nick is in.{' '}
          <span className="presence__note">That isn&rsquo;t the same as Nick being out.</span>
        </p>
      </Section>
    );
  }

  // ⚠ A ZONE IS NOT A ROOM, and the sentence has to change with it. "Last
  // picked up in At Work" is what you get from treating one phrasing as
  // universal — and the watch caveat is wrong there too, because a zone comes
  // from the phone, not the watch.
  if (presence.kind === 'zone') {
    return (
      <Section title="Nick">
        <p className="presence__room"><strong>{presence.label}</strong>.</p>
      </Section>
    );
  }

  const where = IN_ROOM[presence.room] || presence.label || presence.room;

  return (
    <Section title="Nick">
      <p className="presence__room">
        Last picked up in <strong>{where}</strong>.
      </p>
      {/* Said plainly and once. She should know what the house is actually
          measuring, so that a watch left on a windowsill is a thing she can
          work out rather than a mystery. */}
      <p className="presence__note">From Nick&rsquo;s watch, so it&rsquo;s where that is.</p>
    </Section>
  );
}
