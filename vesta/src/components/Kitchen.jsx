import { useState } from 'react';
import Section from './Section.jsx';

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
export default function Kitchen({ sections, items, gap, onAdd, onUse }) {
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [drafts, setDrafts] = useState({});

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
