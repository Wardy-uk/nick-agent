import { useRef, useState } from 'react';
import Section from './Section.jsx';
import PhotoProposal from './PhotoProposal.jsx';
import { preparePhoto, ACCEPTED } from '../photo.js';

/**
 * What is in, and getting it in and out.
 *
 * Sections come from the catalogue itself (`kitchenSections`), never a list
 * hardcoded here — he can add "Cupboard" or "Garage freezer" in Obsidian and it
 * appears, because the file is the catalogue and this is only a window onto it.
 *
 * ⚠ `items` is keyed by the LOWERCASED section name; `sections` carries the
 * display names. Keying the render off `items` alone would lose his
 * capitalisation and, worse, silently drop a section he has created but not yet
 * put anything in — an empty Freezer must still show, or she cannot add to it.
 */
export default function Kitchen({ sections, items, gap, photo, onAdd, onUse, onScan, onRefresh }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [proposal, setProposal] = useState(null);
  const [scanning, setScanning] = useState(false);
  const fileRef = useRef(null);

  async function takePhoto(e) {
    const file = e.target.files && e.target.files[0];
    // ⚠ Cleared immediately, or choosing the SAME photo twice fires no change
    // event and the button appears dead.
    e.target.value = '';
    if (!file) return;

    setScanning(true);
    setError(null);
    try {
      const { image, mediaType } = await preparePhoto(file);
      const result = await onScan(image, mediaType);
      setProposal(result.proposed);
    } catch (err) {
      setError(err.message);
    } finally {
      setScanning(false);
    }
  }

  async function act(fn, key) {
    setPending(key);
    setError(null);
    try { await fn(); }
    catch (err) { setError(err.message); }
    finally { setPending(null); }
  }

  const list = sections || [];
  const total = list.reduce((n, s) => n + ((items || {})[s.toLowerCase()] || []).length, 0);

  return (
    <Section
      title="The kitchen"
      gap={gap}
      empty={!gap && total === 0 && list.length > 0
        ? "Nothing recorded in here yet — add what's in and I'll start suggesting meals."
        : null}
    >
      {/* Only rendered when the server said the camera is switched on — a
          button that answers 503 when tapped is worse than no button. */}
      {photo && !proposal && (
        <div className="kitchen__photo">
          <input
            ref={fileRef}
            className="kitchen__file"
            type="file"
            accept={ACCEPTED}
            // Opens the camera straight away on a phone, rather than the
            // library — she is standing at the fridge.
            capture="environment"
            onChange={takePhoto}
          />
          <button className="btn" disabled={scanning} onClick={() => fileRef.current?.click()}>
            {scanning ? 'Looking…' : 'Photograph a shelf'}
          </button>
        </div>
      )}

      {proposal && (
        <PhotoProposal
          proposed={proposal}
          sections={list}
          onConfirm={async picked => {
            let added = 0, skipped = 0;
            const failed = [];
            // Sequential and fault-isolated: each add is a real write, and one
            // failure must not abandon the rest (bookAll()'s rule). Nothing is
            // retried.
            for (const item of picked) {
              try {
                const r = await onAdd(item.section, item.name, { quiet: true });
                if (r && r.already) skipped++; else added++;
              } catch (err) {
                failed.push({ name: item.name, why: err.message });
              }
            }
            return { added, skipped, failed };
          }}
          onCancel={() => {
            setProposal(null);
            // One refresh when the batch is done, rather than one per item —
            // the adds above ran `quiet`.
            onRefresh();
          }}
        />
      )}

      {list.map(section => {
        const key = section.toLowerCase();
        const contents = (items || {})[key] || [];
        return (
          <div className="shelf" key={key}>
            <h3 className="shelf__label">{section}</h3>

            {contents.length === 0
              ? <p className="shelf__empty">Empty.</p>
              : (
                <ul className="shelf__items">
                  {contents.map(item => {
                    const id = `${key}:${item.name}`;
                    return (
                      <li key={id}>
                        {/* Tapping it means it got eaten. The word on the button
                            says what actually happened rather than "delete". */}
                        <button
                          className="chip"
                          disabled={pending === id}
                          onClick={() => act(() => onUse(section, item.name), id)}
                          title={item.added ? `In since ${item.added}` : undefined}
                        >
                          <span className="chip__name">{item.name}</span>
                          <span className="chip__used">used</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

            <form
              className="composer composer--small"
              onSubmit={e => {
                e.preventDefault();
                const value = (drafts[key] || '').trim();
                if (!value) return;
                act(async () => {
                  await onAdd(section, value);
                  setDrafts(d => ({ ...d, [key]: '' }));
                }, `add:${key}`);
              }}
            >
              <input
                className="composer__input"
                value={drafts[key] || ''}
                onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))}
                placeholder={`Add to ${section.toLowerCase()}…`}
                enterKeyHint="done"
              />
              <button className="btn" disabled={pending === `add:${key}` || !(drafts[key] || '').trim()}>
                {pending === `add:${key}` ? '…' : 'In'}
              </button>
            </form>
          </div>
        );
      })}
      {error && <p className="composer__error" role="alert">{error}</p>}
    </Section>
  );
}
