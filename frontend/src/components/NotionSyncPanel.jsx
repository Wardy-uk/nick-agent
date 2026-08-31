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

// Sentinel for the "+ New folder…" option.
//
// Deliberately NOT a NUL byte, which is the airtight choice and makes the whole
// file read as binary to grep and to exact-match editing — the wart
// vault-hygiene.js already carries and nobody enjoys. The picker only ever lists
// real vault folders and this is compared exactly, so a collision is not
// reachable; if a folder somehow were named this, the only consequence is that
// the naming box opens.
const NEW_FOLDER = '__NEW_FOLDER__';

/**
 * Which folder's notes to offer for a `page` mapping.
 *
 * A page row reuses the folder select above as the FIRST step, so the folder is
 * read back off the chosen note once one is set — otherwise changing kind would
 * lose the folder and the picker would go blank under you.
 */
function noteFolderOf(row) {
  if (row.vaultFolder) return row.vaultFolder;
  if (row.vaultNote && row.vaultNote.includes('/')) {
    return row.vaultNote.slice(0, row.vaultNote.lastIndexOf('/'));
  }
  return '';
}

/** The second step of the page picker: notes inside the chosen folder. */
function NotePicker({ folder, value, onPick }) {
  const [state, setState] = useState({ loading: false, notes: [], reason: null });

  useEffect(() => {
    if (!folder) { setState({ loading: false, notes: [], reason: null }); return; }
    let cancelled = false;
    setState({ loading: true, notes: [], reason: null });
    fetch(apiUrl(`/api/notion-sync/notes?folder=${encodeURIComponent(folder)}`))
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setState({ loading: false, notes: d.notes || [], reason: d.reason }); })
      .catch((e) => { if (!cancelled) setState({ loading: false, notes: [], reason: e.message }); });
    return () => { cancelled = true; };
  }, [folder]);

  const prompt = !folder ? 'Choose a folder above first'
    : state.loading ? 'Loading notes…'
    : state.reason ? state.reason
    : state.notes.length ? 'Choose a note…'
    : 'No notes directly in that folder';

  return (
    <select value={value || ''} onChange={(e) => onPick(e.target.value)}>
      <option value="">{prompt}</option>
      {/* Same rule as everywhere else here: a stored value that is not in the
          list must stay selectable, or saving silently repoints the mapping. */}
      {value && !state.notes.includes(value) && (
        <option value={value}>{value} — not in that folder</option>
      )}
      {state.notes.map((n) => (
        <option key={n} value={n}>{n.slice(n.lastIndexOf('/') + 1)}</option>
      ))}
    </select>
  );
}

const blankRow = () => ({
  id: `new-${Math.random().toString(36).slice(2, 8)}`,
  kind: 'tree', notionPageId: '', notionTitle: '',
  vaultFolder: '', vaultNote: '', mode: 'two-way', enabled: true,
});

const KINDS = [
  {
    id: 'page',
    label: 'One note → this page',
    hint: 'The Notion page IS the note. Right for a topic page that holds its content in the body.',
  },
  {
    id: 'tree',
    label: 'Folder → child pages',
    hint: 'The Notion page is a container; each note becomes a child page inside it.',
  },
  {
    id: 'generated',
    label: 'NEURO writes this page',
    hint: 'Built from NEURO’s own records — no vault note behind it. Push-only, and '
      + 'anything typed into it in Notion is replaced on the next sync.',
  },
];

