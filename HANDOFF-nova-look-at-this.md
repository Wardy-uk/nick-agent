# HANDOFF — NUERO side of NOVA "Look at this" (Codex)

**Goal:** NOVA now has a "Look at this" board (risk-scorer flagged tickets grouped by *why*).
NOVA **pushes** those flagged tickets to NUERO so the worst few surface at the top of
**Focus** (`get_focus` / `GET /api/focus`). Everything on the NOVA side is already built,
committed and pushed (NOVA `nova-codex`, v1.1.347). **This handoff is the NUERO side only.**

Direction of data: **NOVA → NUERO push** (not NUERO pulling). NOVA already runs a background
job every 10 min that POSTs the feed to `POST /api/nova-signals` here, using
`X-Neuro-Api-Token`. It is a no-op on NOVA's side until Nick sets `neuro_push_url` +
`neuro_api_token` in NOVA settings — so you can build and test the NUERO endpoint first.

---

## ⚠️ Read first — working-tree state

A **complete working draft of all five changes below is already applied** to this canonical
checkout (`C:\Users\NickW\Claude\nuero`), uncommitted. It is syntax-checked (`node --check`
passes). **BUT** the same files also contain unrelated in-flight WIP that is NOT mine:

- `backend/server.js` — someone is wiring `/api/queue` → untracked `backend/routes/queue.js`
- `backend/services/decision-engine.js` — an edit to `_applyOverrides` (STANDUP FAILURE logic)
- plus a large `sara/` subproject and email-triage changes elsewhere in the tree

**Do not blanket-commit.** Either (a) review my draft hunks in these files and commit only the
NOVA-signals-related hunks alongside the untracked new files, or (b) reconcile with Nick's WIP
first. `git checkout <file>` will destroy the concurrent WIP — don't. The full code is below so
you can rebuild from scratch if you prefer a clean tree.

Files that are 100% mine and safe to commit as-is:
- `backend/routes/nova-signals.js` (new)
- the `nova_flags` block in `backend/db/schema.sql`
- the `replaceNovaFlags` / `getActiveNovaFlags` functions + exports in `backend/db/database.js`

Files where my hunk is mixed with foreign WIP (stage the specific hunk only):
- `backend/server.js` (one `app.use` line)
- `backend/services/decision-engine.js` (`collectNovaFlags` fn + one line in `allSignals`)

---

## The contract (already implemented on NOVA)

`POST /api/nova-signals`
Headers: `X-Neuro-Api-Token: <NEURO_API_TOKEN>`, `Content-Type: application/json`
Body — the grouped payload from NOVA's `groupFlaggedByReason()`:

```json
{
  "total": 3,
  "generatedAt": "2026-07-15T10:00:00.000Z",
  "groups": [
    {
      "key": "legal", "label": "Legal / formal", "emoji": "⚖️", "count": 1,
      "tickets": [
        {
          "ticket_key": "NT-4755", "risk_score": 71,
          "summary": "Threatening to involve the ICO over data handling",
          "assignee": "Jane Doe", "priority": "High",
          "ticket_status": "In Progress", "current_tier": "T2",
          "project_key": "NT", "flagged_at": "2026-07-15T08:12:00Z",
          "sla_breached": false, "sla_breach_at": null,
          "category": "legal", "why": "Legal/formal escalation",
          "reasons": ["Legal/formal escalation", "Frustrated customer"]
        }
      ]
    }
  ]
}
```

Categories are `legal | angry | sla | stuck`. A flat `{ "tickets": [...] }` body is also accepted.
NOVA is the **source of truth** — every push is the *current* pending set, so NUERO should
**replace** its whole active set on each push (resolved/reviewed tickets then drop off).

---

## The five NUERO changes

### 1. `backend/db/schema.sql` — new table (after the `do_next` index)

