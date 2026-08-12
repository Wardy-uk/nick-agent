import { useState, useEffect, useCallback, useRef } from 'react';
import { apiUrl } from './api';
import { cachePut, cacheGet } from './cacheStore';

/**
 * Hook that fetches a GET endpoint with IndexedDB caching fallback.
 *
 * @param {string} path       — API path, e.g. "/api/todos"
 * @param {object} [opts]
 * @param {number|null} opts.interval  — polling interval in ms (null = no polling)
 * @param {function|null} opts.transform — optional (jsonBody) => value
 * @returns {{ data: *, status: "live"|"cached"|"unavailable", error: string|null, refresh: () => void, cacheAge: number|null }}
 */
export default function useCachedFetch(path, opts = {}) {
  const { interval = null, transform = null, maxAgeMs = 24 * 60 * 60 * 1000 } = opts;
  const [data, setData] = useState(null);
  const [status, setStatus] = useState('unavailable'); // live | cached | unavailable
  const [error, setError] = useState(null);
  const [cacheAge, setCacheAge] = useState(null); // ms since cache was written
  const mountedRef = useRef(true);
  const liveRef = useRef(false); // true once a live fetch has resolved
  // Callers pass transform inline, so it is a new function every render. Hold it
  // in a ref: if doFetch depended on it, doFetch's identity would change every
  // render, the effect below would re-run every render, and the endpoint would
  // be refetched in a loop with responses landing out of order.
  const transformRef = useRef(transform);
  transformRef.current = transform;
  // Only the newest request may write state — a slow earlier response must not
  // overwrite a fresher one (e.g. a post-mutation refresh).
  const reqRef = useRef(0);

  const doFetch = useCallback(async () => {
    const seq = ++reqRef.current;
    const isCurrent = () => mountedRef.current && seq === reqRef.current;
    const runTransform = (json) => (transformRef.current ? transformRef.current(json) : json);

    try {
      const res = await fetch(apiUrl(path));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      if (isCurrent()) {
        liveRef.current = true;
        setData(runTransform(json));
        setStatus('live');
        setError(null);
        setCacheAge(null);
      }

      // Write to cache in background
      cachePut(path, json);
    } catch (e) {
      // Fetch failed — try cache (only if we haven't already seeded)
      const cached = await cacheGet(path, maxAgeMs);
      if (isCurrent()) {
        if (cached) {
          setData(runTransform(cached.data));
          setStatus('cached');
          setCacheAge(Date.now() - cached.ts);
          setError(null);
        } else {
          setStatus('unavailable');
          setError(e.message);
        }
      }
    }
  }, [path, maxAgeMs]);

  // Seed from cache immediately, then fetch live data
  useEffect(() => {
    mountedRef.current = true;
    liveRef.current = false;

    // Load cached data first so UI renders instantly
    cacheGet(path, maxAgeMs).then(cached => {
      if (cached && mountedRef.current && !liveRef.current) {
        const value = transformRef.current ? transformRef.current(cached.data) : cached.data;
        setData(value);
        setStatus('cached');
        setCacheAge(Date.now() - cached.ts);
      }
    }).catch(() => {});

    // Then fetch live data (will overwrite cached)
    doFetch();

    let timer;
    if (interval) {
      timer = setInterval(doFetch, interval);
    }

    return () => {
      mountedRef.current = false;
      if (timer) clearInterval(timer);
    };
  }, [doFetch, interval, maxAgeMs, path]);

  return { data, status, error, cacheAge, refresh: doFetch };
}
