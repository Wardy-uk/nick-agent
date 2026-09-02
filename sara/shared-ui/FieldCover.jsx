import { createContext } from 'react';

// Is something opaque covering this part of the screen?
//
// ⚠ A FIELD UNDER AN OVERLAY IS NOT A FIELD ANYONE CAN SEE, and it has no way of
// knowing that by itself. `document.visibilityState` is about the TAB, and on a
// kiosk it is never `hidden` — not when the lock overlay covers the app, not
// even when the backlight is at 0. So the shell went on animating underneath a
// privacy lock for as long as Nick was out of the house.
//
// ⚠ IT IS A CONTEXT AND NOT A GLOBAL FLAG, because the distinction that matters
// is WHICH SIDE of the overlay a field is on. LockScreen and ClockScreen each
// mount a field of their own and those are the visible ones — the clock's is
// lit and animating and must stay that way. Only the subtree the overlay is
// drawn OVER is covered, so the provider wraps exactly that and the overlays
// render outside it. A global would stop the wrong ones.
//
// Covering STOPS THE LOOP AND KEEPS THE PIXELS. The canvas holds its last frame
// and resumes where it left off, so uncovering is not a rebuild — regenerating
// the substrate would make the whole field flicker every time he walks back into
// the room, which is the one moment it is being looked at.
export const FieldCoverContext = createContext(false);

export function FieldCover({ covered = false, children }) {
  return (
    <FieldCoverContext.Provider value={covered}>{children}</FieldCoverContext.Provider>
  );
}

export default FieldCover;
