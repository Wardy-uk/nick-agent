'use strict';

/**
 * VESTA — the shared home surface, mounted at /api/v and EXEMPT from the PIN
 * middleware. Served at its own address (vesta.nickward.co.uk).
 *
 *   POST /api/v/login    { username, pin } → a signed session token
 *   GET  /api/v/home     → everything this account may see, in one call
 *   POST /api/v/tasks    { text, for } → add a task
 *   POST /api/v/kitchen  { place, name } → something went in
 *   POST /api/v/kitchen/used { place, name } → something got eaten
 *
 * ⚠ THIS IS PUBLIC. pi5 runs Tailscale Funnel, so an auth exemption publishes
 * these routes to the internet, not merely to the tailnet. That is the point —
 * Nick's partner has no NEURO PIN and must never have one.
 *
 * Three rules hold the boundary, and all three are enforced HERE rather than in
 * the page:
 *
 *  • EVERY read is gated on a SCOPE the account actually holds, and scopes
 *    default closed. An account created before VESTA sees exactly what it saw
 *    yesterday: its own submissions and nothing else.
 *  • THE CALENDAR IS REDACTED IN THE SERVICE. A work subject never enters this
 *    file, so no handler can leak one by forgetting to.
 *  • THE ADMIN HALF IS NOT HERE. Creating accounts and granting scopes lives on
 *    /api/capture-links behind the PIN. An account that could widen its own
 *    scope would make the whole model decorative.
 *
 * ⚠ The mount is `/v/` and the exemption tests `startsWith('/v/')`, one letter
 * from `/v1/` (the FreeReps health wire) and deliberately not `/v`. Same care as
 * `/c/` versus `/capture-links`.
 */

const express = require('express');
const router = express.Router();
const capture = require('../services/capture-links');
const vesta = require('../services/vesta');
const catalogue = require('../services/catalogue');
const db = require('../db/database');

/**
 * Resolve the bearer session, or 401.
 *
 * ⚠ Re-reads the account every request rather than trusting the token's claim,
 * so revoking someone — or narrowing their scopes — takes effect immediately
 * rather than in twelve hours.
 */
function requireAccount(req, res, next) {
  const header = String(req.headers.authorization || '');
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const account = capture.resolveSession(token);
  if (!account) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
  req.account = account;
  next();
}

