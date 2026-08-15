const express = require('express');
const router = express.Router();
const microsoft = require('../services/microsoft');

// GET /api/microsoft/status
router.get('/status', async (req, res) => {
  const configured = microsoft.isConfigured();
  const authenticated = configured ? await microsoft.isAuthenticated() : false;
  const bridgeConfigured = microsoft.isBridgeConfigured();
  let bridgeConnected = false;
  if (bridgeConfigured && !authenticated) {
    // Check if bridge is reachable by testing a lightweight call
    try {
      const result = await microsoft.fetchCalendarEvents();
      bridgeConnected = result !== null;
    } catch { bridgeConnected = false; }
  }
  res.json({ configured, authenticated, bridgeConfigured, bridgeConnected });
});

// GET /api/microsoft/teams-send-status — is the Teams DM path live, or what is
// it waiting on? An unconsented scope is a normal, silent state (Q8); this makes
// it inspectable, which is exactly what NOVA's Teams path lacked while it sat
// dead for months looking built.
router.get('/teams-send-status', async (req, res) => {
  try {
    res.json(await require('../services/teams').getSendStatus());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/microsoft/auth — start device code flow for Graph permissions
router.post('/auth', async (req, res) => {
  if (!microsoft.isConfigured()) {
    return res.status(400).json({ error: 'NOVA token cache not found' });
  }

  try {
    const result = await microsoft.startDeviceCodeFlow();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/calendar
router.get('/calendar', async (req, res) => {
  const { start, end } = req.query;
  try {
    const events = await microsoft.fetchCalendarEvents(start, end);
    res.json({ events: events || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/inbox — flagged items from inbox scanner
router.get('/inbox', (req, res) => {
  const scanner = require('../services/inbox-scanner');
  res.json(scanner.getFlaggedItems());
});

// POST /api/microsoft/inbox/scan — trigger manual scan
router.post('/inbox/scan', async (req, res) => {
  const scanner = require('../services/inbox-scanner');
  scanner.scanInbox(); // fire and forget
  res.json({ success: true, message: 'Scan started' });
});

// POST /api/microsoft/inbox/dismiss — dismiss a single inbox item
router.post('/inbox/dismiss', (req, res) => {
  const { emailId } = req.body;
  if (!emailId) return res.status(400).json({ error: 'emailId required' });
  const scanner = require('../services/inbox-scanner');
  scanner.dismissItem(emailId);
  try { require('../services/activity').trackNudgeDismiss('inbox'); } catch {}
  res.json({ success: true });
});

// GET /api/microsoft/planner/tasks — fetch Planner tasks
router.get('/planner/tasks', async (req, res) => {
  try {
    const tasks = await microsoft.fetchPlannerTasks();
    res.json({ tasks: tasks || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/todo/lists — fetch To-Do task lists
router.get('/todo/lists', async (req, res) => {
  try {
    const lists = await microsoft.fetchTodoLists();
    res.json({ lists: lists || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/microsoft/todo/tasks?listId=xxx — fetch To-Do tasks
router.get('/todo/tasks', async (req, res) => {
  try {
    const { listId } = req.query;
    if (!listId) return res.status(400).json({ error: 'listId required' });
    const tasks = await microsoft.fetchTodoTasks(listId);
    res.json({ tasks: tasks || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/microsoft/todo/tasks — create a To-Do task
router.post('/todo/tasks', async (req, res) => {
  try {
    const { listId, title, body } = req.body;
    if (!listId || !title) return res.status(400).json({ error: 'listId and title required' });
    const result = await microsoft.createTodoTask(listId, title, body);
    if (!result) return res.status(502).json({ error: 'Bridge unavailable' });
    res.json({ ok: true, task: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/microsoft/todo/tasks/:taskId — update a To-Do task
router.patch('/todo/tasks/:taskId', async (req, res) => {
  try {
    const { listId, ...updates } = req.body;
    if (!listId) return res.status(400).json({ error: 'listId required in body' });
    const result = await microsoft.updateTodoTask(req.params.taskId, listId, updates);
    if (!result) return res.status(502).json({ error: 'Bridge unavailable' });
    res.json({ ok: true, task: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/microsoft/planner/tasks/:taskId — update a Planner task
router.patch('/planner/tasks/:taskId', async (req, res) => {
  try {
    const result = await microsoft.updatePlannerTask(req.params.taskId, req.body);
    if (!result) return res.status(502).json({ error: 'Bridge unavailable' });
    res.json({ ok: true, task: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/microsoft/tasks/sync — sync MS tasks to Obsidian vault
router.post('/tasks/sync', async (req, res) => {
  try {
    const obsidian = require('../services/obsidian');
    const result = await obsidian.syncMicrosoftTasks();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
