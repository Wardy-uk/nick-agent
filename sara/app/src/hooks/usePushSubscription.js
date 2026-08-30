import { useEffect } from 'react';
import { apiFetch } from '../api';

/**
 * Web push registration, split into the half that may run on its own and the
 * half that may not.
 *
 * ⚠ THE PROMPT IS NEVER RAISED ON LAUNCH. This hook used to call
 * `Notification.requestPermission()` the moment the PIN was accepted, which puts
 * the browser's one-shot permission dialog in front of someone who opened the
 * app to write down a thought. A denial is close to permanent — iOS gives no
 * obvious way back — so the single most expensive thing this app can do is ask
 * at the wrong moment. Permission is now requested ONLY from
 * `enableNotifications()`, which the SARA Controls screen calls when Nick turns
 * notifications on deliberately.
 *
 * The automatic half still runs, because it costs nothing and cannot prompt:
 * a device that has ALREADY granted permission and holds a subscription
 * re-registers it, so a brain that lost its copy of the subscription starts
 * working again without Nick having to do anything.
 */

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function pushSupported() {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof window !== 'undefined'
    && 'PushManager' in window
    && typeof Notification !== 'undefined';
}

/** granted | denied | default | unsupported — what the browser will do if asked. */
export function permissionState() {
  if (!pushSupported()) return 'unsupported';
  return Notification.permission;
}

/**
 * Turn notifications on. THIS is the only place the prompt is raised, and it is
 * only ever reached from an explicit tap.
 *
 * Returns `{ok, state, error}` rather than throwing: the caller is a toggle, and
 * a toggle that flips back with no explanation is indistinguishable from a bug.
 */
export async function enableNotifications() {
  if (!pushSupported()) return { ok: false, state: 'unsupported', error: 'This browser cannot do web push.' };
  try {
    const { publicKey } = await apiFetch('/api/push/vapid-public-key');
    if (!publicKey) return { ok: false, state: permissionState(), error: 'NEURO has no VAPID key configured.' };

    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return {
        ok: false,
        state: permission,
        // Naming the consequence, because the browser will not ask again.
        error: permission === 'denied'
          ? 'Notifications are blocked for this app. That has to be changed in iOS Settings — the browser will not ask again.'
          : 'Notifications were not enabled.',
      };
    }

    const registration = await navigator.serviceWorker.ready;
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing || await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: _urlBase64ToUint8Array(publicKey),
    });

    await apiFetch('/api/push/subscribe', {
      method: 'POST',
      body: JSON.stringify(subscription.toJSON()),
    });
    return { ok: true, state: 'granted', error: null };
  } catch (e) {
    return { ok: false, state: permissionState(), error: e.message };
  }
}

/**
 * Keep an ALREADY-GRANTED subscription registered with the brain. Runs on auth.
 *
 * ⚠ Deliberately returns before anything that could prompt. `permission !==
 * 'granted'` is the guard, and it must stay the FIRST thing checked — calling
 * `getSubscription()` on a fresh install is harmless, but the moment this
 * function is allowed to fall through to `requestPermission()` the launch
 * prompt is back.
 */
export function usePushSubscription(authed) {
  useEffect(() => {
    if (!authed || !pushSupported()) return;
    if (Notification.permission !== 'granted') return;

    let cancelled = false;

    (async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (!existing || cancelled) return;
        await apiFetch('/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify(existing.toJSON()),
        });
      } catch (e) {
        // Brain unreachable, or the subscription is gone. Neither is worth
        // interrupting anyone about; the Controls screen reports the real state.
        console.warn('[Push] Re-registration skipped:', e.message);
      }
    })();

    return () => { cancelled = true; };
  }, [authed]);
}
