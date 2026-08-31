import React, { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../api';
import './CataloguesPanel.css';

/**
 * Catalogues — lists of things Nick owns, keeps or has in.
 *
 * `/api/catalogues` has been live since 31 Aug with no UI at all, which is the
 * routable-but-unreachable hole this codebase has already documented twice
 * (`TodoPanel`, `DecisionsPanel`). The engine is `services/catalogue.js`; a
 * catalogue is one markdown file under `Catalogues/` in the vault, so most of
 * them will be made and edited by hand in Obsidian and this panel is the other
 * door, not the source of truth.
 *
 * ⚠ SHARING IS THE ONE CONTROL WITH A CONSEQUENCE OUTSIDE THE HOUSE. `shared`
 * is what VESTA can read, and VESTA is on the PUBLIC INTERNET behind Tailscale
 * Funnel. So sharing asks first and names where the list goes; un-sharing does
 * not, because the failure directions are not symmetric — a private list nobody
 * can see is an inconvenience, a shared one he did not mean to share is public.
 *
 * ⚠ "I could not read this" and "there is nothing in it" are different facts and
 * never render alike. An unreadable vault reports itself; it does not look like
 * a man who owns nothing.
 */

// The kitchen is not special code — it is the catalogue VESTA reads for the
// fridge screen, and it has to be slugged exactly this or VESTA will not find
// it. Worth saying on screen once, rather than letting him wonder why an empty
// VESTA never fills up.
const KITCHEN_SLUG = 'kitchen';

function ErrorLine({ children }) {
  return <div className="cat-error">{children}</div>;
}

/* ------------------------------------------------------------------ create */

function CreateCatalogue({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [sections, setSections] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const parsed = sections.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await apiFetch('/api/catalogues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // ⚠ Deliberately no `shared` here. A catalogue is created PRIVATE and
        // shared as a separate, deliberate act — a checkbox on a create form is
        // exactly how something ends up public by accident.
        body: JSON.stringify({ title, sections: parsed.length ? parsed : null }),
      });
      const data = await r.json();
      if (!data.ok) { setError(data.error || 'Could not create that catalogue.'); return; }
      setTitle('');
      setSections('');
      setOpen(false);
      onCreated(data.slug);
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  if (!open) {
    return <button className="cat-primary" onClick={() => setOpen(true)}>New catalogue</button>;
  }

  return (
    <div className="cat-create">
      <input
        value={title}
        placeholder="Name — Kitchen, Vinyl, Hiking kit"
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && title.trim() && submit()}
      />
      <input
        value={sections}
        placeholder="Sections, comma separated (default: Items)"
        onChange={(e) => setSections(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && title.trim() && submit()}
      />
      <div className="cat-create-actions">
        <button className="cat-primary" onClick={submit} disabled={!title.trim() || busy}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button className="cat-plain" onClick={() => { setOpen(false); setError(null); }}>Cancel</button>
      </div>
      <small className="cat-muted">Created private. Sharing it with VESTA is a separate step.</small>
      {error && <ErrorLine>{error}</ErrorLine>}
    </div>
  );
}

/* ------------------------------------------------------------------- share */

function ShareControl({ cat, onChanged }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = async (shared) => {
    setBusy(true);
    setError(null);
    try {
      const r = await apiFetch(`/api/catalogues/${encodeURIComponent(cat.slug)}/shared`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shared }),
      });
      const data = await r.json();
      if (!data.ok) { setError(data.error || 'Could not change sharing.'); return; }
      setConfirming(false);
      onChanged(data.shared);
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  };

  if (cat.shared) {
    return (
      <div className="cat-share cat-share--on">
        <span className="cat-share-state">Shared with VESTA</span>
        <button className="cat-plain" onClick={() => set(false)} disabled={busy}>
          {busy ? 'Working…' : 'Stop sharing'}
        </button>
        {error && <ErrorLine>{error}</ErrorLine>}
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="cat-share cat-confirm">
        <p><strong>Share “{cat.title}” with VESTA?</strong></p>
        <p>
          VESTA is reachable from outside the house, over the public internet. Anyone signed in
          there with the kitchen scope will be able to read this list, add to it and mark things
          used — everything in it now, and everything added to it later.
        </p>
        <div className="cat-create-actions">
          <button className="cat-danger" onClick={() => set(true)} disabled={busy}>
            {busy ? 'Sharing…' : 'Yes, share it'}
          </button>
          <button className="cat-plain" onClick={() => setConfirming(false)}>Keep it private</button>
        </div>
        {error && <ErrorLine>{error}</ErrorLine>}
      </div>
    );
  }

  return (
    <div className="cat-share">
      <span className="cat-share-state cat-muted">Private</span>
      <button className="cat-plain" onClick={() => setConfirming(true)}>Share with VESTA…</button>
    </div>
  );
}

/* ------------------------------------------------------------------ detail */

