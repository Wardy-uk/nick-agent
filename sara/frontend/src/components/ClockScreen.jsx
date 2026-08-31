import Field from '../../../shared-ui/Field';
import './ClockScreen.css';

// The middle state: Nick is at home, but not in this room.
//
// ⚠ NOT A LOCK, AND IT MUST NOT LOOK LIKE ONE. There is nothing to unlock and
// nothing to tap — the moment he walks back in, SARA returns on her own. A
// padlock or a "tap to continue" would teach him this screen needs dealing
// with, when the whole point is that it does not.
//
// It shows the time and nothing else. Anything more is content displayed to an
// empty room, which is what the state exists to avoid; a countdown or a status
// line would just be SARA talking to nobody.
//
// On burn-in: the panel has a real 0-31 backlight and an OLED has none, so it
// is an IPS LCD and does not burn in — at worst temporary image persistence.
// The clock can sit still. (The `locked` state blanks the backlight outright,
// which is the display agent's job, not this component's.)
export default function ClockScreen({ now, say }) {
  const d = now instanceof Date ? now : new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const date = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="clockscreen" aria-label="SARA is idle — you are not in this room">
      {/* ⚠ Presence, not content. The rule above — "it shows the time and
          nothing else" — is about CONTENT displayed to an empty room, and the
          field is neither content nor something to deal with: it is what SARA
          looks like, and Nick walking back in sees her before the verdict
          flips. Driven `quiet`, so it is dim and near-still and stops dead when
          the page is hidden. */}
      <Field quiet confidenceLevel="low" />
      <div className="clockscreen__time">{time}</div>
      <div className="clockscreen__date">{date}</div>
      {/* Where he is, in NEURO's words, not ours — and only when it knows.
          Silence beats a guessed room on a screen nobody is standing at. */}
      {say ? <div className="clockscreen__say">{say}</div> : null}
    </div>
  );
}
