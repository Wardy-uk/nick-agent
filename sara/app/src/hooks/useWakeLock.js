import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'sara.wakeLock';

function readStoredPreference() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'on';
  } catch {
    return false;
  }
}

/**
 * Hold the screen awake while SARA is open (Screen Wake Lock API).
 *
 * iOS Safari 16.4+ supports this in an installed PWA, with two constraints that
 * shape the code below:
 *   1. Safari only grants the lock from a user gesture — an unprompted request
 *      on mount rejects with NotAllowedError. So we arm on the next tap instead
 *      of giving up.
 *   2. The lock is released automatically whenever the document stops being
 *      visible (backgrounded, screen off). It does NOT come back on its own,
 *      so we re-acquire on visibilitychange.
 *
 * Off by default and remembered in localStorage — an always-on screen is a real
 * battery cost, so it stays Nick's call rather than a silent default.
 */
export function useWakeLock(active) {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator;
  const [enabled, setEnabled] = useState(readStoredPreference);
  const [held, setHeld] = useState(false);
  const sentinelRef = useRef(null);
  const needsGestureRef = useRef(false);

  const release = useCallback(async () => {
    const sentinel = sentinelRef.current;
    sentinelRef.current = null;
    setHeld(false);
    if (sentinel) {
      try { await sentinel.release(); } catch { /* already gone */ }
    }
  }, []);

  const acquire = useCallback(async () => {
    if (!supported || sentinelRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

    try {
      const sentinel = await navigator.wakeLock.request('screen');
      sentinelRef.current = sentinel;
      needsGestureRef.current = false;
      setHeld(true);
      // Fires on OS-initiated release too, not just our own .release() call.
      sentinel.addEventListener('release', () => {
        if (sentinelRef.current === sentinel) sentinelRef.current = null;
        setHeld(false);
      });
    } catch (err) {
      sentinelRef.current = null;
      setHeld(false);
      // Safari wants a gesture — remember, and let the tap listener retry.
      if (err?.name === 'NotAllowedError') needsGestureRef.current = true;
    }
  }, [supported]);

  // Acquire / release as the toggle and app state change.
  useEffect(() => {
    if (!supported) return undefined;
    if (enabled && active) acquire();
    else release();
    return undefined;
  }, [supported, enabled, active, acquire, release]);

  // Re-acquire after the document comes back — iOS drops the lock every time.
  useEffect(() => {
    if (!supported || !enabled || !active) return undefined;

    function onVisibility() {
      if (document.visibilityState === 'visible') acquire();
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [supported, enabled, active, acquire]);

  // Safari's gesture requirement: retry on the next real interaction.
  useEffect(() => {
    if (!supported || !enabled || !active) return undefined;

    function onGesture() {
      if (needsGestureRef.current && !sentinelRef.current) acquire();
    }
    window.addEventListener('pointerdown', onGesture);
    return () => window.removeEventListener('pointerdown', onGesture);
  }, [supported, enabled, active, acquire]);

  // Drop the lock on unmount so it never outlives the app.
  useEffect(() => () => { release(); }, [release]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try { window.localStorage.setItem(STORAGE_KEY, next ? 'on' : 'off'); } catch { /* private mode */ }
      return next;
    });
  }, []);

  return { supported, enabled, held, toggle };
}
