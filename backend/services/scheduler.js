const cron = require('node-cron');
const nudges = require('./nudges');
const jira = require('./jira');
const imports = require('./imports');
const db = require('../db/database');

// ── Missed-run catch-up ─────────────────────────────────────────────────────
//
// `node-cron` is in-process and has NO catch-up: if the process is not running
// at 02:30, that night's job simply never happens and nothing says so. Measured
// on the Pi: the nightly sweep ran 9 times in 45 nights and the weekly hygiene
// pass 4 times in 7 Fridays, while the 22:00 rollup showed 111 runs and the Pi
// itself had 34 days of uptime. So it was never downtime — it was `neuro-backend`
// restarting (49 restarts, mostly deploys; two or three Claude sessions deploy a
// day) and each restart silently eating whatever was due while it was gone.
//
// Every job that IS reliable already has a startup fallback — capture drain,
// embeddings, imports, Plaud, MS Tasks, calendar. Every 02:30 and Friday job
// lacked one. This is that pattern, generalised: stamp the run date into
// `agent_state`, and on boot run anything whose slot has already passed today
// and whose stamp is not today's.
//
// Deliberately: a job missed YESTERDAY is not run today. Catch-up means "this
// slot has passed and was missed", not "replay history" — a week of missed
// sweeps firing at once on a Monday boot is a worse failure than the one being
// fixed.
const JOB_STATE_PREFIX = 'scheduler_last_run:';

function _dateStr(d = new Date()) {
  // Local date, deliberately not toISOString() — the Pi may run in UTC and a
  // 02:30 job stamped with a UTC date would roll over at the wrong moment.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function lastRunOf(name) {
  try { return db.getState(`${JOB_STATE_PREFIX}${name}`) || null; }
  catch { return null; }
}

function _markRan(name, when = new Date()) {
  try { db.setState(`${JOB_STATE_PREFIX}${name}`, _dateStr(when)); }
  catch (e) { console.error(`[Scheduler] Could not stamp ${name}:`, e.message); }
}

// Wrap a job so every run — cron or catch-up — records itself.
function _tracked(name, fn) {
  return async (via = 'cron') => {
    const started = Date.now();
    try {
      await fn();
    } catch (e) {
      // Jobs catch their own errors; this is the backstop so one throw cannot
      // take down the catch-up sequence behind it.
      console.error(`[Scheduler] ${name} threw (${via}):`, e.message);
    }
    // Stamped either way. A job that fails every night should not re-run on
    // every deploy as well — the failure belongs in the log, not in a retry loop.
    _markRan(name);
    if (via !== 'cron') console.log(`[Scheduler] ${name} ran via ${via} (${Date.now() - started}ms)`);
  };
}

// The two predicates, pure and exported — they are the only part of this with
// real logic in it, and the only part worth pinning.

/** Has today's hour:minute slot passed without a run today? */
function isDailyDue(lastRun, hour, minute, now = new Date()) {
  if (lastRun === _dateStr(now)) return false;
  return now.getHours() > hour || (now.getHours() === hour && now.getMinutes() >= minute);
}

/** Has the most recent weekly slot passed without a run in it? */
function isWeeklyDue(lastRun, weekday, hour, minute, now = new Date()) {
  // Wind back to the last time this slot came round — earlier today, or up to
  // six days ago. Missed means the stamp predates that moment.
  const slot = new Date(now);
  slot.setHours(hour, minute, 0, 0);
  let back = (now.getDay() - weekday + 7) % 7;
  if (back === 0 && now < slot) back = 7; // today IS the day, but before the time
  slot.setDate(slot.getDate() - back);
  return !lastRun || lastRun < _dateStr(slot);
}

const _catchUp = [];

/** Register a job that should run once a day at hour:minute. */
function scheduleDaily(name, cronExpr, hour, minute, fn) {
  const run = _tracked(name, fn);
  cron.schedule(cronExpr, () => run('cron'));
  _catchUp.push({ name, run, kind: 'daily', due: (now) => isDailyDue(lastRunOf(name), hour, minute, now) });
}

