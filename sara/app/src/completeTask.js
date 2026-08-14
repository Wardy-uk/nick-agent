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
    return;
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
    return;
  }

  if (item.filePath && item.lineNumber != null) {
    await apiFetch('/api/todos/toggle', {
      method: 'POST',
      body: JSON.stringify({ filePath: item.filePath, lineNumber: item.lineNumber }),
    });
    return;
  }

  throw new Error('This task has no id NEURO can complete');
}
