import { useCallback, useEffect, useState } from 'react';
import * as api from '../api';
import Tasks from '../components/Tasks.jsx';
import Calendar from '../components/Calendar.jsx';
import Kitchen from '../components/Kitchen.jsx';
import Meals from '../components/Meals.jsx';

const KITCHEN_SLUG = 'kitchen';

/**
 * One GET renders the whole screen.
 *
 * It is a fridge-door screen, on a phone, over mobile data. Four round trips to
 * draw one page is three too many, so `/home` returns everything this account
 * may see and every block reports its own failure — a kitchen file that will not
 * parse must not blank the diary.
 *
 * ⚠ SCOPES DECIDE WHAT IS MOUNTED AT ALL, not what is hidden with CSS. A block
 * she has no right to see is ABSENT from the response and absent from the page.
 * An empty calendar and no permission to see the calendar are different facts
 * and must not share a rendering.
 */
export default function Home({ onSignedOut }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const token = api.getToken();

  const refresh = useCallback(async () => {
    try {
      setData(await api.home(token));
      setError(null);
    } catch (err) {
      // A dead session is not an error to puzzle over — it is a sign-in.
      if (err.expired) return onSignedOut();
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, onSignedOut]);

  useEffect(() => { refresh(); }, [refresh]);

  if (loading) return <p className="home__loading">Getting things…</p>;

  if (error && !data) {
    return (
      <div className="home__error" role="alert">
        <p>{error}</p>
        <button className="btn" onClick={refresh}>Try again</button>
      </div>
    );
  }

  const scopes = data.scopes || [];
  const can = s => scopes.includes(s);
  const gapFor = block => (data.gaps || []).find(g => g.block === block)?.why || null;

  // ⚠ A block is a GAP when the server could not read it — the response carries
  // `null` and a reason. It is EMPTY when it read fine and held nothing. The
  // components keep those apart; this only has to pass the reason through.
  const cataloguesGap = gapFor('catalogues');
  const kitchenGap = gapFor('kitchen') || cataloguesGap;

  // Both of the things only Nick can do. Until his partner has an account with
  // the kitchen scope AND a catalogue called "kitchen" marked shared, this
  // section is correct and empty — so it says which is missing rather than
  // rendering a blank panel that looks broken.
  const kitchenMissing = can('kitchen') && !kitchenGap && !data.kitchenSections;

  async function addTask(text, assignees, dueDate) {
    await api.addTask(token, text, assignees, dueDate);
    await refresh();
  }

  async function updateTask(id, patch) {
    await api.updateTask(token, id, patch);
    await refresh();
  }
  /**
   * `quiet` skips the refresh so a confirmed photo does not re-fetch the whole
   * home screen once per item — the proposal loop refreshes once when it is
   * finished. The result is returned either way, because the caller needs to
   * know whether something was already in.
   */
  async function addItem(section, name, { quiet = false } = {}) {
    const result = await api.addItem(token, KITCHEN_SLUG, section, name);
    if (!quiet) await refresh();
    return result;
  }

  async function scanPhoto(image, mediaType) {
    return api.scanPhoto(token, KITCHEN_SLUG, image, mediaType);
  }
  async function useItem(section, name) {
    await api.useItem(token, KITCHEN_SLUG, section, name);
    await refresh();
  }

  return (
    <div className="home">
      <header className="home__head">
        <h1 className="home__title">Vesta</h1>
        <div className="home__who">
          <span>{data.label}</span>
          <button className="btn btn--quiet" onClick={onSignedOut}>Sign out</button>
        </div>
      </header>

      {/* A refresh that failed while we still have the last good screen: say so
          rather than either blanking it or pretending it is current. */}
      {error && <p className="home__stale" role="status">{error} Showing what I last had.</p>}

      <Tasks tasks={data.tasks} gap={gapFor('tasks')} people={data.people || []} onAdd={addTask} onUpdate={updateTask} />

      {can('calendar') && (
        <Calendar events={data.calendar} gap={gapFor('calendar')} todayKey={data.calendarDate} />
      )}

      {can('kitchen') && (
        kitchenMissing ? (
          <section className="section">
            <header className="section__head"><h2 className="section__title">The kitchen</h2></header>
            <p className="section__empty">
              There&rsquo;s no kitchen list yet. Nick needs to make one and share it &mdash;
              until then there&rsquo;s nothing here for me to show.
            </p>
          </section>
        ) : (
          <>
            <Kitchen
              sections={data.kitchenSections}
              items={data.kitchen}
              gap={kitchenGap}
              photo={data.photo === true}
              onAdd={addItem}
              onUse={useItem}
              onScan={scanPhoto}
              onRefresh={refresh}
            />
            <Meals meals={data.meals} />
          </>
        )
      )}

      <footer className="home__foot">
        <button className="btn btn--quiet" onClick={refresh}>Refresh</button>
        <span className="home__build">{api.BUILD_LABEL}</span>
      </footer>
    </div>
  );
}
