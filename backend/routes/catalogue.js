'use strict';

/**
 * /api/catalogues — Nick's own cataloguing, behind the PIN like everything else.
 *
 * The same engine VESTA reads through, and that is the point: the kitchen his
 * partner adds to and the vinyl collection only he sees are the same kind of
 * object, in the same folder, in the same format.
 *
 * ⚠ Creating a catalogue and marking one SHARED live HERE, never on the public
 * `/api/v` mount. An account that could share a catalogue with itself would make
 * the flag decorative.
 */

const express = require('express');
const router = express.Router();
const catalogue = require('../services/catalogue');

router.get('/', (req, res) => {
  const listed = catalogue.list();
  if (!listed.ok) return res.status(500).json({ ok: false, error: listed.why });
  res.json(listed);
});

router.get('/:slug', (req, res) => {
  const found = catalogue.read(req.params.slug);
  if (!found.ok) return res.status(found.notFound ? 404 : 500).json({ ok: false, error: found.why });
  res.json({ ok: true, slug: found.slug, ...found.cat, count: catalogue.counts(found.cat) });
});

router.post('/', (req, res) => {
  const { title, sections, shared } = req.body || {};
  const result = catalogue.create({ title, sections, shared });
  if (!result.ok) return res.status(400).json({ ok: false, error: result.why });
  res.json({ ok: true, slug: result.slug, ...result.cat });
});

router.post('/:slug/add', (req, res) => {
  const { section, name } = req.body || {};
  const result = catalogue.addItem(req.params.slug, section, name);
  if (!result.ok) return res.status(result.notFound ? 404 : 400).json({ ok: false, error: result.why });
  res.json({ ok: true, already: !!result.already, ...result.cat });
});

router.post('/:slug/remove', (req, res) => {
  const { section, name } = req.body || {};
  const result = catalogue.removeItem(req.params.slug, section, name);
  if (!result.ok) return res.status(result.notFound ? 404 : 400).json({ ok: false, error: result.why });
  res.json({ ok: true, ...result.cat });
});

/**
 * Share or unshare. Its own route rather than a field on a general update,
 * because it is the one change with a consequence outside the house — it puts a
 * list on the public internet, and that deserves to be a deliberate call rather
 * than a key in a PATCH body.
 */
router.post('/:slug/shared', (req, res) => {
  const found = catalogue.read(req.params.slug);
  if (!found.ok) return res.status(found.notFound ? 404 : 500).json({ ok: false, error: found.why });
  found.cat.shared = (req.body || {}).shared === true;
  const written = catalogue.write(req.params.slug, found.cat);
  if (!written.ok) return res.status(500).json({ ok: false, error: written.why });
  res.json({ ok: true, slug: catalogue.slugFor(req.params.slug), shared: found.cat.shared });
});

module.exports = router;
