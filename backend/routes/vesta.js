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
const vestaVision = require('../services/vesta-vision');
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
    out.tasks = capture.submissions(req.account);
  } catch (e) {
    out.tasks = null;
    out.gaps.push({ block: 'tasks', why: e.message });
  }

  // ── Calendar ─────────────────────────────────────────────────────────────
  if (capture.hasScope(req.account, 'calendar')) {
    try {
      // TODAY only. The home screen answers "what is happening now"; any other
      // day is a deliberate ask and goes through /calendar below. A rolling
      // three-day list was neither one thing nor the other — too long to scan
      // at a glance and too short to plan against.
      out.calendar = vesta.redactDay(db.getCalendarEvents(dayBounds(_today()).from, dayBounds(_today()).to) || []);
      out.calendarDate = _today();
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
        // Whether the camera button is worth showing at all. The same principle
        // as `scopes`: the page renders what it is allowed to, rather than
        // offering a control that answers 503 when tapped. Still not the
        // enforcement — the route re-checks the flag on every call.
        out.photo = vestaVision.isEnabled();
      } else if (!kitchen.notFound && !kitchen.notShared) {
        out.gaps.push({ block: 'kitchen', why: kitchen.why });
      }
    }
  }

  res.json(out);
});


// ⚠ Local getters, never toISOString() — that shifts to UTC and lands the whole
// query on the wrong day west of here, which is the calendar bug NEURO has
// already had once.
function _pad(n) { return String(n).padStart(2, '0'); }
function _today() {
  const d = new Date();
  return `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
}
function dayBounds(dateKey) {
  return { from: `${dateKey}T00:00:00`, to: `${dateKey}T23:59:59` };
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * One day of his diary, redacted, for the date picker.
 *
 * Gated on the SAME `calendar` scope as the home block — a second door to the
 * same data with a weaker lock is how a scope becomes decorative.
 *
 * ⚠ The date is validated against a strict pattern rather than fed to `new
 * Date()`, which happily accepts nonsense and answers for some other day.
 */
router.get('/calendar', requireAccount, (req, res) => {
  if (!capture.hasScope(req.account, 'calendar')) {
    return res.status(403).json({ ok: false, error: 'Not enabled for this account.' });
  }
  const date = String((req.query && req.query.date) || '') || _today();
  if (!DATE_RE.test(date)) {
    return res.status(400).json({ ok: false, error: 'that is not a date I understand' });
  }
  try {
    const { from, to } = dayBounds(date);
    res.json({ ok: true, date, events: vesta.redactDay(db.getCalendarEvents(from, to) || []) });
  } catch (e) {
    console.error('[Vesta] Calendar day failed:', e.message);
    // ⚠ `events: null` with a reason, never an empty array — "I could not read
    // your diary" and "nothing on that day" must not render alike.
    res.status(500).json({ ok: false, error: 'I could not read the diary just now.' });
  }
});

// POST /api/v/tasks — reuses the existing submission path, so the throttle, the
// length cap and the personal-domain rule all still apply unchanged.
router.post('/tasks', requireAccount, (req, res) => {
  try {
    const result = capture.submit(req.account, req.body && req.body.text);
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

/**
 * A photograph of the shelf, turned into a list she confirms.
 *
 * ⚠ IT CREATES NOTHING. The response is a PROPOSAL; each item she keeps is then
 * added through `/catalogue/:slug/add` above, exactly as a typed one is. That is
 * Nick's own condition on this feature and it is also the safe shape — a vision
 * model is right most of the time, and "most of the time" is not good enough to
 * write a fact about the freezer that somebody will shop against.
 *
 * ⚠ The photo is never stored, never logged and never echoed back. It lives in
 * memory for this request only. See `services/vesta-vision.js`.
 *
 * Gated three deep, because this is the one route on the public mount that
 * spends money: the `kitchen` scope, `VESTA_PHOTO_ENABLED` (default FALSE), and
 * a per-account daily cap.
 */
router.post('/catalogue/:slug/scan', requireAccount, kitchenGate, async (req, res) => {
  const found = sharedCatalogueOr404(req.params.slug, res);
  if (!found) return;

  const { image, mediaType } = req.body || {};
  try {
    const result = await vestaVision.proposeFromPhoto({
      username: req.account.username,
      imageBase64: image,
      mediaType,
      // The catalogue's REAL sections, read fresh — never a list the client
      // sent, which would let a caller name a section it invented.
      sections: found.cat.sections,
    });
    if (!result.ok) {
      // 503 when the feature is off or unreachable, 429 when she has used the
      // day's allowance, 400 when the photo itself is the problem. Distinct
      // because the thing to do about each is different.
      const status = result.disabled ? 503 : (result.cap && result.used >= result.cap) ? 429 : 400;
      return res.status(status).json({ ok: false, error: result.why });
    }
    res.json({ ok: true, proposed: result.proposed, used: result.used, cap: result.cap });
  } catch (e) {
    // ⚠ Never the raw message — this mount is public and the message can carry
    // model, key and account detail.
    console.error('[Vesta] Photo scan failed:', e.message);
    res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
});

module.exports = router;
