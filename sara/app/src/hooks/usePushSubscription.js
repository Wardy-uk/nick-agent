import { useEffect } from 'react';
import { apiFetch } from '../api';

/**
 * Register a web push subscription with the NEURO brain.
 * Fetches the VAPID public key at runtime (no env var needed).
 * Runs once after the user is authenticated.
 */
export function usePushSubscription(authed) {
  useEffect(() => {
    if (!authed) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    let cancelled = false;

    async function subscribe() {
      try {
        // Fetch VAPID public key from brain
        const { publicKey } = await apiFetch('/api/push/vapid-public-key');
        if (!publicKey || cancelled) return;

        const registration = await navigator.serviceWorker.ready;

        // Check if already subscribed
        const existing = await registration.pushManager.getSubscription();
        if (existing) {
          // Re-register in case the brain lost it
          await apiFetch('/api/push/subscribe', {
            method: 'POST',
            body: JSON.stringify(existing.toJSON()),
          });
          return;
        }

        // Request notification permission
        const permission = await Notification.requestPermission();
        if (permission !== 'granted' || cancelled) return;

        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: _urlBase64ToUint8Array(publicKey),
        });

        await apiFetch('/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify(subscription.toJSON()),
        });

        console.log('[Push] Subscribed successfully');
      } catch (e) {
        // VAPID not configured, permission denied, or brain unreachable — all fine
        console.warn('[Push] Subscription skipped:', e.message);
      }
    }

    subscribe();
    return () => { cancelled = true; };
  }, [authed]);
}

function _urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
