import React, { useState, useEffect, useCallback } from 'react';
import { apiUrl } from '../api';
import './NotionSyncPanel.css';

// The mapping table: which Notion page tree is kept in step with which Obsidian
// parent folder.
//
// The panel edits a LOCAL copy and saves the whole table at once, because the
// validation rules (overlapping folders, a page mapped twice) are relationships
// between rows — a per-row save can walk the list into a state no single edit
// was invalid for. `dirty` is what stops a background refresh overwriting an
// edit in progress.

const MODES = [
  { id: 'two-way', label: 'Two-way', hint: 'Edits on either side reach the other. Conflicts are never merged.' },
  { id: 'pull-only', label: 'Notion → vault', hint: 'Notion is the source. Nothing NEURO does can change the Notion page.' },
  { id: 'push-only', label: 'Vault → Notion', hint: 'The vault is the source. Notion is a read-only window on it.' },
];

/**
 * Paste-the-token field.
 *
 * A password input, and the value is never read back from the server — the
 * routes report only WHETHER a credential is set and which source answered.
 */
function TokenField({ onSaved }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(apiUrl('/api/notion-sync/token'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: value }),
      });
      const data = await r.json();
      if (data.ok) { setValue(''); onSaved(); }
      else setError(data.error || 'Could not save the token.');
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  return (
    <div className="ns-token">
      <input
        type="password"
        value={value}
        placeholder="ntn_…"
        autoComplete="off"
        spellCheck="false"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && value && submit()}
      />
      <button className="ns-primary" onClick={submit} disabled={!value || busy}>
        {busy ? 'Connecting…' : 'Connect'}
      </button>
      {error && <small className="ns-token-error">{error}</small>}
    </div>
  );
}

/**
 * What the empty option says.
 *
 * Four states that look identical as an empty dropdown and need different
 * actions: not connected, still asking, could not ask, and connected-but-nothing
 * -shared. The last is the one people hit — the token grants access to nothing
 * until pages are shared with the integration — so it must never render as
 * "no pages exist".
 */
function pageChoicePrompt(pages, state) {
  if (!state.configured) return 'Connect Notion first';
  if (!pages || pages.loading) return 'Loading pages…';
  if (pages.error || pages.ok === false) return "Couldn't reach Notion";
  if (!pages.shared) return 'No pages shared with the integration yet';
  return 'Choose a page…';
}

const blankRow = () => ({
  id: `new-${Math.random().toString(36).slice(2, 8)}`,
  notionPageId: '', notionTitle: '', vaultFolder: '', mode: 'two-way', enabled: true,
});

