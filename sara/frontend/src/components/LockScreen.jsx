import './LockScreen.css';

// LockScreen — privacy lock overlay for the Pi wall display (WS2-WP3).
//
// SARA runs on an always-on touchscreen with no login, so "lock" here is a PRIVACY
// screen, not authentication: it hides the dashboard when Nick is out of the house, so
// nothing exposes his queue, people notes or calendar. It covers everything (above the
// Exit button) so nothing leaks behind it.
//
// ⚠ THERE IS NOTHING TO TAP, AND IT MUST NOT PRETEND OTHERWISE. It used to say "tap to
// unlock" and mean it — unlock was manual — so Nick came home from an evening out to a
// locked screen that had to be touched before SARA came back. It now clears itself the
// moment NEURO says he is home, so an affordance inviting a tap would teach him this
// screen needs dealing with when it does not.
//
// In practice he rarely sees this at all: the display agent takes the backlight to 0 in
// the same state, so the panel is genuinely off. This is what is behind it when the light
// returns a moment before the verdict does, and the belt-and-braces if that agent dies.
// Keyed on the reasons NEURO actually sends. An unrecognised one falls back to
// the bare word rather than rendering a stale explanation for a new state.
const REASON_TEXT = {
  'not-home': 'Away from home',
};

function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function LockScreen({ reason, now }) {
  return (
    <div className="lock" aria-label="SARA locked — away from home">
      <div className="lock__panel">
        <span className="lock__mark">SARA</span>
        <span className="lock__orb" aria-hidden="true" />
        {now && <span className="lock__time">{formatTime(now)}</span>}
        <span className="lock__reason">{REASON_TEXT[reason] || 'Locked'}</span>
      </div>
    </div>
  );
}