```sql
-- NOVA flagged tickets ("Nick, look at this") — mirror of NOVA's risk scorer,
-- pushed in via POST /api/nova-signals. NOVA is source of truth; each push
-- replaces the whole active set, so resolved/reviewed tickets drop off.
CREATE TABLE IF NOT EXISTS nova_flags (
  ticket_key TEXT PRIMARY KEY,
  risk_score INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  why TEXT,
  summary TEXT,
  assignee TEXT,
  ticket_status TEXT,
  reasons TEXT,
  flagged_at DATETIME,
  synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 2. `backend/db/database.js` — helpers (after `deleteDoNext`) + add to `module.exports`

```js
// ── NOVA flags ("Nick, look at this") ──
// NOVA is the source of truth: each sync replaces the entire active set so
// tickets NOVA no longer flags (resolved / reviewed) disappear automatically.
function replaceNovaFlags(flags) {
  const d = getDb();
  d.run('DELETE FROM nova_flags');
  const stmt = d.prepare(
    `INSERT INTO nova_flags
       (ticket_key, risk_score, category, why, summary, assignee, ticket_status, reasons, flagged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const f of flags || []) {
    if (!f || !f.ticket_key) continue;
    stmt.run([
      f.ticket_key,
      Number(f.risk_score) || 0,
      f.category || null,
      f.why || null,
      f.summary || null,
      f.assignee || null,
      f.ticket_status || null,
      Array.isArray(f.reasons) ? JSON.stringify(f.reasons) : (f.reasons || null),
      f.flagged_at || null,
    ]);
  }
  stmt.free();
  save();
  return (flags || []).length;
}

function getActiveNovaFlags() {
  const stmt = getDb().prepare('SELECT * FROM nova_flags ORDER BY risk_score DESC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
```

Exports: add `replaceNovaFlags,` and `getActiveNovaFlags,`.

### 3. `backend/routes/nova-signals.js` — new file (mirrors `training-sync.js` machine-auth)

```js
'use strict';
const express = require('express');
const router = express.Router();
const db = require('../db/database');

router.post('/', (req, res, next) => {
  const guard = req.app.locals.requireApiClient;   // reject interactive PIN — machine only
  if (typeof guard === 'function') return guard(req, res, next);
  return next();
}, (req, res) => {
  try {
    const body = req.body || {};
    const tickets = Array.isArray(body.tickets)
      ? body.tickets
      : (Array.isArray(body.groups) ? body.groups.flatMap(g => g.tickets || []) : []);
    const count = db.replaceNovaFlags(tickets);
    res.json({ ok: true, stored: count });
  } catch (e) {
    console.error('[nova-signals]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
```

### 4. `backend/server.js` — one line (next to the other `app.use`s, e.g. after training)

```js
app.use('/api/nova-signals', require('./routes/nova-signals'));
```

### 5. `backend/services/decision-engine.js` — surface in Focus

Add `collectNovaFlags` (near the other collectors; `db` is already required at top):

```js
// NOVA flagged tickets ("Nick, look at this"). NOVA's risk scorer already did
// the hard judgement of what's concerning; here we just surface the worst few
// into Focus so they land top of the pile. Capped at 3 so they never flood.
function collectNovaFlags(ctx) {
  const items = [];
  let flags = [];
  try { flags = db.getActiveNovaFlags(); } catch { return items; }

  for (const f of flags.slice(0, 3)) {
    const risk = Number(f.risk_score) || 0;
    const isLegal = f.category === 'legal';
    const score = Math.max(55, Math.min(97, risk));   // clears Tier 1 (>=80) when severe
    items.push({
      type: 'nova_flag',
      id: `nova-${f.ticket_key}`,
      title: `${f.ticket_key} — ${f.why || 'flagged for review'}`,
      reason: isLegal ? 'NOVA: legal/formal — needs your eyes' : 'NOVA flagged this for your attention',
      score,
      urgency: risk >= 80 || isLegal ? 'critical' : risk >= 70 ? 'high' : 'medium',
      source: 'nova',
      actionHint: 'Open NOVA → Look at this',
      meta: { ticketKey: f.ticket_key, category: f.category, riskScore: risk, summary: f.summary, assignee: f.assignee },
      _unsuppressable: isLegal,
    });
  }
  return items;
}
```

Then add it to the `allSignals` array inside `evaluate()`:

```js
const allSignals = [
  ...collectEscalations(ctx),
  ...collectNovaFlags(ctx),      // <-- add this line
  ...collectMeetings(ctx),
  ...collectOverdueTodos(ctx),
  ...collectUrgentEmails(ctx),
  ...collectNudges(ctx),
  ...collectImports(ctx),
];
```

No MCP change needed — `get_focus` reads the same `evaluate()` output, so `nova_flag` items
appear automatically. Tier filtering / `FOCUS_MAX` already prevent flooding; the `slice(0, 3)`
is a second guard.

---

## Config / env

NUERO already has `NEURO_API_TOKEN` (machine auth) — no new env needed here.
On the **NOVA** side Nick must set two settings for the push to start firing:
- `neuro_push_url` — NUERO base URL (Pi 5, e.g. `http://100.100.28.58:3001`)
- `neuro_api_token` — must equal NUERO's `NEURO_API_TOKEN`

Until then NOVA logs nothing and posts nothing; the NUERO endpoint just never gets called.

---

## Test

```bash
# 1. POST a sample payload straight to NUERO (bypass NOVA)
curl -s -X POST http://localhost:3001/api/nova-signals \
  -H "X-Neuro-Api-Token: $NEURO_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"total":1,"groups":[{"key":"legal","label":"Legal / formal","emoji":"⚖️","count":1,
       "tickets":[{"ticket_key":"NT-9999","risk_score":88,"why":"Legal/formal escalation",
       "category":"legal","summary":"ICO threat","assignee":"Jane","flagged_at":"2026-07-15T08:00:00Z",
       "reasons":["Legal/formal escalation"]}]}]}'
# expect: {"ok":true,"stored":1}

# 2. Confirm it surfaces in Focus
curl -s http://localhost:3001/api/focus -H "X-Neuro-Pin: $NEURO_PIN" | jq '.items[] | select(.type=="nova_flag")'
# expect the NT-9999 item, tier 1, primary/near-top
```

Reject test: POST without `X-Neuro-Api-Token` → `403 API token required` (PIN alone must fail).

---

## Deploy (Pi 5)

Backend-only change — **no frontend rebuild needed**. On the Pi:
```bash
cd <nuero checkout> && git pull && source ~/.nvm/nvm.sh && pm2 restart <nuero process>
```
(SSH: `nickw@100.100.28.58`.) The `nova_flags` table is created on boot via `CREATE TABLE IF NOT EXISTS`.
Back up `agent.db` before restart if you want a safety net.

---

## Definition of done
- [ ] `POST /api/nova-signals` stores flags and rejects PIN-only callers
- [ ] `get_focus` / `GET /api/focus` shows the worst flag as a Tier-1 (legal = unsuppressable) item
- [ ] Repeated pushes replace, not duplicate (resolved tickets vanish)
- [ ] Committed WITHOUT entangling the concurrent `queue.js` / standup WIP
- [ ] Deployed to Pi + pm2 restarted; Nick sets `neuro_push_url` + `neuro_api_token` in NOVA