export default function NotionSyncPanel() {
  const [state, setState] = useState(null);
  const [rows, setRows] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState([]);
  const [pages, setPages] = useState(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/notion-sync'));
      const data = await r.json();
      setState(data);
      // Never clobber an edit in progress with a background read.
      if (!dirty) setRows(data.mappings || []);
    } catch (e) {
      setState({ ok: false, error: e.message });
    }
  }, [dirty]);

  useEffect(() => { load(); }, [load]);

  const loadPages = useCallback(async () => {
    setPages({ loading: true });
    try {
      const r = await fetch(apiUrl('/api/notion-sync/pages'));
      setPages(await r.json());
    } catch (e) {
      setPages({ ok: false, error: e.message });
    }
  }, []);

  // Fetched as soon as we are connected, rather than behind a "Browse" button:
  // the dropdown IS the browser now, and a select that only fills in after you
  // find the right button is just the paste field with extra steps.
  useEffect(() => { if (state?.configured) loadPages(); }, [state?.configured, loadPages]);

  const update = (id, patch) => {
    setDirty(true);
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await fetch(apiUrl('/api/notion-sync/mappings'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mappings: rows }),
      });
      const data = await r.json();
      setErrors(data.errors || []);
      if (data.ok) { setDirty(false); setRows(data.mappings); load(); }
    } catch (e) {
      setErrors([e.message]);
    } finally { setBusy(false); }
  };

  const runSync = async (apply) => {
    setBusy(true);
    setReport(null);
    try {
      const r = await fetch(apiUrl(`/api/notion-sync/run${apply ? '?apply=1' : ''}`), { method: 'POST' });
      setReport(await r.json());
      load();
    } catch (e) {
      setReport({ ok: false, gaps: [e.message], counts: {} });
    } finally { setBusy(false); }
  };

  if (!state) return <div className="notion-sync"><p className="ns-muted">Loading…</p></div>;

  return (
    <div className="notion-sync">
      <header className="ns-head">
        <h2>Notion sync</h2>
        <p className="ns-muted">
          Named Notion page trees, kept in step with Obsidian parent folders.
          Nothing is ever deleted on either side.
        </p>
      </header>

      {!state.configured && (
        <div className="ns-warn">
          <strong>Not connected.</strong>
          <p>
            Create an integration at{' '}
            <a href="https://www.notion.so/my-integrations" target="_blank" rel="noreferrer">
              notion.so/my-integrations
            </a>{' '}
            with read, update and insert content capabilities, then paste its token here.
          </p>
          <TokenField onSaved={load} />
          <p className="ns-muted">
            Then share each parent page with it in Notion: <strong>⋯ → Connections → your
            integration</strong>. The token on its own grants access to nothing.
          </p>
        </div>
      )}

      {state.configured && (
        <div className="ns-connected">
          <span>
            Connected
            {state.credentialSource === 'env' && ' — token set in the environment'}
          </span>
          {/* An env-set token cannot be changed from here, so no field is offered
              rather than one that silently does nothing. */}
          {state.credentialSource === 'stored' && (
            <button
              className="ns-remove"
              onClick={async () => {
                await fetch(apiUrl('/api/notion-sync/token'), { method: 'DELETE' });
                load();
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      )}
      {state.vaultReadable === false && (
        <div className="ns-warn">
          <strong>The vault is not readable.</strong> Folders can’t be listed and the sync will refuse
          to run — it won’t treat an unreadable vault as an empty one.
        </div>
      )}

      <section className="ns-rows">
        {rows.length === 0 && <p className="ns-muted">No folders mapped yet.</p>}

        {rows.map((row) => (
          <div className={`ns-row${row.enabled ? '' : ' ns-row--off'}`} key={row.id}>
            <div className="ns-row-main">
              <label className="ns-field">
                <span>Notion page</span>
                <select
                  value={row.notionPageId}
                  onChange={(e) => {
                    const picked = (pages?.pages || []).find((p) => p.id === e.target.value);
                    // The title rides along so a mapping still names its page
                    // when Notion is unreachable, or after it is unshared.
                    update(row.id, { notionPageId: e.target.value, notionTitle: picked?.title || null });
                  }}
                >
                  <option value="">{pageChoicePrompt(pages, state)}</option>
                  {/* ⚠ A select cannot represent a value that is not among its
                      options — it renders blank and the next save silently
                      rewrites the mapping to nothing. So a page that is stored
                      but no longer listed (unshared, archived, or Notion simply
                      unreachable) is kept as an explicit option that SAYS so. */}
                  {row.notionPageId && !(pages?.pages || []).some((p) => p.id === row.notionPageId) && (
                    <option value={row.notionPageId}>
                      {row.notionTitle ? `${row.notionTitle} — not currently visible` : 'Stored page — not currently visible'}
                    </option>
                  )}
                  {(pages?.pages || []).map((p) => (
                    <option key={p.id} value={p.id}>{p.title}{p.isChild ? '' : '  (top level)'}</option>
                  ))}
                </select>
              </label>

              <span className="ns-arrow" aria-hidden="true">↔</span>

              <label className="ns-field">
                <span>Obsidian parent folder</span>
                <select
                  value={row.vaultFolder}
                  onChange={(e) => update(row.id, { vaultFolder: e.target.value })}
                >
                  <option value="">
                    {state.vaultReadable === false ? 'Vault not readable' : 'Choose a folder…'}
                  </option>
                  {/* Same trap: a folder that has been renamed or removed since
                      the mapping was made must stay selectable, or saving would
                      quietly repoint the mapping. */}
                  {row.vaultFolder && !(state.vaultFolders || []).includes(row.vaultFolder) && (
                    <option value={row.vaultFolder}>{row.vaultFolder} — no longer in the vault</option>
                  )}
                  {(state.vaultFolders || []).map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              </label>
            </div>

            <div className="ns-row-controls">
              <select value={row.mode} onChange={(e) => update(row.id, { mode: e.target.value })}>
                {MODES.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
              <label className="ns-toggle">
                <input
                  type="checkbox"
                  checked={row.enabled}
                  onChange={(e) => update(row.id, { enabled: e.target.checked })}
                />
                <span>Enabled</span>
              </label>
              <button
                className="ns-remove"
                onClick={() => { setDirty(true); setRows((p) => p.filter((r) => r.id !== row.id)); }}
              >
                Remove
              </button>
            </div>

            <small className="ns-hint">{MODES.find((m) => m.id === row.mode)?.hint}</small>
          </div>
        ))}
      </section>

      <div className="ns-actions">
        <button onClick={() => { setDirty(true); setRows((p) => [...p, blankRow()]); }}>
          Add mapping
        </button>
        {/* Refresh, not Browse — the dropdown already lists the pages. This is
            for the common setup moment: share a page in Notion, come back, and
            expect to find it without reloading NEURO. */}
        <button onClick={loadPages} disabled={!state.configured || pages?.loading}>
          {pages?.loading ? 'Checking Notion…' : 'Refresh page list'}
        </button>
        <button className="ns-primary" onClick={save} disabled={!dirty || busy}>
          {busy ? 'Saving…' : dirty ? 'Save mappings' : 'Saved'}
        </button>
      </div>

      {/* Only the states that need an action. A healthy list is the dropdown's
          job to show, not a second panel repeating it. */}
      {state.configured && pages && !pages.loading && (pages.error || pages.ok === false) && (
        <div className="ns-warn">
          <strong>Couldn’t reach Notion.</strong> {pages.error}
        </div>
      )}
      {state.configured && pages?.ok && !pages.shared && (
        <div className="ns-warn">
          <strong>No pages shared yet.</strong> In Notion, open the page you want synced →
          <strong> ⋯ → Connections → your integration</strong>, then hit “Refresh page list”.
          The token on its own grants access to nothing.
        </div>
      )}

      {errors.length > 0 && (
        <div className="ns-warn">
          <strong>Not saved.</strong>
          <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}


      <section className="ns-run">
        <div className="ns-actions">
          <button onClick={() => runSync(false)} disabled={busy || dirty}>Preview changes</button>
          <button onClick={() => runSync(true)} disabled={busy || dirty}>Sync now</button>
        </div>
        {dirty && <small className="ns-muted">Save your mappings before running a sync.</small>}

        {/* The cron switch. Checked on every tick rather than at boot, so this
            takes effect at the next quarter hour with no restart. */}
        <label className="ns-toggle ns-auto">
          <input
            type="checkbox"
            checked={state.autoSync}
            disabled={state.autoSyncForcedByEnv || !state.configured}
            onChange={async (e) => {
              await fetch(apiUrl('/api/notion-sync/auto'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: e.target.checked }),
              });
              load();
            }}
          />
          <span>
            Sync automatically every 15 minutes
            {state.autoSyncForcedByEnv && ' — forced on by NOTION_SYNC_ENABLED'}
          </span>
        </label>

        {/* Last run, from the server — so a panel left open never implies a
            sync happened more recently than it did. */}
        {state.lastRun?.known && !report && (
          <p className="ns-muted">
            Last run {new Date(state.lastRun.at).toLocaleString()} —{' '}
            {summarise(state.lastRun.counts)}
            {state.lastRun.gaps?.length > 0 && ` · ${state.lastRun.gaps.length} problem(s)`}
          </p>
        )}
        {state.lastRun?.known === false && !report && (
          <p className="ns-muted">Never run.</p>
        )}

        {report && (
          <div className={report.ok ? 'ns-report' : 'ns-report ns-report--bad'}>
            <strong>{report.dryRun ? 'Preview' : 'Sync'} — {summarise(report.counts)}</strong>
            {report.gaps?.length > 0 && (
              <ul className="ns-gaps">{report.gaps.map((g) => <li key={g}>{g}</li>)}</ul>
            )}
            {report.mappings?.map((m) => {
              // Only the notes something would happen to. A list of "unchanged"
              // is the bulk of every run and buries the handful that matter.
              const notable = (m.notes || []).filter((n) => n.action !== 'noop');
              if (!notable.length) return null;
              return (
                <div key={m.id} className="ns-report-map">
                  <h4>{m.folder}</h4>
                  <ul>
                    {notable.map((n) => (
                      <li key={n.path} className={`ns-act ns-act--${n.action}`}>
                        <code>{n.path}</code> — {n.action}
                        <small className="ns-muted"> · {n.reason}</small>
                        {n.conflictCopy && (
                          <small className="ns-muted"> · Notion’s version saved as {n.conflictCopy}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function summarise(counts = {}) {
  const parts = [
    counts.pulled && `${counts.pulled} pulled`,
    counts.pushed && `${counts.pushed} pushed`,
    counts.created && `${counts.created} created`,
    counts.conflicts && `${counts.conflicts} conflict(s)`,
    counts.skipped && `${counts.skipped} skipped`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'nothing to do';
}