/** Register a job that should run once a week on `weekday` (0=Sun) at hour:minute. */
function scheduleWeekly(name, cronExpr, weekday, hour, minute, fn) {
  const run = _tracked(name, fn);
  cron.schedule(cronExpr, () => run('cron'));
  _catchUp.push({ name, run, kind: 'weekly', due: (now) => isWeeklyDue(lastRunOf(name), weekday, hour, minute, now) });
}

/**
 * Run anything whose slot has passed and which has not run in it.
 *
 * Staggered, because several of these walk the whole vault and firing them
 * together on boot would make every deploy cost a load spike on a Pi that is
 * also serving Focus and chat.
 */
function runCatchUp({ delayMs = 45000, gapMs = 60000 } = {}) {
  const now = new Date();
  const due = _catchUp.filter(j => { try { return j.due(now); } catch { return false; } });
  if (!due.length) return [];
  console.log(`[Scheduler] Catch-up: ${due.length} missed job(s) — ${due.map(j => j.name).join(', ')}`);
  due.forEach((job, i) => {
    const t = setTimeout(() => { job.run('catch-up'); }, delayMs + i * gapMs);
    // Never hold the process open for a catch-up.
    if (t.unref) t.unref();
  });
  return due.map(j => j.name);
}

/** What ran, and when — so a job that has quietly stopped is answerable. */
function jobRunStatus() {
  return _catchUp.map(j => ({ name: j.name, kind: j.kind, lastRun: lastRunOf(j.name) }));
}

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

  // Run anything today's restart caused us to miss. Registered below, so this
  // is deferred to the end of start() — see the runCatchUp() call there.

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

  // Every 20 min in working hours — offer NOVA any 1-2-1 transcript that has landed in
  // the vault. Frequent because Nick processes a recording and then goes looking for it
  // in NOVA; a nightly sweep would mean the test he just ran shows nothing for hours.
  // It only ever PROPOSES — NOVA holds each one until he approves it.
  cron.schedule('*/20 7-19 * * *', async () => {
    try {
      const r = await require('./nova-121-transcripts').offerTranscripts({ apply: true });
      if (!r.ok) { console.warn(`[Scheduler] 1-2-1 transcript offer failed: ${r.error}`); return; }
      if (r.offered.length || r.skipped.length) {
        console.log(`[Scheduler] 1-2-1 transcripts: ${r.offered.length} offered to NOVA, ${r.skipped.length} failed`);
        for (const f of r.skipped) console.warn(`[Scheduler] transcript offer failed — ${f}`);
      }
    } catch (e) {
      console.warn('[Scheduler] 1-2-1 transcript offer threw:', e.message);
    }
  });

  // 6:20am daily — push bookings + cadence into NOVA, ahead of its 07:00 prep job.
  //
  // DAILY, not weekdays: a 1-2-1 booked on a Friday for the Monday has to reach NOVA
  // over the weekend, or Monday's prep never goes out. The inline push in book() is the
  // fast path; this is the guarantee, because that push runs after the calendar event
  // has already been created and so cannot fail loudly enough to stop anything.
  cron.schedule('20 6 * * *', async () => {
    try {
      const sync = require('./nova-121-sync');
      const r = await sync.reconcile({ apply: true });
      if (!r.ok) { console.warn(`[Scheduler] NOVA 1-2-1 sync failed: ${r.error}`); return; }
      if (r.pushed?.length || r.failed?.length || r.cadenceSet?.length) {
        console.log(`[Scheduler] NOVA 1-2-1 sync: ${r.pushed.length} pushed, ${r.cadenceSet.length} cadence, ${r.failed.length} failed`);
      }
      const d = r.drift || {};
      if (d.notInNova?.length || d.notInVault?.length || d.unknownCadence?.length) {
        console.warn('[Scheduler] 1-2-1 roster drift —' +
          ` not in NOVA: [${(d.notInNova || []).join(', ')}];` +
          ` not in vault: [${(d.notInVault || []).join(', ')}];` +
          ` unknown cadence: [${(d.unknownCadence || []).map(x => `${x.person}=${x.cadence}`).join(', ')}]`);
      }
    } catch (e) {
      console.warn('[Scheduler] NOVA 1-2-1 sync threw:', e.message);
    }
  });


  // Retiring yesterday's banner is a DAILY job, not a weekday one — nagCheck
  // below runs Mon-Fri only, so a Saturday nudge survived the rollover and
  // Sunday raised a second row for the same fact (see clearStaleNudges).
  cron.schedule('5 0 * * *', () => {
    const n = nudges.clearStaleNudges();
    if (n) console.log(`[Scheduler] Cleared ${n} stale nudge(s) from previous days`);
  });

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

  // Monday 6:05am — refresh the gov.uk bank-holiday list (#25). Deliberately NOT
  // in state-of-play's TRACKED_JOBS: the feed is a static publication covering
  // years ahead and the service carries a compiled-in floor, so a missed week is
  // harmless — and a board that warns about a benign lapse is one nobody reads.
  // A failed fetch is loud in the log and visible on GET /api/time/working-days.
  scheduleWeekly('bank-holidays', '5 6 * * 1', 1, 6, 5, () => {
    require('./working-days').refresh().catch(e =>
      console.error('[Scheduler] Bank-holiday refresh failed:', e.message));
  });

  // Friday 4:30pm — snapshot the week's outcomes, then generate the review.
  // Snapshot FIRST so the review can read a stored week rather than recomputing
  // one, and so the number is fixed at the moment it was taken.
  scheduleWeekly('weekly-review', '30 16 * * 5', 5, 16, 30, () => {
    try {
      require('./outcomes').snapshot();
    } catch (e) { console.error('[Scheduler] Outcomes snapshot failed:', e.message); }
    try {
      const obsidian = require('./obsidian');
      const result = obsidian.generateWeeklyReview();
      if (result && !result.skipped) {
        require('./webpush').sendToAll('SARA — Weekly review',
          `Your ${result.weekStr} review is ready in Reflections. Take 5 minutes to fill in wins, challenges, and how you're feeling.`,
          { type: 'weekly_review', url: '/vault' }).catch(() => {});
      }
    } catch (e) { console.error('[Scheduler] Weekly review failed:', e.message); }
  });

  // Friday 4:35pm — weekly vault-hygiene pass (READ-ONLY): refresh the lint audit
  // and contextual-link cards so they're ready to review/approve. Never applies.
  scheduleWeekly('weekly-hygiene', '35 16 * * 5', 5, 16, 35, () => {
    try {
      const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultRoot) return;
      const hygiene = require('./vault-hygiene');
      const lintRes = hygiene.lint(vaultRoot);
      const planRes = hygiene.contextualLinkPlan(vaultRoot);
      // Archived-target count is logged but deliberately kept OUT of the push: it is
      // informational, and a second number on the banner is nudge noise (#17).
      console.log(`[Scheduler] Weekly hygiene: ${lintRes.broken.length} broken, ${lintRes.archivedTargets.length} into Archive, ${lintRes.orphans.length} orphans; ${planRes.total} link cards across ${planRes.notesTouched} notes.`);
      if (planRes.total > 0 || lintRes.broken.length > 0) {
        require('./webpush').sendToAll('SARA — Vault hygiene',
          `${lintRes.broken.length} broken links, ${lintRes.orphans.length} orphans, ${planRes.total} link cards to review in Vault Audit.`,
          { type: 'vault_hygiene', url: '/vault' }).catch(() => {});
      }
    } catch (e) { console.error('[Scheduler] Weekly hygiene failed:', e.message); }
  });

  // Every 5 min — move host metrics from the cron CSVs into SQL, sample the
  // Pi 5 straight in, and prune anything past retention. The CSVs stay as the
  // collection layer because they keep working when this process does not.
  cron.schedule('*/5 * * * *', async () => {
    try {
      const r = await require('./metrics-store').run();
      const imported = r.results.reduce((a, x) => a + (x.imported || 0), 0);
      if (imported || r.pruned) {
        console.log(`[Scheduler] Metrics: ${imported} imported, ${r.pi5Rows} pi5 samples, ${r.pruned} pruned`);
      }
    } catch (e) { console.error('[Scheduler] Metrics store failed:', e.message); }
  });

  // Every 30 min — watchdog. Pairs with the healthchecks.io dead man's switch:
  // that one catches a Pi that cannot speak, this one catches a healthy Pi with
  // something broken on it (dead worker, stopped backups, failing AI provider).
  // Alerts fire on transition only, so a persistent fault is not a repeat page.
  cron.schedule('*/30 * * * *', async () => {
    try {
      const r = await require('./watchdog').run();
      if (r.alerted.length || r.resolved.length) {
        console.log(`[Scheduler] Watchdog: ${r.alerted.length} new alert(s)${r.alerted.length ? ` — ${r.alerted.join('; ')}` : ''}${r.resolved.length ? ` | resolved: ${r.resolved.join('; ')}` : ''}`);
      }
    } catch (e) { console.error('[Scheduler] Watchdog failed:', e.message); }
  });

  // Nightly 2:30am — hygiene sweep (APPLY): content-safe Summary-N dedup, collect
  // unnamed "Speaker N" recordings into the Orphan hub, archive empty stragglers.
  // All mutations are reversible (archive + backups) and reported to Vault Audit.
  scheduleDaily('nightly-sweep', '30 2 * * *', 2, 30, () => {
    try {
      const vaultRoot = process.env.OBSIDIAN_VAULT_PATH;
      if (!vaultRoot) return;
      const r = require('./vault-hygiene').nightlySweep(vaultRoot, { apply: true });
      console.log(`[Scheduler] Nightly sweep: ${r.dedup.dropped.length} duplicate summaries archived, ${r.orphans.collected.length} unnamed recordings collected, ${r.empties.archived.length} empty recordings archived. Report: ${r.reportPath}`);
    } catch (e) { console.error('[Scheduler] Nightly sweep failed:', e.message); }
  });

  // Monday 8:10am — generate a knowledge reflection brief for the week ahead
  scheduleWeekly('knowledge-reflection', '10 8 * * 1', 1, 8, 10, () => {
    try {
      const result = require('./knowledge-memory').generateReflection({ write: true });
      if (result?.path) {
        require('./webpush').sendToAll(
          'SARA — Knowledge reflection',
          'Your latest knowledge reflection is ready. Review what to promote before the week drifts.',
          { type: 'knowledge_reflection', url: '/insights' }
        ).catch(() => {});
      }
    } catch (e) {
      console.error('[Scheduler] Knowledge reflection failed:', e.message);
    }
  });

  // Monday 7:30am — build the Weekly Risk & Anomaly Summary.
  //
  // Nick owes this to Chris by MIDDAY every Monday (agreed at the 1-2-1 on
  // 12 Aug 2026, PIP competency 2), so it is built early enough to leave a
  // working morning for the manual sections. It BUILDS and notifies; it never
  // publishes or sends. Overtime, the escalation list and the data-quality
  // judgements are Nick's to state, and a report that auto-sent itself with
  // those blank would be a false all-clear to the person assessing the PIP.
  scheduleWeekly('weekly-risk-report', '30 7 * * 1', 1, 7, 30, async () => {
    try {
      const weeklyRisk = require('./weekly-risk');
      const report = await weeklyRisk.build();
      const parts = [];
      if (report.escalateCount) parts.push(`${report.escalateCount} to escalate`);
      if (report.blockers.length) parts.push(`${report.blockers.length} section${report.blockers.length === 1 ? '' : 's'} need you`);
      const failed = report.sources.filter(s => !s.ok).length;
      if (failed) parts.push(`${failed} data source${failed === 1 ? '' : 's'} down`);
      await require('./webpush').sendToAll(
        'SARA — Weekly risk report',
        parts.length
          ? `Draft ready for Chris by midday: ${parts.join(', ')}.`
          : 'Draft ready for Chris by midday. Nothing flagged for escalation — confirm and send.',
        // `?view=` — App.jsx reads the query param, never the pathname, so a
        // bare '/weekly-risk' silently lands on Briefing.
        { type: 'weekly_risk', url: '/?view=weekly-risk' },
      ).catch(() => {});
      console.log(`[Scheduler] Weekly risk report built: ${report.escalateCount} escalations, ${report.blockers.length} blockers.`);
    } catch (e) {
      console.error('[Scheduler] Weekly risk report failed:', e.message);
    }
  });

  // Weekdays 10 minutes after the main intake cycles — consolidate raw intake into working notes
  cron.schedule('40 * * * 1-5', () => {
    require('./knowledge-memory').consolidateAllImports({ limit: 30 }).catch((e) => {
      console.error('[Scheduler] Import consolidation failed:', e.message);
    });
  });

  // Every hour — fold finished work into the wins ledger.
  //
  // Deliberately NOT a scheduleDaily/TRACKED_JOBS job. sync() is idempotent and
  // reads a trailing window, so a missed hour is corrected by the next one and
  // by the sync-on-read in the route — there is nothing for catch-up to replay
  // and nothing for state-of-play to warn about. Same call as bank-holidays:
  // a board that warns about a benign lapse is one nobody reads.
  cron.schedule('20 * * * *', () => {
    try {
      const { added, gaps } = require('./wins').sync();
      if (added) console.log(`[Scheduler] Wins: +${added}`);
      // A source that could not be read is logged, never silently treated as a
      // day with no wins — that silence is the bug this feature exists to fix.
      for (const g of gaps) console.warn(`[Scheduler] Wins gap — ${g}`);
    } catch (e) {
      console.error('[Scheduler] Wins sync failed:', e.message);
    }
  });

  // 10pm nightly — build daily activity summary + entity extraction + write observations
  scheduleDaily('nightly-rollup', '0 22 * * *', 22, 0, () => {
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
        require('./webpush').sendToAll('SARA — Actions to review',
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
    // Then pull the 1-2-1s NOVA has RUN back into the same cards — actions agreed in
    // the click-through, plus `last-1-2-1` from its `completed_at`.
    //
    // Hung off the rollup rather than given its own cron for the same reason the tracker
    // hangs off syncPeopleNotes: both write `last-1-2-1`, from different evidence, and a
    // separate schedule only HOPES the detector has finished. Here the order is a fact.
    // It runs after the detector on purpose — a written-up note is the stronger claim.
    (async () => {
      try {
        const wb = await require('./nova-121-writeback').writeBack({ apply: true });
        if (!wb.ok) { console.warn(`[Scheduler] NOVA 1-2-1 write-back failed: ${wb.error}`); return; }
        if (wb.people.length || wb.failed.length || wb.skipped.length) {
          const actions = wb.people.reduce((n, p) => n + p.newActions, 0);
          console.log(`[Scheduler] NOVA 1-2-1 write-back: ${wb.people.length} card(s), ${actions} new action(s), ${wb.skipped.length} skipped, ${wb.failed.length} failed`);
          for (const s of wb.skipped) console.warn(`[Scheduler] 1-2-1 write-back skipped ${s.person}: ${s.reason}`);
          for (const f of wb.failed) console.warn(`[Scheduler] 1-2-1 write-back failed ${f.person}: ${f.error}`);
        }
      } catch (e) {
        console.warn('[Scheduler] NOVA 1-2-1 write-back threw:', e.message);
      }
    })();
    // People gap — nothing else in NEURO ever proposed a People note, so the
    // roster only grew when Nick typed one in and every consumer keyed off it
    // stayed capped. READ-ONLY: reports to Vault Audit, creation is an explicit
    // POST /api/people-gap/apply.
    try {
      const gap = require('./people-gap').runNightlyScan({ days: 90 });
      if (gap.status === 'ok') {
        console.log(`[Scheduler] People gap: ${gap.candidates.length} candidates, ${gap.belowThreshold.length} seen once`);
        if (gap.candidates.length > 0) {
          require('./webpush').sendToAll('SARA — People notes',
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

  // Every 10 minutes — release any task block whose outcome note has been
  // written. This is the mechanism, not a backstop: Nick writes the note in
  // Obsidian and nothing in that act touches NEURO, and vault-hooks deliberately
  // do not fire for Syncthing-delivered files (the same reason one-to-one-detect
  // runs on a TTL). Without the sweep, a task written up this morning stays held
  // until something else happens to look.
  //
  // Deliberately NOT a scheduleDaily/TRACKED_JOBS job: the sweep reads current
  // state and is idempotent, so a missed run self-corrects on the next one and
  // there is nothing to replay — the same call bank-holidays and wins made.
  cron.schedule('*/10 * * * *', () => {
    try {
      const result = require('./task-blocks').sweep();
      // A gap is logged even when nothing completed. A sweep reporting zero
      // because the vault was unreachable is precisely the silent failure this
      // feature exists to stop, so it must not look like a quiet success.
      if (result.gaps.length) {
        console.warn(`[Scheduler] Task block sweep gaps: ${result.gaps.join('; ')}`);
      }
    } catch (e) {
      console.error('[Scheduler] Task block sweep failed:', e.message);
    }
  });

  // Who is off, from NOVA's People HR sync. Every 30 minutes and once shortly
  // after boot, because `nudgeSuppression()` is synchronous and reads only the
  // cache — nothing on the nudge path may wait on NOVA.
  //
  // Deliberately NOT a TRACKED_JOBS/catch-up job: it overwrites a cache from a
  // trailing window, so a missed run self-corrects on the next one and there is
  // nothing to replay — the same call bank-holidays and wins made. A failed
  // refresh keeps the previous copy rather than emptying it.
  const refreshAvailability = (why) => {
    require('./team-availability').refresh()
      .then(r => { if (!r.ok) console.warn(`[Scheduler] Availability refresh (${why}) failed`); })
      .catch(e => console.error(`[Scheduler] Availability refresh (${why}) error:`, e.message));
  };
  setTimeout(() => refreshAvailability('startup'), 20000);
  cron.schedule('*/30 * * * *', () => refreshAvailability('cron'));

  // ── The half-day planner ───────────────────────────────────────────────────
  //
  // 07:15 plans the morning, 12:30 plans the afternoon, and both CREATE the
  // blocks rather than proposing them (Nick's call, 27 Aug). The half-day
  // horizon is the point: his diary moves under him, so an afternoon planned at
  // dawn is planned against a calendar that no longer exists by lunchtime.
  //
  // Both are no-ops unless DAY_PLANNER_ENABLED=true, and `run()` takes its own
  // lock — these two can overlap a manual apply from the route, which is the
  // case that turned 27 Plaud blocks into 52 real calendar events.
  //
  // Deliberately NOT a TRACKED_JOBS/catch-up job. Catch-up exists to replay a
  // missed slot, and replaying this one is exactly wrong: a morning plan fired
  // at 14:00 because the Pi was rebooting would block time that has already
  // gone. A missed half-day should stay missed.
  const planHalf = (windowKey) => async () => {
    try {
      const result = await require('./day-planner').run(windowKey, { apply: true });
      if (result.skipped) {
        console.log(`[Scheduler] Day plan (${windowKey}) skipped: ${result.skipped}`);
      } else if (result.created?.length) {
        console.log(`[Scheduler] Day plan (${windowKey}): ${result.created.length} block(s) created`);
      } else {
        console.log(`[Scheduler] Day plan (${windowKey}): nothing blocked — ${result.reason || result.error || 'no reason given'}`);
      }
      if (result.failed?.length) {
        console.warn(`[Scheduler] Day plan (${windowKey}) had ${result.failed.length} failure(s): `
          + result.failed.map(f => `${f.startTime} ${f.error}`).join('; '));
      }
    } catch (e) {
      console.error(`[Scheduler] Day plan (${windowKey}) failed:`, e.message);
    }
  };
  cron.schedule('15 7 * * 1-5', planHalf('morning'));
  cron.schedule('30 12 * * 1-5', planHalf('afternoon'));

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
  scheduleDaily('embeddings-rebuild', '0 2 * * *', 2, 0, () => {
    console.log('[Scheduler] Rebuilding vault embeddings...');
    try {
      // Returned, not fire-and-forget, so the run is stamped on COMPLETION.
      // A full re-index is hours on Voyage's free tier; if the backend restarts
      // part-way there is no stamp, catch-up re-triggers it, and it resumes from
      // the content hashes rather than starting over.
      return require('./embeddings').rebuildEmbeddings().catch(e => {
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
          'SARA — System alert',
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

  // Email triage — every 30 minutes, 8am-6pm weekdays (26 Aug 2026).
  //
  // Was 8am/12pm/5pm, which left a 5-hour hole in the afternoon and a 15-hour
  // one overnight; in practice the only reason it felt fresher than that is
  // that the backend restarts several times a day. Measured before changing
  // it: 120ms of CPU and ~2,250 tokens per run, 6.9s of it waiting on Graph
  // and OpenRouter. CPU was never the constraint — the shared daily cloud
  // budget is, which is why `runTriage` skips the model call when the mail is
  // unchanged. Deliberately NOT overnight: mail arriving at 3am is not worth a
  // token, and the 8am run covers it.
  cron.schedule('*/30 8-18 * * 1-5', () => {
    require('./email-triage').runTriage().catch(e => {
      console.error('[Scheduler] Email triage failed:', e.message);
    });
  });

  // Startup triage after 60s
  setTimeout(() => {
    require('./email-triage').runTriage().catch(() => {});
  }, 60000);

  // Every 20 minutes — refresh the calendar cache. Nothing populated it before,
  // so Focus, the meeting alerts and every calendar-aware tool ran blind.
  cron.schedule('*/20 * * * *', async () => {
    try {
      await require('./calendar-sync').sync({ days: 14 });
    } catch (e) { console.error('[Scheduler] Calendar sync failed:', e.message); }
  });

  // Startup sync — 20s in, so the cache is warm before the first agent loop.
  setTimeout(() => {
    require('./calendar-sync').sync({ days: 14 }).catch(e =>
      console.error('[Scheduler] Startup calendar sync failed:', e.message));
  }, 20 * 1000);

  // 8:20am weekdays — safety net, not the main path. Invites are caught on
  // arrival: the calendar sync reports which events are new and checks those
  // immediately, and email triage triggers a sync because an invite arrives as
  // an email. This sweep exists for what slipped through — a failed sync, a
  // restart mid-delivery, a meeting whose body was filled in after it was sent.
  cron.schedule('20 8 * * 1-5', async () => {
    try {
      const result = await require('./meeting-triage').scanUpcoming({ days: 7 });
      if (result.queued > 0) {
        console.log(`[Scheduler] Agenda chasers queued: ${result.queued}`);
      }
    } catch (e) { console.error('[Scheduler] Agenda check failed:', e.message); }
  });

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

  // Last, so every tracked job is registered. Staggered — several of these walk
  // the whole vault, and a deploy should not cost a load spike on a Pi that is
  // also serving Focus and chat.
  runCatchUp();
}

module.exports = {
  start, runCatchUp, jobRunStatus, lastRunOf,
  scheduleDaily, scheduleWeekly,
  // exported for tests
  isDailyDue, isWeeklyDue, _dateStr,
};
