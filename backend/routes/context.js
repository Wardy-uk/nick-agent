const express = require('express');
const router = express.Router();
const db = require('../db/database');
const obsidian = require('../services/obsidian');

// GET /api/context — returns all live context in one call (for n8n agent)
router.get('/', (req, res) => {
  const result = {};
  const weekend = new Date().getDay() === 0 || new Date().getDay() === 6;
  result.weekend = weekend;

  // Daily note
  try {
    result.dailyNote = obsidian.readTodayDailyNote();
    result.date = obsidian.todayDateString();
  } catch (e) {
    result.dailyNote = null;
  }

  // Standup
  try {
    result.standup = obsidian.readStandup();
  } catch (e) {
    result.standup = null;
  }

  // Todos
  try {
    const { active } = obsidian.parseVaultTodos();
    result.todos = active.slice(0, 15); // top 15 active
  } catch (e) {
    result.todos = [];
  }

  // Inbox triage
  try {
    const inbox = require('../services/email-triage').getFlaggedItems();
    result.inbox = inbox.items.slice(0, 10);
  } catch (e) {
    result.inbox = [];
  }

  // 90-day plan summary
  if (!weekend) {
    try {
      const plan = obsidian.parseNinetyDayPlan();
      if (plan) {
        result.ninetyDayPlan = {
          currentDay: plan.currentDay,
          totalDone: plan.totalDone,
          totalTasks: plan.totalTasks,
          nextCheckpoint: plan.nextCheckpoint,
          daysToCheckpoint: plan.daysToCheckpoint,
          overdueTasks: plan.overdueTasks.slice(0, 5),
          todayTasks: plan.todayTasks
        };
      }
    } catch (e) {
      result.ninetyDayPlan = null;
    }
  }

  // Day count
  const startDate = new Date('2026-03-16');
  const today = new Date();
  result.dayCount = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));

  res.json(result);
});

module.exports = router;
