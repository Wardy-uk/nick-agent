const cron = require('node-cron');
const nudges = require('./nudges');
const jira = require('./jira');
const imports = require('./imports');

function start() {
  // Fire nudges immediately if server starts after 9am on a weekday
  nudges.startupCheck();

  // Check 1-2-1s on startup too
  nudges.check121Nudges();

  // Check plan milestone on startup too (in case server was restarted on the milestone day)
  nudges.checkPlanMilestoneNudge();

  // Start Jira polling (fetches on startup + every 5 min)
  jira.startPolling();

  // Make sure the capture drop-box exists, and drain anything written while the
  // backend was down — that is the whole point of the file surviving an outage.
  try {
    require('./task-capture-drain').ensureCaptureFile();
    require('./task-capture-drain').drainCaptureFile({ force: true });
  } catch (e) {
    console.error('[Scheduler] Capture drain on startup failed:', e.message);
  }

  // 8:55am weekdays — pre-warm standup questions
  cron.schedule('55 8 * * 1-5', () => {
    console.log('[Scheduler] 8:55am — pre-warming standup');
    try {
      const standupRouter = require('../routes/standup');
      if (standupRouter.preWarmStandup) standupRouter.preWarmStandup();
      if (standupRouter.preWarmStandupQuestions) standupRouter.preWarmStandupQuestions();
    } catch (e) { console.error('[Scheduler] Pre-warm error:', e.message); }
  });

  // 4:55pm weekdays — pre-warm EOD questions
  cron.schedule('55 16 * * 1-5', () => {
    console.log('[Scheduler] 4:55pm — pre-warming EOD');
    try {
      const standupRouter = require('../routes/standup');
      if (standupRouter.preWarmEod) standupRouter.preWarmEod();
      if (standupRouter.preWarmEodQuestions) standupRouter.preWarmEodQuestions();
    } catch (e) { console.error('[Scheduler] EOD pre-warm error:', e.message); }
  });

  // 9am weekdays — trigger standup and todo nudges
  cron.schedule('0 9 * * 1-5', () => {
    console.log('[Scheduler] 9am — triggering standup + todo nudges');
    nudges.triggerStandupNudge();
    nudges.triggerTodoNudge();
  });

  // 8:45am weekdays — early standup nudge if configured via insights suggestion
  cron.schedule('45 8 * * 1-5', () => {
    try {
      const db = require('../db/database');
      const customHour = db.getState('standup_nudge_hour');
      if (customHour && parseInt(customHour, 10) < 9) {
        console.log('[Scheduler] Early standup nudge (custom time)');
        nudges.triggerStandupNudge();
      }
    } catch {}
  });

  // 9:10am weekdays — check 1-2-1 due dates
  cron.schedule('10 9 * * 1-5', () => { nudges.check121Nudges(); });

  // Every 15 minutes between 9am-5pm weekdays — nag if not done
  cron.schedule('*/15 9-17 * * 1-5', () => {
    nudges.nagCheck();
  });

  // Daily at 9:05am — check plan milestone (75% reminder)
  cron.schedule('5 9 * * 1-5', () => {
    nudges.checkPlanMilestoneNudge();
  });

  // 5pm weekdays — trigger EOD nudge
  cron.schedule('0 17 * * 1-5', () => {
    console.log('[Scheduler] 5pm — triggering EOD nudge');
    nudges.triggerEodNudge();
  });

  // Training matrix sync is owned by n8n ("Training Matrix Sync" workflow) —
  // it fetches NOVA /api/public/training-export and POSTs to NEURO
  // /api/training/apply-matrix. No NEURO-side cron needed.

  // Friday 4:30pm — generate weekly review
  cron.schedule('30 16 * * 5', () => {
    try {
      const obsidian = require('./obsidian');
      const result = obsidian.generateWeeklyReview();
      if (result && !result.skipped) {
        require('./webpush').sendToAll('NEURO — Weekly Review',
          `Your ${result.weekStr} review is ready in Reflections. Take 5 minutes to fill in wins, challenges, and how you're feeling.`,
          { type: 'weekly_review', url: '/vault' }).catch(() => {});
      }
    } catch (e) { console.error('[Scheduler] Weekly review failed:', e.message); }
  });

  // Friday 4:35pm — weekly vault-hygiene pass (READ-ONLY): refresh the lint audit
  // and contextual-link cards so they're ready to review/approve. Never applies.
  cron.schedule('35 16 * * 5', () => {
    try {
      const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultRoot) return;
      const hygiene = require('./vault-hygiene');
      const lintRes = hygiene.lint(vaultRoot);
      const planRes = hygiene.contextualLinkPlan(vaultRoot);
      console.log(`[Scheduler] Weekly hygiene: ${lintRes.broken.length} broken, ${lintRes.orphans.length} orphans; ${planRes.total} link cards across ${planRes.notesTouched} notes.`);
      if (planRes.total > 0 || lintRes.broken.length > 0) {
        require('./webpush').sendToAll('NEURO — Vault Hygiene',
          `${lintRes.broken.length} broken links, ${lintRes.orphans.length} orphans, ${planRes.total} link cards to review in Vault Audit.`,
          { type: 'vault_hygiene', url: '/vault' }).catch(() => {});
      }
    } catch (e) { console.error('[Scheduler] Weekly hygiene failed:', e.message); }
  });

  // Nightly 2:30am — hygiene sweep (APPLY): content-safe Summary-N dedup, collect
  // unnamed "Speaker N" recordings into the Orphan hub, archive empty stragglers.
  // All mutations are reversible (archive + backups) and reported to Vault Audit.
  cron.schedule('30 2 * * *', () => {
    try {
      const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultRoot) return;
      const r = require('./vault-hygiene').nightlySweep(vaultRoot, { apply: true });
      console.log(`[Scheduler] Nightly sweep: ${r.dedup.dropped.length} duplicate summaries archived, ${r.orphans.collected.length} unnamed recordings collected, ${r.empties.archived.length} empty recordings archived. Report: ${r.reportPath}`);
    } catch (e) { console.error('[Scheduler] Nightly sweep failed:', e.message); }
  });

  // Monday 8:10am — generate a knowledge reflection brief for the week ahead
  cron.schedule('10 8 * * 1', () => {
    try {
      const result = require('./knowledge-memory').generateReflection({ write: true });
      if (result?.path) {
        require('./webpush').sendToAll(
          'NEURO — Knowledge Reflection',
          'Your latest knowledge reflection is ready. Review what to promote before the week drifts.',
          { type: 'knowledge_reflection', url: '/insights' }
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[Scheduler] Knowledge reflection failed:', e.message);
    }
  });

  // Weekdays 10 minutes after the main intake cycles — consolidate raw intake into working notes
  cron.schedule('40 * * * 1-5', () => {
    require('./knowledge-memory').consolidateAllImports({ limit: 30 }).catch((e) => {
      console.error('[Scheduler] Import consolidation failed:', e.message);
    });
  });

  // 10pm nightly — build daily activity summary + entity extraction + write observations
  cron.schedule('0 22 * * *', () => {
    console.log('[Scheduler] Running nightly activity rollup...');
    try {
      require('./activity').runNightlyRollup();
    } catch (e) {
      console.error('[Scheduler] Activity rollup failed:', e.message);
    }
    // Meeting-action extraction. Embeddings (2am) and entity extraction (below)
    // both had nightly jobs; action extraction never did — it only ran from
    // vault-hooks.onVaultWrite(), which never fires for notes Syncthing delivers
    // from Obsidian. So nothing was ever proposed from Nick's own meeting notes.
    // Scoped to Meetings/ and review-only: nothing reaches Master Todo without
    // being approved from the suggestions queue.
    try {
      const scan = require('./action-candidates').scanRecentNotes({ days: 7, dryRun: false, scope: 'meetings', limit: 500 });
      console.log(`[Scheduler] Meeting actions: scanned ${scan.scanned}, created ${scan.created}, pending ${scan.pending}, superseded ${scan.superseded}`);
      if (scan.pending > 0) {
        require('./webpush').sendToAll('NEURO — Actions to review',
          `${scan.pending} new action${scan.pending === 1 ? '' : 's'} from your meetings need a yes/no.`,
          { type: 'todo', url: '/todos' }).catch(() => {});
      }
    } catch (e) {
      console.error('[Scheduler] Meeting action scan failed:', e.message);
    }
    try {
      const result = require('./entities').processRecentNotes(7);
      console.log(`[Scheduler] Entity extraction: ${result.processed} notes processed`);
    } catch (e) {
      console.error('[Scheduler] Entity extraction failed:', e.message);
    }
    // Re-detect 1-2-1s from the meeting notes Syncthing delivered today and stamp
    // People frontmatter. Before this, `last-1-2-1` was hand-maintained and froze
    // in March while 1-2-1s carried on happening, so the Team board showed people
    // 100+ days overdue who had been seen in July.
    try {
      const sync = require('./one-to-one-detect').syncPeopleNotes({ apply: true });
      const updated = (sync.changes || []).filter(c => c.action === 'updated');
      if (updated.length) {
        console.log(`[Scheduler] 1-2-1 sync: ${updated.length} person note(s) updated — ` +
          updated.map(c => `${c.person} → ${c.to}`).join(', '));
      }
    } catch (e) {
      console.error('[Scheduler] 1-2-1 sync failed:', e.message);
    }
    // People gap — nothing else in NEURO ever proposed a People note, so the
    // roster only grew when Nick typed one in and every consumer keyed off it
    // stayed capped. READ-ONLY: reports to Vault Audit, creation is an explicit
    // POST /api/people-gap/apply.
    try {
      const gap = require('./people-gap').runNightlyScan({ days: 90 });
      if (gap.status === 'ok') {
        console.log(`[Scheduler] People gap: ${gap.candidates.length} candidates, ${gap.belowThreshold.length} seen once`);
        if (gap.candidates.length > 0) {
          require('./webpush').sendToAll('NEURO — People notes',
            `${gap.candidates.length} ${gap.candidates.length === 1 ? 'person has' : 'people have'} no People note. Review in Vault Audit.`,
            { type: 'vault_hygiene', url: '/people' }).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[Scheduler] People gap scan failed:', e.message);
    }
    // Write working memory observations to daily note
    try {
      require('./working-memory').writeObservationsToDaily();
    } catch (e) {
      console.error('[Scheduler] Observation write failed:', e.message);
    }
    // Record today's location dwells to history
    try {
      require('./location-history').recordTodaysDwells();
    } catch (e) {
      console.error('[Scheduler] Location recording failed:', e.message);
    }
  });

  // Every 10 minutes — drain the Obsidian capture drop-box (route 3) into the task
  // store. Cheap: it reads one small file and returns immediately when empty. The
  // drain is what stops Tasks/Capture.md turning into a second source of truth.
  cron.schedule('*/10 * * * *', () => {
    try {
      const result = require('./task-capture-drain').drainCaptureFile();
      if (result.created || result.folded) {
        console.log(`[Scheduler] Capture drained: ${result.created} new, ${result.folded} folded`);
      }
    } catch (e) {
      console.error('[Scheduler] Capture drain failed:', e.message);
    }
  });

  // Hourly — regenerate the read-only task export note. Writes already trigger an
  // export; this is the belt-and-braces pass so the "last exported" stamp in the vault
  // stays current, which is what tells Nick whether the offline copy can be trusted.
  cron.schedule('20 * * * *', () => {
    try {
      require('./task-export').writeExport();
    } catch (e) {
      console.error('[Scheduler] Task export failed:', e.message);
    }
  });

  // Record location dwells every 30 min during active hours (9am-9pm)
  cron.schedule('*/30 9-21 * * *', () => {
    try {
      require('./location-history').recordTodaysDwells();
    } catch {}
  });

  // Evening journal nudge — time configurable via agent_state 'journal_nudge_time' (default '21:00')
  // Pre-warm fires 5 minutes before the configured journal time
  cron.schedule('* 20-22 * * *', () => {
    try {
      const db = require('../db/database');
      const configuredTime = db.getState('journal_nudge_time') || '21:00';
      const [targetHour, targetMin] = configuredTime.split(':').map(Number);
      const now = new Date();

      // Pre-warm journal prompts 5 min before nudge
      let preWarmHour = targetHour, preWarmMin = targetMin - 5;
      if (preWarmMin < 0) { preWarmMin += 60; preWarmHour -= 1; }
      if (now.getHours() === preWarmHour && now.getMinutes() === preWarmMin) {
        console.log('[Scheduler] Pre-warming journal prompts');
        try {
          const journalRouter = require('../routes/journal');
          if (journalRouter.preWarmJournal) journalRouter.preWarmJournal();
        } catch (e) { console.error('[Scheduler] Journal pre-warm error:', e.message); }
      }

      if (now.getHours() === targetHour && now.getMinutes() === targetMin) {
        nudges.triggerJournalNudge();
      }
    } catch (e) {
      console.error('[Scheduler] Journal nudge check failed:', e.message);
    }
  });

  // 2am nightly — rebuild vault embeddings for changed files
  cron.schedule('0 2 * * *', () => {
    console.log('[Scheduler] Rebuilding vault embeddings...');
    try {
      require('./embeddings').rebuildEmbeddings().catch(e => {
        console.error('[Scheduler] Embedding rebuild failed:', e.message);
      });
    } catch (e) {
      console.error('[Scheduler] Failed to start embedding rebuild:', e.message);
    }
  });

  // Hourly imports sweep — classify and auto-route pending imports
  cron.schedule('30 * * * *', () => {
    console.log('[Scheduler] Running hourly imports sweep...');
    imports.autoClassify().catch(e => {
      console.error('[Scheduler] Imports sweep failed:', e.message);
    });
  });

  // 6:10pm daily — write a human-readable import activity report into the vault
  cron.schedule('10 18 * * *', () => {
    try {
      require('./knowledge-memory').writeDailyImportReport();
    } catch (e) {
      console.error('[Scheduler] Daily import report failed:', e.message);
    }
  });

  // Startup health check — verify capture system is working
  setTimeout(() => {
    const fs = require('fs');
    const path = require('path');
    const vaultPath = process.env.OBSIDIAN_VAULT_PATH || '';
    const importsDir = path.join(vaultPath, 'Imports');
    const issues = [];
    if (!vaultPath) issues.push('OBSIDIAN_VAULT_PATH not set');
    else if (!fs.existsSync(vaultPath)) issues.push('Vault path does not exist');
    if (!fs.existsSync(importsDir)) issues.push('Imports/ directory missing');
    else {
      try {
        const testFile = path.join(importsDir, '.neuro-health-check');
        fs.writeFileSync(testFile, 'ok');
        fs.unlinkSync(testFile);
      } catch (e) { issues.push('Imports/ not writable: ' + e.message); }
    }
    if (issues.length > 0) {
      console.error('[Health] Capture system BROKEN:', issues.join(', '));
      try {
        require('./webpush').sendToAll(
          'NEURO — System Alert',
          `Capture is broken: ${issues.join(', ')}. Notes will not save.`,
          { type: 'system_alert' }
        ).catch(() => {});
      } catch {}
    } else {
      console.log('[Health] Capture system OK — vault writable');
    }
  }, 15000);

  // ── Agent Loop — Phase 6A ──
  // Every 10 minutes during work hours: evaluate state, run safe auto-actions, pre-compute next action
  cron.schedule('*/10 8-18 * * 1-5', () => {
    const agentLoop = require('./agent-loop');
    agentLoop.runCycle().catch(e => {
      console.error('[Scheduler] Agent loop failed:', e.message);
    });
  });

  // Startup agent loop — run 45s after start to let other services init first
  setTimeout(() => {
    const agentLoop = require('./agent-loop');
    agentLoop.runCycle().catch(e => {
      console.error('[Scheduler] Startup agent loop failed:', e.message);
    });
  }, 45000);

  // Startup embedding check — rebuild 2 min after start
  setTimeout(() => {
    console.log('[Scheduler] Startup embedding check...');
    require('./embeddings').rebuildEmbeddings().catch(e => {
      console.error('[Scheduler] Startup embedding failed:', e.message);
    });
  }, 2 * 60 * 1000);

  // Startup sweep — classify pending imports after 60s delay
  setTimeout(() => {
    const pending = imports.getPending().filter(f => f.status !== 'needs-review');
    if (pending.length > 0) {
      console.log(`[Scheduler] ${pending.length} pending imports — running startup sweep...`);
      imports.autoClassify().catch(e => {
        console.error('[Scheduler] Startup imports sweep failed:', e.message);
      });
    }
  }, 60 * 1000);

  // Startup consolidation + operating model doc — after intake has settled
  setTimeout(() => {
    require('./knowledge-memory').ensureVaultOperatingModelDoc();
    require('./knowledge-memory').consolidateAllImports({ limit: 30 }).catch((e) => {
      console.error('[Scheduler] Startup import consolidation failed:', e.message);
    });
  }, 90 * 1000);

  // Every 30 minutes 8am-6pm — sync Plaud via official MCP
  cron.schedule('*/30 8-18 * * *', () => {
    console.log('[Scheduler] Syncing Plaud via MCP...');
    require('./plaud-sync').syncPlaudRecordings({ incremental: true }).catch(e => {
      console.error('[Scheduler] Plaud MCP sync failed:', e.message);
    });
  });

  // Startup Plaud sync — after 45s delay
  setTimeout(() => {
    console.log('[Scheduler] Startup Plaud MCP sync...');
    require('./plaud-sync').syncPlaudRecordings({ incremental: true }).catch(e => {
      console.error('[Scheduler] Startup Plaud MCP sync failed:', e.message);
    });
  }, 45 * 1000);

  // Every 30 minutes 8am-6pm weekdays — sync Microsoft Tasks (Planner + ToDo) to vault
  cron.schedule('15,45 8-18 * * 1-5', () => {
    console.log('[Scheduler] Syncing Microsoft Tasks...');
    require('./obsidian').syncMicrosoftTasks().catch(e => {
      console.error('[Scheduler] MS Tasks sync failed:', e.message);
    });
  });

  // Startup MS Tasks sync — 30s after start
  setTimeout(() => {
    console.log('[Scheduler] Startup MS Tasks sync...');
    require('./obsidian').syncMicrosoftTasks().catch(e => {
      console.error('[Scheduler] Startup MS Tasks sync failed:', e.message);
    });
  }, 30 * 1000);

  // Escalation queue watcher — check every 5 minutes during work hours
  cron.schedule('*/5 8-18 * * 1-5', () => {
    jira.syncEscalations().catch(e => {
      console.error('[Scheduler] Escalation sync failed:', e.message);
    });
  });

  // Startup escalation check — after 30s delay
  setTimeout(() => {
    jira.syncEscalations().catch(e => {
      console.error('[Scheduler] Startup escalation sync failed:', e.message);
    });
  }, 30000);

  // Email triage — run at 8am, 12pm, 5pm weekdays
  cron.schedule('0 8,12,17 * * 1-5', () => {
    require('./email-triage').runTriage().catch(e => {
      console.error('[Scheduler] Email triage failed:', e.message);
    });
  });

  // Startup triage after 60s
  setTimeout(() => {
    require('./email-triage').runTriage().catch(() => {});
  }, 60000);

  // Meeting prep push — check every 5 minutes 8am-6pm weekdays
  cron.schedule('*/5 8-18 * * 1-5', async () => {
    try {
      await require('./meeting-prep').checkUpcomingMeetings();
    } catch (e) {
      console.error('[Scheduler] Meeting prep check failed:', e.message);
    }
  });

  // ── Proactive briefings ──────────────────────────────────────────────────

  // 9am Mon-Fri — morning brief
  cron.schedule('0 9 * * 1-5', async () => {
    console.log('[Scheduler] 9am — morning brief');
    try {
      await require('./briefing').buildAndDeliver({ label: 'morning' });
    } catch (e) { console.error('[Scheduler] Morning brief failed:', e.message); }
  });

  // 1pm Mon-Fri — midday brief
  cron.schedule('0 13 * * 1-5', async () => {
    console.log('[Scheduler] 1pm — midday brief');
    try {
      await require('./briefing').buildAndDeliver({ label: 'midday' });
    } catch (e) { console.error('[Scheduler] Midday brief failed:', e.message); }
  });

  // Every 5 min 8am-6pm weekdays — alert checks (escalations, Teams mentions, meetings)
  cron.schedule('*/5 8-18 * * 1-5', async () => {
    try {
      await require('./briefing').runAlertChecks();
    } catch (e) { console.error('[Scheduler] Alert checks failed:', e.message); }
  });

  console.log('[Scheduler] Started — pre-warm 8:55am, standup 9am, 1-2-1 9:10am, nag 15m, EOD pre-warm 4:55pm, EOD 5pm, weekly review Fri 4:30pm, knowledge reflection Mon 8:10am, import consolidation hourly, import report 18:10, plan milestone 9:05am, escalations 5m, email triage 8/12/17, meeting prep 5m, Plaud MCP 30m, MS Tasks 30m');
}

module.exports = { start };
