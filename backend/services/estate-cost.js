'use strict';

/**
 * What the OTHER systems on this box are spending.
 *
 * ── Why ─────────────────────────────────────────────────────────────────────
 *
 * NEURO's ledger answers "what is NEURO costing", and for six days that read
 * like the whole answer. It is not: NEURO and VANTAGE share ONE OpenRouter key,
 * and an activity export on 1 Sep 2026 put the seven days from 26 Aug at
 * **$16.97 — VANTAGE $14.79 (87.2%), NEURO $2.17 (12.8%)**. A cost panel that
 * shows only its own 13% is not a cost panel; it is the reason nobody noticed.
 *
 * So the AI panel reads VANTAGE's ledger too. Same box, same key, one bill.
 *
 * ── How, and why not over HTTP ──────────────────────────────────────────────
 *
 * A read-only open of VANTAGE's SQLite file rather than an endpoint and a shared
 * secret. Both processes run as the same user on the same Pi, the read cannot
 * mutate anything, and the alternative is a credential to store, rotate and
 * eventually find broken. The NOVA bridge is HTTP because NOVA is on another
 * machine; this is not.
 *
 * ── The rule that matters ───────────────────────────────────────────────────
 *
 * ⚠ ABSENCE IS UNKNOWN, NEVER ZERO. Not configured, file missing, unreadable,
 * no ledger table yet — every one of those returns `known: false` WITH A REASON,
 * never a tidy $0.00. A zero here would say "VANTAGE costs nothing", which is
 * the exact false all-clear this whole review exists to remove. And it must
 * never throw: a cost panel is not worth taking the health page down for.
 */

const path = require('path');

// VANTAGE's own default, kept in step. Overridable because a dev box will not
// have it, and reporting "not configured" there is correct rather than noisy.
const DEFAULT_VANTAGE_DB = '/mnt/data/vantage-data/vantage.db';

function vantageDbPath() {
  return process.env.VANTAGE_DB_PATH || DEFAULT_VANTAGE_DB;
}

function _todayKey() {
  const d = new Date();
  // Local, never toISOString() — the rest of this codebase learned that the
  // hard way and a day boundary an hour out makes two panels disagree.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function _dayKeyAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * VANTAGE stores its rows as documents in a `docs` table (collection,
 * data JSON) — the same store its settings live in. Read them out and roll up.
 */
function vantageSpend() {
  const file = vantageDbPath();
  let Database;
  try {
    Database = require('better-sqlite3');
  } catch (e) {
    return { known: false, reason: 'sqlite driver unavailable' };
  }

  const fs = require('fs');
  if (!fs.existsSync(file)) {
    return { known: false, reason: `VANTAGE database not found at ${file}` };
  }

  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (e) {
    return { known: false, reason: `could not open VANTAGE database (${e.message})` };
  }

  try {
    const hasDocs = db
      .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='docs'")
      .get().n > 0;
    if (!hasDocs) return { known: false, reason: 'VANTAGE has no document store yet' };

    const rows = db
      .prepare("SELECT data FROM docs WHERE collection = 'llm_calls'")
      .all()
      .map(r => { try { return JSON.parse(r.data); } catch { return null; } })
      .filter(Boolean);

    // A ledger that exists but is empty is a DIFFERENT fact from one that
    // cannot be read: VANTAGE's was added on 2 Sep, so until its first call
    // this is genuinely "nothing recorded yet", not "nothing spent, ever".
    if (!rows.length) {
      return {
        known: true,
        calls: 0,
        empty: true,
        note: 'VANTAGE ledger added 2 Sep — nothing recorded yet',
        today: { costUsd: 0, calls: 0, unpriced: 0 },
        last7: { costUsd: 0, calls: 0, unpriced: 0 },
        last30: { costUsd: 0, calls: 0, unpriced: 0 },
        byCallType: [],
      };
    }

    const today = _todayKey();
    const d7 = _dayKeyAgo(6);
    const d30 = _dayKeyAgo(29);

    const bucket = () => ({ costUsd: 0, calls: 0, unpriced: 0, tokens: 0, failed: 0 });
    const acc = { today: bucket(), last7: bucket(), last30: bucket() };
    const byType = {};

    for (const r of rows) {
      const key = r.date_key || '';
      const cost = r.cost_usd;
      const tok = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
      const add = (b) => {
        b.calls++;
        b.tokens += tok;
        if (cost == null) b.unpriced++; else b.costUsd += cost;
        if (r.ok === false) b.failed++;
      };
      if (key === today) add(acc.today);
      if (key >= d7) add(acc.last7);
      if (key >= d30) {
        add(acc.last30);
        const t = (byType[r.call_type || '(untagged)'] ||= { task: r.call_type || '(untagged)', calls: 0, costUsd: 0, unpriced: 0 });
        t.calls++;
        if (cost == null) t.unpriced++; else t.costUsd += cost;
      }
    }
    for (const b of Object.values(acc)) b.costUsd = Number(b.costUsd.toFixed(4));

    return {
      known: true,
      calls: rows.length,
      ...acc,
      byCallType: Object.values(byType).sort((a, b) => b.costUsd - a.costUsd),
    };
  } catch (e) {
    return { known: false, reason: `could not read VANTAGE ledger (${e.message})` };
  } finally {
    try { db.close(); } catch { /* nothing to do */ }
  }
}

/**
 * The estate roll-up the AI panel renders beside NEURO's own figures.
 *
 * `neuroCost` is NEURO's existing cost summary, passed in rather than required,
 * so this stays a pure roll-up and cannot become a second opinion about what
 * NEURO spent.
 *
 * ⚠ `combined` is only reported when EVERY system answered. A total that
 * silently omits an unreadable system is worse than no total, because it looks
 * complete — the same reason a domain that could not be read is null and not 0.
 */
function estateSpend(neuroCost) {
  const vantage = vantageSpend();
  const systems = [];

  if (neuroCost && !neuroCost.error) {
    systems.push({
      system: 'NEURO',
      known: true,
      today: neuroCost.today?.costUsd ?? 0,
      last7: neuroCost.last7?.costUsd ?? 0,
      last30: neuroCost.last30?.costUsd ?? 0,
      calls7: neuroCost.last7?.calls ?? 0,
    });
  } else {
    systems.push({ system: 'NEURO', known: false, reason: neuroCost?.error || 'cost ledger unreadable' });
  }

  if (vantage.known) {
    systems.push({
      system: 'VANTAGE',
      known: true,
      today: vantage.today.costUsd,
      last7: vantage.last7.costUsd,
      last30: vantage.last30.costUsd,
      calls7: vantage.last7.calls,
      note: vantage.note || null,
      byCallType: vantage.byCallType,
    });
  } else {
    systems.push({ system: 'VANTAGE', known: false, reason: vantage.reason });
  }

  const allKnown = systems.every(s => s.known);
  const sum = (k) => Number(systems.reduce((t, s) => t + (s.known ? (s[k] || 0) : 0), 0).toFixed(4));

  return {
    systems,
    complete: allKnown,
    // Named so a reader knows what the total is missing, rather than being
    // handed a confident number with a hole in it.
    missing: systems.filter(s => !s.known).map(s => s.system),
    combined: allKnown ? { today: sum('today'), last7: sum('last7'), last30: sum('last30') } : null,
    // NOVA bills to its own key and lives on another machine, so it is named as
    // a known omission rather than silently absent from an "estate" figure.
    notCounted: ['NOVA (separate key, separate host)'],
  };
}

module.exports = { estateSpend, vantageSpend, vantageDbPath };
