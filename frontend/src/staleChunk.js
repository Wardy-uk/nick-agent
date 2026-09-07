/**
 * Is this error "your tab is running yesterday's build", rather than a bug?
 *
 * PURE, and its own module (the `pi-health.assess()` / `vaultHealth` split) so
 * the wordings can be pinned without a DOM. `ErrorBoundary` re-exports it, and
 * the one-shot reload it licenses lives there.
 *
 * ⚠ **The list is a list of BROWSER WORDINGS, not of failure modes.** There is
 * exactly one failure here — a hashed asset from before the last deploy is no
 * longer on the server — and every engine, and every kind of asset, describes
 * it differently. A wording missing from this list does not degrade to a
 * slightly worse message: it lands in the GENERIC branch, which offers "Try
 * this screen again", which re-runs the same import against the same dead URL
 * for ever. So the panel looks broken rather than old, and the one action that
 * would fix it is not offered.
 *
 * That is precisely what happened on 7 Sep 2026 with **"Unable to preload CSS
 * for /assets/WeeklyRiskPanel-<hash>.css"** — Vite's own wording, thrown by its
 * preload helper when a lazy view's STYLESHEET 404s. Vite fetches the CSS
 * BEFORE importing the JS, so on a stale tab the CSS is what fails first and
 * the module-script wordings below are never reached. Same failure, same fix,
 * and it read as a crash in Weekly Risk.
 */
export function isStaleChunkError(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`.toLowerCase();
  return (
    // Chrome / Firefox
    text.includes('failed to fetch dynamically imported module')
    || text.includes('error loading dynamically imported module')
    // Safari and iOS — the wording Nick actually saw
    || text.includes('importing a module script failed')
    // The MIME complaint, when a shell was served in place of a chunk
    || (text.includes('module script') && text.includes('mime type'))
    || text.includes('chunkloaderror')
    // Vite's preload helper, when the lazy view's stylesheet is the dead asset
    || text.includes('unable to preload css')
  );
}
