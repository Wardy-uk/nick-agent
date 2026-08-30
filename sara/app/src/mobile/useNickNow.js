import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../api.js';
import { readSnapshot, saveSnapshot } from './localStore.js';

// The Nick Now snapshot, local-first.
//
// The three states this hook must keep apart, because conflating any two of them
// is how a broken feed comes to look like a good day:
//
//   live    — fetched just now from NEURO.
//   cached  — a previous snapshot, with the time it was fetched. STALE, and the
//             UI must say so rather than presenting it as current.
//   none    — no cached snapshot exists. NOT the same as "nothing is urgent",
//             and the UI must not render an empty, calm screen over it.
//
// The cache is written ONLY on a successful fetch, so a failure can never
// overwrite good data with a worse copy of itself.

const PATH = '/api/mobile/v1/nick-now';

export function useNickNow({ auto = true, intervalMs = 120000 } = {}) {
  const [snapshot, setSnapshot] = useState(null);
  const [freshness, setFreshness] = useState('loading'); // loading | live | cached | none
  const [fetchedAt, setFetchedAt] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadCached = useCallback(async () => {
    try {
      const row = await readSnapshot();
      if (row && row.payload) {
        setSnapshot(row.payload);
        setFetchedAt(row.fetchedAt);
        return true;
      }
    } catch (e) {
      // Local storage itself failed. That is worth saying — it means offline
      // will not work at all — but it must not stop a live fetch.
      setError((prev) => prev || `Local storage unavailable: ${e.message}`);
    }
    return false;
  }, []);

  const refresh = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setBusy(true);
    try {
      const payload = await apiFetch(PATH);
      setSnapshot(payload);
      setFreshness('live');
      const at = new Date().toISOString();
      setFetchedAt(at);
      setError(null);
      // Cache only a good fetch.
      try { await saveSnapshot(payload); } catch { /* a cache miss is not a failure of the read */ }
      return { ok: true };
    } catch (e) {
      setError(e.message);
      const hadCache = await loadCached();
      setFreshness(hadCache ? 'cached' : 'none');
      return { ok: false, error: e.message };
    } finally {
      if (!quiet) setBusy(false);
    }
  }, [loadCached]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Show the cache FIRST so the screen is useful immediately, then go and
      // ask. Waiting for the network before rendering anything is what makes an
      // offline app feel broken rather than calm.
      const hadCache = await loadCached();
      if (cancelled) return;
      if (hadCache) setFreshness('cached');
      await refresh({ quiet: hadCache });
    })();
    return () => { cancelled = true; };
  }, [loadCached, refresh]);

  useEffect(() => {
    if (!auto) return undefined;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      refresh({ quiet: true });
    };
    const timer = setInterval(tick, intervalMs);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    const onOnline = () => tick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [auto, intervalMs, refresh]);

  return { snapshot, freshness, fetchedAt, error, busy, refresh };
}

/** "11:42", "yesterday 18:03" — a stamp a reader can judge staleness against. */
export function stampFor(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return hhmm;
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate())
    - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  if (days === 1) return `yesterday ${hhmm}`;
  return `${days} days ago, ${hhmm}`;
}
