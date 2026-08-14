'use strict';

// Self-reported alerting — Layer 2.
//
// The dead man's switch (heartbeat.sh → healthchecks.io) covers the case where
// the Pi cannot speak: power, router, kernel, crash loop. It cannot cover the
// opposite case, which is the one that has actually bitten repeatedly here —
// the Pi perfectly healthy while something ON it is quietly broken:
//   · the Pi 4 worker unreachable since June, AI tasks silently skipped
//   · backup-db.sh missing since May, cron logging "not found" every 6 hours
// Both were invisible for months because nothing pushed them at anyone.
//
// Alerts fire on TRANSITION, not on every tick. An alert you receive every
// 30 minutes gets muted, and a muted alert is worse than none — it looks like
// coverage while providing none.

const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const webpush = require('./webpush');

const STATE_KEY = 'watchdog_active_issues';
const BACKUP_SNAPSHOTS = '/mnt/backup/snapshots';

// 6-hourly backups: one missed run is noise, four is a real failure.
const BACKUP_WARN_HOURS = 12;
const BACKUP_CRIT_HOURS = 26;

function _readActive() {
  try { return JSON.parse(db.getState(STATE_KEY) || '{}'); }
  catch { return {}; }
}

function _writeActive(map) {
  // setState takes a primitive — objects must be stringified (see mistakes.md).
  db.setState(STATE_KEY, JSON.stringify(map));
}

function _hoursSince(ms) {
  return (Date.now() - ms) / 3600000;
}

// ── Checks ──────────────────────────────────────────────────────────────────
// Each returns { key, level, title, detail }. `key` must be stable across runs
// or every tick looks like a new problem and the transition logic is defeated.

function checkBackups() {
  const out = [];
  try {
    if (!fs.existsSync(BACKUP_SNAPSHOTS)) {
      return [{
        key: 'backup:missing-mount',
        level: 'critical',
        title: 'Backup drive missing',
        detail: `${BACKUP_SNAPSHOTS} does not exist — the USB drive may be unplugged`,
      }];
    }
    const dirs = fs.readdirSync(BACKUP_SNAPSHOTS)
      .filter(d => d !== 'latest')
      .map(d => {
        try { return { d, t: fs.statSync(path.join(BACKUP_SNAPSHOTS, d)).mtimeMs }; }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t);

    if (!dirs.length) {
      out.push({ key: 'backup:none', level: 'critical', title: 'No backup snapshots', detail: 'the backup job has never produced a snapshot' });
      return out;
    }

    const age = _hoursSince(dirs[0].t);
    if (age >= BACKUP_CRIT_HOURS) {
      out.push({ key: 'backup:stale', level: 'critical', title: 'Backups have stopped', detail: `newest snapshot is ${Math.round(age)}h old (${dirs[0].d})` });
    } else if (age >= BACKUP_WARN_HOURS) {
      out.push({ key: 'backup:stale', level: 'warn', title: 'Backup is late', detail: `newest snapshot is ${Math.round(age)}h old` });
    }
  } catch (e) {
    out.push({ key: 'backup:check-failed', level: 'warn', title: 'Backup check failed', detail: e.message });
  }
  return out;
}

function checkAi() {
  const out = [];
  let status;
  try { status = require('./ai-routing').getStatus(); }
  catch (e) { return [{ key: 'ai:status-failed', level: 'warn', title: 'AI status unavailable', detail: e.message }]; }

  const health = status.health || {};

  if (status.pi4Worker?.enabled && status.pi4Worker?.lastHealthy === false) {
    out.push({
      key: 'ai:worker-down',
      level: 'critical',
      title: 'Pi 4 worker unreachable',
      detail: `${status.pi4Worker.url} — background AI tasks are being skipped`,
    });
  }

  for (const [provider, err] of Object.entries(health.errors || {})) {
    if (err.errorClass === 'auth') {
      out.push({ key: `ai:auth:${provider}`, level: 'critical', title: `${provider} authentication failed`, detail: err.message });
    }
  }

  if (health.calls > 5 && health.failureRate >= 20) {
    out.push({ key: 'ai:failure-rate', level: 'critical', title: `${health.failureRate}% of AI calls failing`, detail: `${health.failures} of the last ${health.calls}` });
  }

  if (status.openrouter?.throttled) {
    out.push({ key: 'ai:openrouter-throttled', level: 'warn', title: 'OpenRouter throttled', detail: 'daily budget reached — falling back to local' });
  }

  return out;
}

async function checkHost() {
  const out = [];
  try {
    const snap = await require('./pi-health').collect();
    for (const issue of snap.issues || []) {
      // pi-health already ranks these; key on the title so a recurring issue
      // is recognised as the same one rather than re-alerting.
      out.push({
        key: `host:${issue.title.replace(/\s+/g, '-').toLowerCase().slice(0, 60)}`,
        level: issue.level,
        title: issue.title,
        detail: issue.detail,
      });
    }
  } catch (e) {
    out.push({ key: 'host:check-failed', level: 'warn', title: 'Host health check failed', detail: e.message });
  }
  return out;
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function run({ notify = true } = {}) {
  const issues = [
    ...checkBackups(),
    ...checkAi(),
    ...(await checkHost()),
  ];

  const current = Object.fromEntries(issues.map(i => [i.key, i]));
  const previous = _readActive();

  const isNew = issues.filter(i => !previous[i.key]);
  const resolved = Object.values(previous).filter(p => !current[p.key]);

  // Only criticals are pushed. Warnings are real but not worth waking anyone —
  // they belong in the daily briefing, which already lands every morning.
  const toAlert = isNew.filter(i => i.level === 'critical');

  if (notify && webpush.isConfigured()) {
    for (const i of toAlert) {
      // 'system_alert' is in webpush ALWAYS_DELIVER, so it survives quiet hours
      // and still gets fingerprint-deduped for 30 minutes.
      await webpush.sendToAll(`⚠ ${i.title}`, i.detail || '', { type: 'system_alert', key: i.key });
    }
    // Silence should mean "fine", not "the alerter gave up" — so say when it clears.
    for (const r of resolved.filter(r => r.level === 'critical')) {
      await webpush.sendToAll(`✅ Resolved: ${r.title}`, 'Back to normal.', { type: 'system_alert', key: `${r.key}:resolved` });
    }
  }

  _writeActive(current);

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    counts: { total: issues.length, critical: issues.filter(i => i.level === 'critical').length },
    alerted: toAlert.map(i => i.title),
    resolved: resolved.map(r => r.title),
    issues,
  };
}

module.exports = { run, checkBackups, checkAi, checkHost };
