'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
// Phase 3: Anthropic removed. Uses AI provider for fallback.
const obsidian = require('../services/obsidian');
const nudges = require('../services/nudges');
const db = require('../db/database');
const { VOICE_COMPACT } = require('../services/sara-voice');

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '';

// ── Journal pre-warm cache ──────────────────────────────────────────────
const journalCache = {
  date: null,
  prompts: null,
  warming: false,
};

const FALLBACK_PROMPTS = [
  "What was the one thing that actually mattered today?",
  "How are you feeling right now, honestly?",
  "What would you do differently tomorrow?"
];

// Build journal context from daily note + health/strava/location
async function buildJournalContext() {
  let contextSummary = 'No daily note found for today.';
  try {
    const dailyNote = obsidian.readTodayDailyNote();
    if (dailyNote) {
      const lines = dailyNote.split('\n');
      const relevant = [];
      let inSection = false;
      const SECTIONS = ['Focus Today', 'Wins Today', 'EOD', 'Calendar', 'Meetings'];
      for (const line of lines) {
        if (line.startsWith('## ')) {
          inSection = SECTIONS.some(s => line.includes(s));
        }
        if (inSection && line.trim() && !line.startsWith('```')) {
          relevant.push(line);
        }
      }
      if (relevant.length > 0) contextSummary = relevant.slice(0, 20).join('\n');
    }
  } catch {}

  try {
    const stravaService = require('../services/strava');
    if (stravaService.isConfigured() && stravaService.isAuthenticated()) {
      const activityCtx = await stravaService.getActivityContext();
      if (activityCtx) {
        contextSummary = contextSummary === 'No daily note found for today.'
          ? activityCtx : contextSummary + '\n\n' + activityCtx;
      }
    }
  } catch {}

  try {
    const healthService = require('../services/health');
    const healthSummary = healthService.getHealthSummaryForJournal();
    if (healthSummary) {
      contextSummary = contextSummary === 'No daily note found for today.'
        ? healthSummary : contextSummary + '\n\n' + healthSummary;
    }
  } catch {}

  try {
    const locationService = require('../services/location');
    if (locationService.isConfigured()) {
      const locationSummary = await locationService.getLocationSummaryForJournal();
      if (locationSummary) {
        contextSummary = contextSummary === 'No daily note found for today.'
          ? locationSummary : contextSummary + '\n\n' + locationSummary;
      }
    }
  } catch {}

  return contextSummary;
}

// Generate prompts from context via the AI router.
//
// This is one of the three places SARA talks to Nick about his day, and it was
// the one with no voice at all — a task description that could have been written
// for any assistant. The questions are hers, so she writes them as herself.
async function generatePrompts(contextSummary) {
  const journalPromptText = `${VOICE_COMPACT}

Nick journals in the evening to process his day. Write exactly 3 prompts for tonight.

Rules:
- Each prompt is a single question, max 15 words. Never stack two.
- Be specific to today's context — a question he could only be asked tonight beats a good generic one.
- If Strava/health data is present, reference his physical state in one.
- If location data shows somewhere unusual, ask about it.
- Vary the focus: one on the work, one on how he's doing, one on what's next.
- Ask, don't counsel. No "take a moment to reflect on", no gratitude exercises.
- Output ONLY the 3 questions, one per line, nothing else.

Today's context:
${contextSummary}`;

  // One routed call, not a hand-rolled Ollama fetch followed by a SECOND,
  // differently-worded cloud prompt. Two prompts for one feature is two voices
  // for one feature, and only one of them ever got edited. journal_prompts is
  // not latency-sensitive, so the router still tries local Ollama first — the
  // policy is unchanged, it is just no longer bypassed.
  try {
    const aiProvider = require('../services/ai-provider');
    const result = await aiProvider.generateJournalPrompts(journalPromptText);
    if (result?.text) {
      const prompts = result.text.split('\n')
        .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
        .filter(l => l.length > 5 && l.endsWith('?'))
        .slice(0, 3);
      if (prompts.length === 3) {
        console.log(`[Journal] Prompts generated via ${result.provider}`);
        return prompts;
      }
    }
  } catch (err) {
    console.warn('[Journal] Prompt generation failed:', err.message);
  }

  return null;
}

