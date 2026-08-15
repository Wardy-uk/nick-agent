'use strict';

// Move host metrics from the cron-written CSVs into SQLite, then trim the CSVs.
//
// Why both: the collectors are cron shell scripts that must keep working when
// the backend is dead — that is exactly when a wedged router needs recording.
// So collection stays in files. This is the queryable, retained, backed-up copy
// the panel reads, and the only thing it reads, so there is no "check two
// places and stitch them together" logic to get wrong.
//
// The trim is by WATERMARK, not by age. Deleting anything older than 24h would
// mean a broken importer silently drops data forever — the same shape as the
// backup script that logged "not found" for ten weeks. Trimming only what SQL
// has confirmed means a broken importer causes the CSV to GROW: visible,
// harmless, and it announces itself.

const fs = require('fs');
const path = require('path');
const db = require('../db/database');

const LOG_DIR = '/mnt/data/logs';

// Keep a day of already-imported rows in the file as a safety margin, so a
// mistake here is recoverable from disk rather than only from backup.
const CSV_KEEP_MS = 24 * 3600 * 1000;
const RETENTION_DAYS = 90;

// Each CSV maps its columns to metric names. Columns not listed are ignored,
// so adding a column to a collector cannot break the importer.
const SOURCES = {
  router: {
    file: 'router-metrics.csv',
    columns: { temp_c: 'temp_c', mem_free_kb: 'mem_free_kb', uptime_s: 'uptime_s', router_up: 'router_up', net_up: 'net_up' },
  },
  pi4: {
    file: 'pi4-metrics.csv',
    columns: { load_pct: 'load_pct', temp_c: 'temp_c', mem_used_pct: 'mem_used_pct', swap_used_kb: 'swap_used_kb' },
  },
  broadband: {
    file: 'broadband.csv',
    columns: { down_mbps: 'down_mbps', up_mbps: 'up_mbps', ping_ms: 'ping_ms', jitter_ms: 'jitter_ms', gb_used: 'gb_used' },
  },
};

function _watermarkKey(source) {
  return `metrics_watermark_${source}`;
}

function _readWatermark(source) {
  return db.getState(_watermarkKey(source)) || '1970-01-01T00:00:00Z';
}

function _parseCsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return { header: lines[0] || '', rows: [] };
  const header = lines[0].split(',').map(h => h.trim());
  const rows = lines.slice(1).map(line => {
    const parts = line.split(',');
    const row = {};
    header.forEach((h, i) => { row[h] = parts[i]; });
    row._raw = line;
    return row;
  });
  return { header: lines[0], rows };
}

/**
 * Import one source. Returns what happened, so the caller can log something
 * meaningful rather than "done".
 */
function importSource(source, cfg) {
  const file = path.join(LOG_DIR, cfg.file);
  if (!fs.existsSync(file)) return { source, skipped: 'no file' };

  const { header, rows } = _parseCsv(fs.readFileSync(file, 'utf8'));
  if (!rows.length) return { source, imported: 0, rows: 0 };

  const watermark = _readWatermark(source);
  const toInsert = [];
  let newest = watermark;

  for (const row of rows) {
    const ts = row.timestamp;
    if (!ts || ts <= watermark) continue;
    for (const [column, metric] of Object.entries(cfg.columns)) {
      const raw = row[column];
      if (raw === undefined || raw === '') continue; // failed sample — the gap is the signal
      const value = parseFloat(raw);
      if (!Number.isFinite(value)) continue;
      toInsert.push({ source, metric, value, recordedAt: ts });
    }
    if (ts > newest) newest = ts;
  }

  const inserted = db.insertHostMetrics(toInsert);
  if (newest !== watermark) db.setState(_watermarkKey(source), newest);

  // Trim only rows that are BOTH imported and older than the safety window.
  const cutoff = new Date(Date.now() - CSV_KEEP_MS).toISOString();
  const keep = rows.filter(r => !r.timestamp || r.timestamp > newest || r.timestamp > cutoff);
  let trimmed = 0;
  if (keep.length < rows.length) {
    trimmed = rows.length - keep.length;
    fs.writeFileSync(file, [header, ...keep.map(r => r._raw)].join('\n') + '\n');
  }

  return { source, imported: inserted, trimmed, watermark: newest };
}

/**
 * Sample the Pi 5 straight into SQL. It is the backend doing the sampling, so
 * if this runs the database is available — no CSV needed. This is also the gap
 * that mattered most: Pi 5 history was a 120-entry in-memory ring buffer that
 * emptied on every restart, so the box we care about had the least durable
 * record of the four.
 */
async function samplePi5() {
  const piHealth = require('./pi-health');
  const snap = await piHealth.collect({ skipHistory: true });
  const now = new Date().toISOString();
  const rows = [
    { source: 'pi5', metric: 'load_pct', value: snap.cpu?.loadPct, recordedAt: now },
    { source: 'pi5', metric: 'temp_c', value: snap.cpu?.tempC, recordedAt: now },
    { source: 'pi5', metric: 'mem_used_pct', value: snap.memory?.usedPct, recordedAt: now },
    { source: 'pi5', metric: 'swap_used_pct', value: snap.memory?.swapPct, recordedAt: now },
  ].filter(r => r.value != null);
  return db.insertHostMetrics(rows);
}

async function run() {
  const results = [];
  for (const [source, cfg] of Object.entries(SOURCES)) {
    try { results.push(importSource(source, cfg)); }
    catch (e) { results.push({ source, error: e.message }); }
  }

  let pi5 = 0;
  try { pi5 = await samplePi5(); }
  catch (e) { results.push({ source: 'pi5', error: e.message }); }

  let pruned = 0;
  try { pruned = db.pruneHostMetrics(RETENTION_DAYS); }
  catch { /* pruning is housekeeping, never worth failing the run for */ }

  return { results, pi5Rows: pi5, pruned };
}

/**
 * History for the panel, shaped exactly like the in-memory buffer it replaces
 * so the frontend needs no changes.
 */
function getHistory(source, hours = 24, metrics = ['load_pct', 'temp_c', 'mem_used_pct']) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString();
  const series = {};
  for (const m of metrics) series[m] = db.getHostMetrics(source, m, since);

  // Pivot to one point per timestamp, which is what a sparkline wants.
  const byTime = new Map();
  for (const [metric, rows] of Object.entries(series)) {
    for (const r of rows) {
      const e = byTime.get(r.recorded_at) || { t: r.recorded_at };
      e[metric] = r.value;
      byTime.set(r.recorded_at, e);
    }
  }
  return [...byTime.values()].sort((a, b) => a.t.localeCompare(b.t));
}

module.exports = { run, importSource, samplePi5, getHistory, SOURCES };
