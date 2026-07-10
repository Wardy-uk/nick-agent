import { useSaraState } from '../../state/saraState';
import { useState } from 'react';

export default function TodosView() {
  const { status, error, model, presentation, approveTodoCandidate, rejectTodoCandidate } = useSaraState();
  const [actingId, setActingId] = useState(null);

  if (status === 'connecting') return <section className="product"><p className="product__summary">Waking SARA…</p></section>;
  if (status === 'disconnected' || !model) {
    return <section className="product"><p className="product__summary">SARA backend unreachable on /api/state{error ? ` — ${error}` : ''}.</p></section>;
  }

  const todos = presentation.todos;

  async function act(actionId, verb) {
    setActingId(actionId);
    const result = verb === 'approve'
      ? await approveTodoCandidate(actionId)
      : await rejectTodoCandidate(actionId);
    setActingId(null);
    return result;
  }

  return (
    <section className="product" aria-label="Todos">
      <header className="product__hero">
        <p className="product__eyebrow">Todos</p>
        <h2 className="product__title">Backlog in plain sight</h2>
        <p className="product__summary">Live tasks pulled through the shared state model. This screen still reads one source of truth, it just no longer invents the backlog.</p>
        <div className="product__meta">
          <span className="product__pill">{todos.source}</span>
        </div>
      </header>

      <section className="product__section product__section--span-12">
        <p className="product__section-title">Current list</p>
        <ul className="product__list">
          {todos.items.map((item) => (
            <li key={item.id} className="product__card">
              <p className="product__card-title">{item.title}</p>
              <div className="product__meta">
                <span className="product__pill">{item.state}</span>
                {item.dueDate && <span className="product__pill">{item.dueDate.slice(0, 10)}</span>}
                {item.source && <span className="product__pill">{item.source}</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {todos.candidates?.length > 0 && (
        <section className="product__section product__section--span-12">
          <p className="product__section-title">Extracted from notes</p>
          <ul className="product__list">
            {todos.candidates.map((item) => (
              <li key={item.id} className="product__card">
                <p className="product__card-title">{item.title}</p>
                <p className="product__summary">{item.detail}</p>
                <div className="product__meta">
                  {item.sourcePath && <span className="product__pill">{item.sourcePath}</span>}
                  <span className="product__pill">{Math.round((item.confidence || 0) * 100)}%</span>
                </div>
                <div className="product__actions">
                  <button type="button" disabled={actingId === item.id} onClick={() => act(item.id, 'reject')}>Dismiss</button>
                  <button type="button" disabled={actingId === item.id} onClick={() => act(item.id, 'approve')}>Add todo</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}