async function preWarmJournal() {
  const todayStr = obsidian.todayDateString();
  if (journalCache.date === todayStr && journalCache.prompts) {
    console.log('[Journal] Pre-warm skipped — already cached for today');
    return;
  }
  if (journalCache.warming) {
    console.log('[Journal] Pre-warm already in progress');
    return;
  }

  journalCache.warming = true;
  console.log('[Journal] Pre-warming prompts for', todayStr);

  try {
    const contextSummary = await buildJournalContext();
    const prompts = await generatePrompts(contextSummary);
    if (prompts) {
      journalCache.date = todayStr;
      journalCache.prompts = prompts;
      console.log(`[Journal] Pre-warm complete — ${prompts.length} prompts cached`);
    } else {
      console.warn('[Journal] Pre-warm failed — no prompts generated');
    }
  } catch (err) {
    console.error('[Journal] Pre-warm failed:', err.message);
  } finally {
    journalCache.warming = false;
  }
}

router.preWarmJournal = preWarmJournal;

// POST /api/journal/pre-warm — manually trigger journal pre-warm
router.post('/pre-warm', async (req, res) => {
  try {
    preWarmJournal();
    res.json({ ok: true, message: 'Journal pre-warm started' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/journal/prompts — get tonight's 3 journal prompts
router.get('/prompts', async (req, res) => {
  try {
    const todayStr = obsidian.todayDateString();
    const journalPath = path.join(VAULT_PATH, 'Reflections', `${todayStr}-journal.md`);
    const alreadyDone = fs.existsSync(journalPath);

    // Check cache first
    if (journalCache.date === todayStr && journalCache.prompts) {
      console.log('[Journal] Serving pre-warmed prompts');
      return res.json({ prompts: journalCache.prompts, alreadyDone, date: todayStr });
    }

    // Cache miss — generate live
    const contextSummary = await buildJournalContext();
    const prompts = await generatePrompts(contextSummary);

    // Cache the result for subsequent requests
    if (prompts) {
      journalCache.date = todayStr;
      journalCache.prompts = prompts;
    }

    res.json({
      prompts: prompts || FALLBACK_PROMPTS,
      alreadyDone,
      date: todayStr
    });
  } catch (e) {
    console.error('[Journal] Prompts error:', e.message);
    res.json({
      prompts: FALLBACK_PROMPTS,
      alreadyDone: false,
      date: obsidian.todayDateString()
    });
  }
});

// POST /api/journal/save — save completed journal to vault
router.post('/save', (req, res) => {
  try {
    const { entries, date } = req.body;
    // entries: [{ prompt: '...', response: '...' }, ...]
    if (!entries || !Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ error: 'entries array required' });
    }

    const todayStr = date || obsidian.todayDateString();
    const d = new Date();
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

    const content = `---
type: reflection
subtype: journal
date: ${todayStr}
---
# Evening Journal — ${todayStr}

*Written at ${timeStr}*

${entries.map(e => `## ${e.prompt}\n\n${e.response}`).join('\n\n---\n\n')}
`;

    const reflectionsDir = path.join(VAULT_PATH, 'Reflections');
    if (!fs.existsSync(reflectionsDir)) fs.mkdirSync(reflectionsDir, { recursive: true });

    const journalPath = path.join(reflectionsDir, `${todayStr}-journal.md`);
    fs.writeFileSync(journalPath, content, 'utf-8');

    nudges.markJournalDone();
    console.log(`[Journal] Saved: ${journalPath}`);
    res.json({ success: true, path: journalPath });
  } catch (e) {
    console.error('[Journal] Save error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/journal/settings — get current journal time setting
router.get('/settings', (req, res) => {
  const time = db.getState('journal_nudge_time') || '21:00';
  res.json({ nudgeTime: time });
});

// POST /api/journal/settings — update journal time
router.post('/settings', (req, res) => {
  const { nudgeTime } = req.body;
  if (!nudgeTime || !/^\d{2}:\d{2}$/.test(nudgeTime)) {
    return res.status(400).json({ error: 'nudgeTime required in HH:MM format' });
  }
  db.setState('journal_nudge_time', nudgeTime);
  res.json({ success: true, nudgeTime });
});

module.exports = router;