export default function NotionSyncPanel() {
  const [state, setState] = useState(null);
  const [rows, setRows] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState([]);
  const [pages, setPages] = useState(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState(null);
  // Naming a folder that does not exist yet — see the field for why.
  const [namingFolderFor, setNamingFolderFor] = useState(null);
  const [newFolder, setNewFolder] = useState('');
  const [newFolders, setNewFolders] = useState([]);
  const [foldersOpen, setFoldersOpen] = useState(false);

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

  // A folder named before it exists. Tracked locally only so the option can be
  // labelled "will be created" rather than "no longer in the vault" — the server
  // is still the one that validates it (inside the vault, not sensitive, not
  // overlapping another mapping).
  const commitNewFolder = (rowId) => {
    const folder = newFolder.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!folder) return;
    setNewFolders((prev) => (prev.includes(folder) ? prev : [...prev, folder]));
    update(rowId, { vaultFolder: folder });
    setNamingFolderFor(null);
    setNewFolder('');
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

  const setIgnore = async (pageId, ignoredOn, note) => {
    await fetch(apiUrl('/api/notion-sync/ignore'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId, ignored: ignoredOn, note }),
    });
    load();
  };

  if (!state) return <div className="notion-sync"><p className="ns-muted">Loading…</p></div>;

  // ── Coverage, derived from what is already on screen ───────────────────────
  //
  // Computed from the SAVED mappings (state.mappings), not the edited rows: this
  // answers "what is actually syncing", and showing unsaved edits here would
  // report coverage the server does not have.
  const ignored = state.ignoredPages || [];
  const ignoredById = new Map(ignored.map((e) => [e.id, e]));
  const savedByPage = new Map((state.mappings || []).map((m) => [m.notionPageId, m]));

  // ⚠ Coverage is about ANCESTRY, not about whether a page is itself a row.
  //
  // The first version asked "is this page a mapping target?" and called
  // everything else a gap. Measured against the live workspace that made 48 of
  // 60 pages amber — but 20 were descendants of a mapping and already syncing
  // (one of them a page this very sync had CREATED), and 10 were under the
  // ignored D&D tree. Only 7 were real. A gap column that is 85% noise is one
  // nobody reads, which costs exactly the one time it is right.
  const pageById = new Map((pages?.pages || []).map((p) => [p.id, p]));

  // Walk to the root, returning every ancestor id. Depth-capped against a
  // malformed parent chain.
  const ancestorsOf = (page) => {
    const out = [];
    let cur = page;
    for (let i = 0; i < 8 && cur?.parentId; i += 1) {
      out.push(cur.parentId);
      cur = pageById.get(cur.parentId);
    }
    return out;
  };

  // A page whose DESCENDANT is mapped is structural, not a gap — `Work` is a
  // container for six mapped children, and calling it unmapped is noise.
  const mappedAncestry = new Set();
  for (const m of state.mappings || []) {
    const page = pageById.get(m.notionPageId);
    if (page) for (const id of ancestorsOf(page)) mappedAncestry.add(id);
  }

  const coverageRows = (pages?.pages || []).map((page) => {
    const mapping = savedByPage.get(page.id);
    if (mapping) return { page, kind: 'mapped', mapping };

    const ancestry = ancestorsOf(page);

    const ig = ignoredById.get(page.id) || ancestry.map((id) => ignoredById.get(id)).find(Boolean);
    if (ig) return { page, kind: 'ignored', note: ig.note };

    // Inside a mapped TREE: its content is synced by that mapping.
    const coveringId = ancestry.find((id) => {
      const m = savedByPage.get(id);
      return m && m.kind !== 'page';
    });
    if (coveringId) {
      return { page, kind: 'covered', via: savedByPage.get(coveringId) };
    }

    if (mappedAncestry.has(page.id)) return { page, kind: 'container' };

    return { page, kind: 'unmapped' };
  // Real gaps first — the column worth acting on must not sit below the noise.
  }).sort((a, b) => {
    const rank = { unmapped: 0, mapped: 1, covered: 2, container: 3, ignored: 4 };
    return rank[a.kind] - rank[b.kind] || a.page.path.localeCompare(b.page.path);
  });

  // Mapped folders are listed even if they are not in vaultFolders() — a folder
  // named for a pull mapping does not exist until the first sync creates it.
  // A page mapping occupies its note's FOLDER for coverage purposes — the folder
  // is not fully mapped, but saying "not mapped" over a folder you publish from
  // would read as a gap it is not.
  const mappedFolderSet = new Set(
    (state.mappings || [])
      .map((m) => m.vaultFolder || (m.vaultNote || '').split('/').slice(0, -1).join('/'))
      .filter(Boolean),
  );
  const mappedFolders = [...mappedFolderSet].sort();
  const unmappedFolders = (state.vaultFolders || []).filter((f) => !mappedFolderSet.has(f));

  const mapped = coverageRows.filter((c) => c.kind === 'mapped');
  const covered = coverageRows.filter((c) => c.kind === 'covered');
  const unmapped = coverageRows.filter((c) => c.kind === 'unmapped');

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
                    // ⚠ The PATH, not the title. This workspace has two
                    // "Decisions", two "Current State" and two "Preferences" —
                    // bare titles cannot be picked correctly.
                    <option key={p.id} value={p.id}>{p.path || p.title}</option>
                  ))}
                </select>
              </label>

              <span className="ns-arrow" aria-hidden="true">↔</span>

              <label className="ns-field">
                <span>
                  {row.kind === 'generated' ? 'Built from'
                    : row.kind === 'page' ? 'Obsidian note'
                    : 'Obsidian parent folder'}
                </span>
                {row.kind === 'generated' ? (
                  <select
                    value={row.generator || ''}
                    onChange={(e) => update(row.id, { generator: e.target.value })}
                  >
                    <option value="">Choose what builds it…</option>
                    {(state.generators || []).map((g) => (
                      <option key={g.key} value={g.key}>{g.label}</option>
                    ))}
                  </select>
                ) : (<>
                {namingFolderFor === row.id ? (
                  // ⚠ A pull-only mapping's destination USUALLY DOES NOT EXIST
                  // yet — Hiking, Aquarium and the Memory Inbox live only in
                  // Notion. Making the field a dropdown quietly removed the
                  // ability to name a folder before it exists, which is the one
                  // thing those mappings need. The sync creates it on first pull.
                  <div className="ns-newfolder">
                    <input
                      autoFocus
                      value={newFolder}
                      placeholder="Notion/Hiking"
                      onChange={(e) => setNewFolder(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitNewFolder(row.id);
                        if (e.key === 'Escape') { setNamingFolderFor(null); setNewFolder(''); }
                      }}
                    />
                    <button onClick={() => commitNewFolder(row.id)} disabled={!newFolder.trim()}>Use</button>
                    <button
                      className="ns-remove"
                      onClick={() => { setNamingFolderFor(null); setNewFolder(''); }}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <select
                    value={row.vaultFolder}
                    onChange={(e) => {
                      if (e.target.value === NEW_FOLDER) {
                        setNewFolder('');
                        setNamingFolderFor(row.id);
                        return;
                      }
                      update(row.id, { vaultFolder: e.target.value });
                    }}
                  >
                    <option value="">
                      {state.vaultReadable === false ? 'Vault not readable' : 'Choose a folder…'}
                    </option>
                    {/* Same trap as the page select: a folder that has been
                        renamed, or one named here before it exists, must stay
                        selectable or saving would quietly repoint the mapping.
                        The two cases are labelled differently because they mean
                        opposite things — one is a mistake, one is intended. */}
                    {row.vaultFolder && !(state.vaultFolders || []).includes(row.vaultFolder) && (
                      <option value={row.vaultFolder}>
                        {row.vaultFolder}
                        {newFolders.includes(row.vaultFolder)
                          ? ' — will be created on first sync'
                          : ' — no longer in the vault'}
                      </option>
                    )}
                    {(state.vaultFolders || []).map((f) => <option key={f} value={f}>{f}</option>)}
                    <option value={NEW_FOLDER}>+ New folder…</option>
                  </select>
                )}

                {/* A `page` mapping needs a NOTE, and the vault holds 6,771 of
                    them — a flat list is not a picker, it is a wall. Folder
                    first, then the notes inside it: two bounded choices. */}
                {(row.kind || 'tree') === 'page' && (
                  <NotePicker
                    folder={noteFolderOf(row)}
                    value={row.vaultNote}
                    onPick={(notePath) => update(row.id, { vaultNote: notePath })}
                  />
                )}
                </>)}
              </label>
            </div>

            <div className="ns-row-controls">
              <select
                value={row.kind || 'tree'}
                onChange={(e) => update(row.id, { kind: e.target.value })}
              >
                {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
              </select>
              <select
                value={row.kind === 'generated' ? 'push-only' : row.mode}
                disabled={row.kind === 'generated'}
                onChange={(e) => update(row.id, { mode: e.target.value })}
              >
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

            <small className="ns-hint">
              {KINDS.find((k) => k.id === (row.kind || 'tree'))?.hint}{' '}
              {MODES.find((m) => m.id === row.mode)?.hint}
            </small>
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


      {/* ── Coverage ────────────────────────────────────────────────────────
          What is mapped and what is not. The unmapped column is the point: a
          page nobody has mapped is invisible otherwise, and the whole reason
          this exists is that a tree can be silently owned by something else.
          An IGNORED page is shown separately from an unmapped one, because
          "handled elsewhere" and "a gap" need opposite reactions. */}
      {state.configured && pages?.ok && pages.shared && (
        <section className="ns-coverage">
          {/* "Synced" is the honest headline: a page inside a mapped tree IS
              synced, and counting it as a gap is what made this list unreadable. */}
          <h3>
            Coverage — {mapped.length + covered.length} synced
            {unmapped.length > 0 && `, ${unmapped.length} not mapped`}
            {ignored.length > 0 && `, ${ignored.length} ignored`}
          </h3>

          <ul className="ns-cov-list">
            {coverageRows.map((c) => (
              <li key={c.page.id} className={`ns-cov ns-cov--${c.kind}`}>
                <span className="ns-cov-title">{c.page.path || c.page.title}</span>
                {c.kind === 'mapped' && (
                  <span className="ns-cov-detail">
                    → <code>{c.mapping.generator ? `NEURO: ${c.mapping.generator}` : (c.mapping.vaultNote || c.mapping.vaultFolder)}</code>{' '}
                    {MODES.find((m) => m.id === c.mapping.mode)?.label}
                    {!c.mapping.enabled && ' · disabled'}
                  </span>
                )}
                {c.kind === 'covered' && (
                  <span className="ns-cov-detail">
                    synced by <code>{c.via.vaultFolder}</code>
                  </span>
                )}
                {c.kind === 'container' && (
                  <span className="ns-cov-detail">holds mapped pages</span>
                )}
                {c.kind === 'ignored' && (
                  <span className="ns-cov-detail">
                    not mapped on purpose{c.note ? ` — ${c.note}` : ''}
                    <button className="ns-remove" onClick={() => setIgnore(c.page.id, false)}>Un-ignore</button>
                  </span>
                )}
                {c.kind === 'unmapped' && (
                  <span className="ns-cov-detail">
                    <button
                      onClick={() => {
                        setDirty(true);
                        setRows((prev) => [...prev, {
                          ...blankRow(), notionPageId: c.page.id, notionTitle: c.page.title,
                        }]);
                      }}
                    >
                      Map this
                    </button>
                    <button
                      className="ns-remove"
                      onClick={() => setIgnore(c.page.id, true, 'handled elsewhere')}
                    >
                      Ignore
                    </button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── Obsidian folders ────────────────────────────────────────────────
          Collapsed by default, and that is the right default rather than a
          cosmetic one: this vault has 99 eligible folders and almost all of
          them will never be mapped, so expanded it buries the Notion coverage
          above it — the list you actually act on. */}
      {state.vaultReadable !== false && (
        <section className="ns-coverage">
          <button className="ns-disclosure" onClick={() => setFoldersOpen((v) => !v)}>
            <span className="ns-disclosure-mark">{foldersOpen ? '▾' : '▸'}</span>
            Obsidian folders — {mappedFolders.length} mapped, {unmappedFolders.length} not mapped
          </button>

          {foldersOpen && (
            <ul className="ns-cov-list ns-cov-list--folders">
              {mappedFolders.map((f) => (
                <li key={f} className="ns-cov ns-cov--mapped">
                  <span className="ns-cov-title"><code>{f}</code></span>
                  <span className="ns-cov-detail">
                    → {(state.mappings || []).find((m) => m.vaultFolder === f)?.notionTitle || 'Notion'}
                  </span>
                </li>
              ))}
              {unmappedFolders.map((f) => (
                <li key={f} className="ns-cov ns-cov--plain">
                  <span className="ns-cov-title"><code>{f}</code></span>
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
