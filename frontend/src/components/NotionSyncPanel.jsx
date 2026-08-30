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
          <strong>Not connected.</strong> Set <code>NOTION_TOKEN</code> in <code>backend/.env</code> and
          share the pages you want synced with the NEURO integration.
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
                <input
                  value={row.notionPageId}
                  placeholder="Paste a Notion page URL or ID"
                  onChange={(e) => update(row.id, { notionPageId: e.target.value })}
                />
                {row.notionTitle && <small className="ns-muted">{row.notionTitle}</small>}
              </label>

              <span className="ns-arrow" aria-hidden="true">↔</span>

              <label className="ns-field">
                <span>Obsidian parent folder</span>
                <input
                  list={`ns-folders-${row.id}`}
                  value={row.vaultFolder}
                  placeholder="Projects/Notion"
                  onChange={(e) => update(row.id, { vaultFolder: e.target.value })}
                />
                <datalist id={`ns-folders-${row.id}`}>
                  {(state.vaultFolders || []).map((f) => <option key={f} value={f} />)}
                </datalist>
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
        <button onClick={loadPages} disabled={!state.configured}>Browse Notion pages</button>
        <button className="ns-primary" onClick={save} disabled={!dirty || busy}>
          {busy ? 'Saving…' : dirty ? 'Save mappings' : 'Saved'}
        </button>
      </div>

      {errors.length > 0 && (
        <div className="ns-warn">
          <strong>Not saved.</strong>
          <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      {pages && (
        <section className="ns-pages">
          <h3>Pages shared with NEURO</h3>
          {pages.loading && <p className="ns-muted">Asking Notion…</p>}
          {pages.error && <p className="ns-warn">{pages.error}</p>}
          {/* "Nothing shared yet" is a setup step, not an empty workspace. */}
          {pages.ok && !pages.shared && <p className="ns-muted">{pages.note}</p>}
          {pages.ok && pages.shared && (
            <ul>
              {pages.pages.map((p) => (
                <li key={p.id}>
                  <button onClick={() => {
                    setDirty(true);
                    setRows((prev) => [...prev, { ...blankRow(), notionPageId: p.id, notionTitle: p.title }]);
                  }}>
                    {p.title}
                  </button>
                  {p.isChild && <small className="ns-muted"> (child page)</small>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="ns-run">
        <div className="ns-actions">
          <button onClick={() => runSync(false)} disabled={busy || dirty}>Preview changes</button>
          <button onClick={() => runSync(true)} disabled={busy || dirty}>Sync now</button>
        </div>
        {dirty && <small className="ns-muted">Save your mappings before running a sync.</small>}

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
