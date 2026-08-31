import { useEffect, useRef, useState } from 'react';

// What this screen should be showing, as decided by NEURO — `full`, `clock` or
// `locked`, for THIS room.
//
// Replaces the kiosk deciding for itself (`usePresenceLock`), which had two
// faults that only showed up on the wall:
//
// ⚠ 1. UNLOCK WAS MANUAL. It locked correctly when Nick went out and then sat
//    there waiting for a tap — so he came home to a locked screen and had to
//    touch a display whose entire point is that he does not have to. A lock that
//    cannot let itself go is a lock that has to be undone by hand every time.
//
// ⚠ 2. IT LOCKED ON IDLE. A glance display is looked at, not touched, so an idle
//    timer measures the wrong thing entirely. Nick never asked for it: his rule
//    is watch here → SARA, watch elsewhere → clock, out of the house → off.
//
// The verdict is composed server-side so the kiosk, the phone and the widget
// cannot each invent their own idea of what a missing watch means — the same
// rule the attention payload already follows with its pre-composed `speech`.
//
// ⚠ FAILS TOWARDS `full`. Every error path — unreachable backend, bad JSON, an
// unrecognised state — leaves the screen showing SARA. A bug that fails to
// `locked` is indistinguishable from a dead Pi and leaves Nick tapping at a
// screen that looks broken; a bug that fails open is merely a screen that
// stayed on. The backlight agent makes the same choice for the same reason.

const ROOM = import.meta.env.VITE_SARA_ROOM || 'living-room';
const POLL_MS = 4000;

export function useDisplayState() {
  const [state, setState] = useState('full');
  const [detail, setDetail] = useState(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;

    async function tick() {
      try {
        const res = await fetch(`/api/presence/display?room=${encodeURIComponent(ROOM)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = await res.json();
        if (!alive.current) return;
        if (d.state === 'full' || d.state === 'clock' || d.state === 'locked') {
          setState(d.state);
          setDetail(d);
        } else {
          // A state we do not recognise is a version skew, not a reason to hide.
          setState('full');
          setDetail(null);
        }
      } catch {
        if (!alive.current) return;
        setState('full');
        setDetail(null);
      }
    }

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { alive.current = false; clearInterval(id); };
  }, []);

  return { state, detail, room: ROOM };
}
