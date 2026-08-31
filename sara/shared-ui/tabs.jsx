// The screen set — ONE list, rendered by the phone AND the Pi kiosk.
//
// ⚠ WHY IT MOVED HERE. Nick, 31 Aug 2026: "make the Pi version of SARA the same
// as the phone app — same for the desktop." Until now the kiosk had its own
// fourteen-screen registry (`sara/frontend/src/state/views.js`) over
// `sara/backend`'s state model, while the phone had these thirteen over NEURO.
// Two screen sets, two vocabularies, two ideas of what SARA is — the drift that
// `AttentionSurface` and `voiceUtils` each had to be un-drifted from, one level
// up. There is one list now and both shells mount it.
//
// The COMPONENTS are the phone's, deliberately: they are the ones written
// against NEURO's own contracts. The kiosk reaches those contracts through
// `sara/backend`'s allowlisted proxy (`routes/neuroProxy.js`) rather than by
// holding a credential in an always-on desk browser — sharing the screens never
// required sharing where the credential lives.
//
// ── The three primary modes ─────────────────────────────────────────────────
//   Capture — get it out of his head immediately, online or off
//   Now     — one current action and the next transition, sourced and stamped
//   Review  — morning orientation, shutdown, weekly reset
//
// ⚠ Everything else is SECONDARY, not deleted — including the SARA Surface,
// which is what notification routing lands on and is one tap away. "A thing he
// cannot find is worse than a menu he does not need" (25 Aug) is unchanged.
//
// ⚠ Every id here must also exist in `SARA_LITE_TABS` in
// `shared/action-surfaces.cjs`, or a notification routed to it falls back to
// Focus in silence. `action-surfaces.test.js` reads this file and fails if not.

import Capture from '../app/src/views/Capture';
import Now from '../app/src/views/Now';
import Review from '../app/src/views/Review';
import Surface from '../app/src/views/Surface';
import Today from '../app/src/views/Today';
import Focus from '../app/src/views/Focus';
import Tasks from '../app/src/views/Tasks';
import Chat from '../app/src/views/Chat';
import MeetingPrep from '../app/src/views/MeetingPrep';
import Standup from '../app/src/views/Standup';
import BrainManagement from '../app/src/views/BrainManagement';
import Controls from '../app/src/views/Controls';

export const PRIMARY = [
  { id: 'capture', label: 'Capture', icon: '➕', Component: Capture },
  { id: 'now', label: 'Now', icon: '◉', Component: Now },
  { id: 'review', label: 'Review', icon: '◐', Component: Review },
];

export const SECONDARY = [
  // The ambient SARA feed. Still the destination for notification routing, and
  // still what the KIOSK opens on — see DEFAULT_TAB below.
  { id: 'surface', label: 'SARA', icon: '✦', Component: Surface },
  { id: 'today', label: 'Today', icon: '☀', Component: Today },
  { id: 'focus', label: 'Focus', icon: '🎯', Component: Focus },
  { id: 'tasks', label: 'Tasks', icon: '✓', Component: Tasks },
  { id: 'voice', label: 'Voice', icon: '🎙️', Component: Capture }, // jumps straight into recording
  { id: 'chat', label: 'Chat', icon: '💬', Component: Chat },
  { id: 'prep', label: 'Prep', icon: '📅', Component: MeetingPrep },
  { id: 'standup', label: 'Ritual', icon: '📝', Component: Standup },
  { id: 'brain', label: 'Brain', icon: '🧠', Component: BrainManagement },
  { id: 'controls', label: 'Controls', icon: '⚙', Component: Controls },
];

export const TABS = [...PRIMARY, ...SECONDARY];
export const VALID_TABS = new Set(TABS.map((t) => t.id));

// Both shells open on SARA's Surface. The phone is the app Nick OPENS and lands
// there so she is present before he has chosen anything; the kiosk is never
// opened at all — it is simply on — so there is nowhere else it could sensibly
// start. A launch intent from a notification still wins on the phone. Capture
// leads the nav on both because it is the lowest-barrier thing either can do.
export const DEFAULT_TAB = 'surface';