router.post('/login', (req, res) => {
  try {
    const result = capture.login(req.body && req.body.username, req.body && req.body.pin);
    if (!result.ok) return res.status(result.status || 401).json({ ok: false, error: result.error });
    const account = capture.resolveSession(result.token);
    res.json({
      ok: true,
      token: result.token,
      label: result.label,
      // The page renders only what it is allowed to ask for. This is a
      // CONVENIENCE for the UI, never the enforcement — every route below
      // re-checks, because a client is free to ask for anything.
      scopes: capture.scopesOf(account),
    });
  } catch (e) {
    console.error('[Vesta] Login failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

/**
 * Everything at once. One call because this is a fridge-door screen on a phone
 * over mobile data, and four round trips to render one page is three too many.
 *
 * Each block is independently guarded and reports its own failure: a kitchen
 * file that will not parse must not blank the calendar, and vice versa.
 */
router.get('/home', requireAccount, (req, res) => {
  const out = { ok: true, label: req.account.label, scopes: capture.scopesOf(req.account), gaps: [] };

  // ── Tasks ────────────────────────────────────────────────────────────────
  try {
    out.tasks = capture.submissions(req.account.username);
  } catch (e) {
    out.tasks = null;
    out.gaps.push({ block: 'tasks', why: e.message });
  }

  // ── Calendar ─────────────────────────────────────────────────────────────
  if (capture.hasScope(req.account, 'calendar')) {
    try {
      const now = new Date();
      const p = n => String(n).padStart(2, '0');
      const dayKey = d => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      const from = `${dayKey(now)}T00:00:00`;
      const to = `${dayKey(new Date(now.getTime() + 2 * 86400000))}T23:59:59`;
      // ⚠ Redacted by the SERVICE before it is anywhere near this handler.
      out.calendar = vesta.redactDay(db.getCalendarEvents(from, to) || []);
    } catch (e) {
      out.calendar = null;
      out.gaps.push({ block: 'calendar', why: e.message });
    }
  }

  // ── Catalogues ───────────────────────────────────────────────────────────
  //
  // The kitchen is one of these, not a special case. Only catalogues whose OWN
  // frontmatter says `shared: true` are reachable — his vinyl does not go on the
  // public internet because he made a list.
  if (capture.hasScope(req.account, 'kitchen')) {
    const shared = vesta.sharedCatalogues();
    if (!shared.ok) {
      out.catalogues = null;
      // ⚠ Unreadable is NOT empty. An empty freezer and an unmounted disk must
      // never render alike, or she shops for food that is already in.
      out.gaps.push({ block: 'catalogues', why: shared.why });
    } else {
      out.catalogues = shared.catalogues;
      const kitchen = vesta.readKitchen();
      if (kitchen.ok) {
        out.kitchen = kitchen.cat.items;
        out.kitchenSections = kitchen.cat.sections;
        out.meals = vesta.suggestMeals(kitchen.cat);
      } else if (!kitchen.notFound && !kitchen.notShared) {
        out.gaps.push({ block: 'kitchen', why: kitchen.why });
      }
    }
  }

  res.json(out);
});

// POST /api/v/tasks — reuses the existing submission path, so the throttle, the
// length cap and the personal-domain rule all still apply unchanged.
router.post('/tasks', requireAccount, (req, res) => {
  try {
    const result = capture.submit(req.account.username, req.body && req.body.text);
    if (!result.ok) return res.status(result.status || 400).json(result);
    res.json(result);
  } catch (e) {
    console.error('[Vesta] Task submit failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

function kitchenGate(req, res, next) {
  if (!capture.hasScope(req.account, 'kitchen')) {
    return res.status(403).json({ ok: false, error: 'Not enabled for this account.' });
  }
  next();
}

/**
 * ⚠ The scope grants the SHARED catalogues, never a slug of the caller's
 * choosing. Without this, a granted account could name any catalogue in the
 * vault and read it — the private ones are the entire reason `shared` exists.
 * Re-read every request rather than trusted from a list sent earlier.
 */
function sharedCatalogueOr404(slug, res) {
  const found = catalogue.read(slug);
  if (!found.ok) {
    res.status(found.notFound ? 404 : 400).json({ ok: false, error: found.why });
    return null;
  }
  if (found.cat.shared !== true) {
    // Deliberately the SAME answer a missing catalogue gives, so this cannot be
    // used to enumerate what he owns.
    res.status(404).json({ ok: false, error: 'no such catalogue' });
    return null;
  }
  return found;
}

router.post('/catalogue/:slug/add', requireAccount, kitchenGate, (req, res) => {
  if (!sharedCatalogueOr404(req.params.slug, res)) return;
  const { section, name } = req.body || {};
  const result = catalogue.addItem(req.params.slug, section, name);
  if (!result.ok) return res.status(result.notFound ? 404 : 400).json({ ok: false, error: result.why });
  res.json({ ok: true, already: !!result.already, items: result.cat.items, sections: result.cat.sections });
});

// `used` rather than DELETE: a POST works from a form on a phone with no fetch
// shenanigans, and the word says what actually happened.
router.post('/catalogue/:slug/used', requireAccount, kitchenGate, (req, res) => {
  if (!sharedCatalogueOr404(req.params.slug, res)) return;
  const { section, name } = req.body || {};
  const result = catalogue.removeItem(req.params.slug, section, name);
  if (!result.ok) return res.status(result.notFound ? 404 : 400).json({ ok: false, error: result.why });
  res.json({ ok: true, items: result.cat.items, sections: result.cat.sections });
});

module.exports = router;
