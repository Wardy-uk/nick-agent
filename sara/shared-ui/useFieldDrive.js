import { useEffect, useState } from 'react';

// What the SHELL's background field is driven by.
//
// ⚠ WHY THIS EXISTS. Until now the Field only received the live payload on the
// Surface. On the other twelve screens it was hardcoded to `quiet` + `low`, so
// she looked identical whether the queue was on fire or the day was empty — and
// when the slow pulse arrived it could not fire there either, which meant a
// critical item never reached him unless he happened to be looking at her own
// screen. That is the opposite of an ambient surface.
//
// ⚠ It reads ONLY what the field needs, and decides nothing. `activity`,
// `confidence` and `quiet` are the brain's; `pressing` uses the same
// critical-or-high rule `AttentionSurface` applies, imported rather than
// re-stated so the two cannot disagree about what pressing means.
//
// ── Why a second poll is acceptable here ────────────────────────────────────
// The Surface polls the same endpoint every 60s for the FULL payload, with its
// own error handling and its own "keep the last good read on screen" rule; this
// wants four booleans and must never interfere with that. Sharing one fetch
// would mean lifting the Surface's whole state into the shell, which couples
// the ambient background to the screen that happens to be mounted. So it polls
// separately and SLOWLY — the background does not need to be a minute fresh —
// and it is skipped entirely while the Surface is mounted, because that screen
// already has a live read and mounts its own field from it.
const SHELL_POLL_MS = 150_000;

/** The one definition of "pressing", shared with AttentionSurface. */
export function isPressing(primary) {
  return Boolean(
    primary && primary.kind === 'item'
    && (primary.urgency === 'critical' || primary.urgency === 'high')
  );
}

/**
 * @param {function} fetchAttention  returns the parsed /api/attention payload.
 *   Injected, because the phone reaches NEURO directly with a PIN and the kiosk
 *   goes through sara/backend's passthrough — the transport is the one thing
 *   these two genuinely do not share.
 * @param {boolean} active  false while the Surface is mounted (it drives its own).
 */
export function useFieldDrive(fetchAttention, active = true) {
  // ⚠ Starts DEGRADED, not calm. Before the first read she genuinely cannot see
  // anything, and opening as a settled field would be a confident picture of a
  // day nobody has read yet.
  const [drive, setDrive] = useState({
    activity: undefined,
    confidenceLevel: 'low',
    quiet: false,
    degraded: true,
    pressing: false,
  });

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;

    const read = async () => {
      try {
        const d = await fetchAttention();
        if (!alive || !d) return;
        setDrive({
          activity: d.context?.activity,
          confidenceLevel: d.context?.confidence?.level || 'low',
          quiet: d.quiet === true,
          // `available:false` is how sara/backend's passthrough reports a
          // failure with a 200, so both shapes have to count as blind.
          degraded: d.poolAvailable === false || d.available === false,
          pressing: isPressing(d.primary),
        });
      } catch {
        // ⚠ An unreadable feed makes her look UNRESOLVED rather than leaving
        // the last good picture up. A field that goes on settling confidently
        // over a dead brain is the screensaver failure with worse consequences.
        if (alive) setDrive((p) => ({ ...p, degraded: true, pressing: false }));
      }
    };

    read();
    const t = setInterval(read, SHELL_POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [fetchAttention, active]);

  return drive;
}