function Section({ slug, section, items, onChanged }) {
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [note, setNote] = useState(null);

  const post = async (path, body) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await apiFetch(`/api/catalogues/${encodeURIComponent(slug)}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!data.ok) { setError(data.error || 'That did not work.'); return null; }
      return data;
    } catch (e) {
      setError(e.message);
      return null;
    } finally { setBusy(false); }
  };

  const add = async () => {
    const name = adding.trim();
    if (!name) return;
    const data = await post('add', { section, name });
    if (!data) return;
    // The engine folds a second sighting of the same wording rather than
    // duplicating it. Say so, or a tap that changed nothing looks broken.
    if (data.already) setNote(`“${name}” was already in ${section}.`);
    setAdding('');
    onChanged();
  };

  const remove = async (name) => {
    const data = await post('remove', { section, name });
    if (data) onChanged();
  };

  return (
    <section className="cat-section">
      <h4>{section} <span className="cat-muted">({items.length})</span></h4>
      {items.length === 0 && <p className="cat-muted cat-empty">Nothing in here.</p>}
      <ul className="cat-items">
        {items.map((it) => (
          <li key={it.name}>
            <span className="cat-item-name">{it.name}</span>
            {it.added && <span className="cat-muted cat-item-added">in since {it.added}</span>}
            <button
              className="cat-remove"
              onClick={() => remove(it.name)}
              disabled={busy}
              title={`Remove ${it.name} from ${section}`}
            >
              remove
            </button>
          </li>
        ))}
      </ul>
      <div className="cat-add">
        <input
          value={adding}
          placeholder={`Add to ${section}`}
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="cat-plain" onClick={add} disabled={!adding.trim() || busy}>Add</button>
      </div>
      {note && <small className="cat-muted">{note}</small>}
      {error && <ErrorLine>{error}</ErrorLine>}
    </section>
  );
}

function CatalogueDetail({ slug, onClose, onMutated }) {
  const [cat, setCat] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch(`/api/catalogues/${encodeURIComponent(slug)}`);
      const data = await r.json();
      if (!data.ok) { setCat(null); setError(data.error || 'Could not read that catalogue.'); return; }
      setCat(data);
      setError(null);
    } catch (e) {
      setCat(null);
      setError(e.message);
    } finally { setLoading(false); }
  }, [slug]);

  useEffect(() => { load(); }, [load]);

  const changed = () => { load(); onMutated(); };

  if (loading && !cat) return <div className="cat-detail"><p className="cat-muted">Reading…</p></div>;

  if (error) {
    return (
      <div className="cat-detail">
        <button className="cat-plain" onClick={onClose}>← All catalogues</button>
        <ErrorLine>I couldn’t read <code>{slug}</code> — {error}</ErrorLine>
        <p className="cat-muted">That is not the same as it being empty. Nothing has been changed.</p>
      </div>
    );
  }

  return (
    <div className="cat-detail">
      <button className="cat-plain" onClick={onClose}>← All catalogues</button>
      <div className="cat-detail-head">
        <h3>{cat.title}</h3>
        <code className="cat-muted">Catalogues/{cat.slug}.md</code>
      </div>
      <ShareControl cat={cat} onChanged={changed} />
      {cat.sections.map((s) => (
        <Section
          key={s}
          slug={cat.slug}
          section={s}
          items={(cat.items && cat.items[s.toLowerCase()]) || []}
          onChanged={changed}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------- list */

export default function CataloguesPanel() {
  const [catalogues, setCatalogues] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [openSlug, setOpenSlug] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiFetch('/api/catalogues');
      const data = await r.json();
      if (!data.ok) { setError(data.error || 'Could not read the catalogues folder.'); return; }
      setCatalogues(data.catalogues || []);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (openSlug) {
    return (
      <div className="catalogues">
        <CatalogueDetail slug={openSlug} onClose={() => { setOpenSlug(null); load(); }} onMutated={load} />
      </div>
    );
  }

  const hasKitchen = catalogues.some((c) => c.slug === KITCHEN_SLUG);

  return (
    <div className="catalogues">
      <div className="cat-head">
        <h2>Catalogues</h2>
        <p className="cat-muted">
          Lists of things you own, keep or have in. One markdown file each under{' '}
          <code>Catalogues/</code> in the vault, so you can edit them in Obsidian too.
        </p>
      </div>

      {/* ⚠ An unreadable vault reports itself. It must never render as "you have
          no catalogues", which is what sends someone off to create a second copy
          of a list that already exists. */}
      {error && (
        <>
          <ErrorLine>I couldn’t read your catalogues — {error}</ErrorLine>
          <p className="cat-muted">That is not the same as having none. Nothing below is a complete list.</p>
        </>
      )}

      {!error && loading && <p className="cat-muted">Reading…</p>}

      {!error && !loading && catalogues.length === 0 && (
        <p className="cat-muted">No catalogues yet.</p>
      )}

      <ul className="cat-list">
        {catalogues.map((c) => (
          <li key={c.slug} className={`cat-row${c.error ? ' cat-row--broken' : ''}`}>
            <button className="cat-open" onClick={() => setOpenSlug(c.slug)} disabled={!!c.error}>
              <span className="cat-title">{c.title}</span>
              {c.error
                ? <span className="cat-error-inline">unreadable — {c.error}</span>
                : (
                  <span className="cat-meta cat-muted">
                    {c.count} {c.count === 1 ? 'item' : 'items'}
                    {c.sections && c.sections.length ? ` · ${c.sections.join(', ')}` : ''}
                  </span>
                )}
            </button>
            {c.shared && <span className="cat-badge">shared</span>}
          </li>
        ))}
      </ul>

      <div className="cat-foot">
        <CreateCatalogue onCreated={(slug) => { load(); setOpenSlug(slug); }} />
        {!error && !loading && !hasKitchen && (
          <small className="cat-muted">
            VESTA’s fridge screen reads the catalogue named <strong>Kitchen</strong> and needs it
            shared. There isn’t one yet.
          </small>
        )}
      </div>
    </div>
  );
}
