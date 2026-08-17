import { apiFetch } from './api';

// Completing a task means different things depending on who owns it, and there
// are three owners. Getting this wrong is silent: posting a null filePath to
// /api/todos/toggle just 400s and the task stays open.
//
//   task_id            → NEURO owns it (the tasks table, source of truth)
//   ms_id              → Microsoft owns it; Graph push + vault mirror toggle
//   filePath+lineNumber → a plain vault checkbox (daily notes, 90-day plan)
//
// Checked in that order: a NEURO task can also carry ms_id, and the task store
// is the record that matters.
/**
 * What the day comes to, asked for straight after a completion lands.
 *
 * This is the immediacy half of the wins work. The ledger made the count TRUE;
 * this is what makes it arrive at the moment rather than in a panel Nick has to
 * remember to open — which is the difference between a scoreboard and a reward.
 *
 * Deliberately a second request rather than a field on the completion response:
 * there are three completion routes with three different owners, and threading
 * the same payload through all of them is how they drift. /api/wins folds a
 * trailing window on read, so the task just closed is already in it.
 *
 * NEVER allowed to fail the completion. The task IS closed by the time this
 * runs; a bookkeeping error must not surface as "that didn't work" and send
 * Nick back to tick it again. Same rule as sent-replies recording after a mail
 * has already left.
 */
async function _headlineAfterCompletion() {
  try {
    // The WORDS come from the server (wins.headline), not from here. The nudge
    // and this both say what today came to, and two copies of the phrasing is
    // how they end up disagreeing about it.
    const data = await apiFetch('/api/wins');
    return data?.headline || null;
  } catch {
    return null;
  }
}

export async function completeTask(item) {
  if (!item) throw new Error('No task given');

  if (item.task_id) {
    await apiFetch(`/api/tasks/${item.task_id}/complete`, { method: 'POST' });
    // A NEURO task that mirrors a Microsoft one still has to be closed there,
    // or the next sync brings it straight back.
    if (item.ms_id) {
      await apiFetch('/api/todos/complete-ms', {
        method: 'POST',
        body: JSON.stringify({
          msId: item.ms_id,
          source: item.source,
          filePath: item.filePath,
          lineNumber: item.lineNumber,
        }),
      }).catch(() => {}); // local completion already landed; don't undo it
    }
    return _headlineAfterCompletion();
  }

  if (item.ms_id) {
    await apiFetch('/api/todos/complete-ms', {
      method: 'POST',
      body: JSON.stringify({
        msId: item.ms_id,
        source: item.source,
        filePath: item.filePath,
        lineNumber: item.lineNumber,
      }),
    });
    return _headlineAfterCompletion();
  }

  if (item.filePath && item.lineNumber != null) {
    await apiFetch('/api/todos/toggle', {
      method: 'POST',
      body: JSON.stringify({ filePath: item.filePath, lineNumber: item.lineNumber }),
    });
    return _headlineAfterCompletion();
  }

  throw new Error('This task has no id NEURO can complete');
}
