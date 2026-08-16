'use strict';

/**
 * #38 — resolving a name through an alias, and the fall-through that made the
 * first attempt worse than doing nothing.
 *
 * The obvious implementation adds an alias TIER to `matchLocal`. It is wrong,
 * and it fails silently on real data: `Nath` is Nathan Button's alias, Nathan
 * Button has no `email:` so he is not in the contact list at all, the alias tier
 * therefore matched nothing — and execution fell through to the "starts with"
 * tier, which returned Nathan RUTLAND. Verified against the live vault before
 * this was changed. A precise rule that degrades into a fuzzy one is worse than
 * no rule, because it is confidently wrong about which of two colleagues you
 * meant, and booking or emailing acts on that answer.
 *
 * So the alias canonicalises the QUERY up front and every tier below matches the
 * real name. These tests pin that, on a throwaway vault (#119).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-contact-'));
fs.mkdirSync(path.join(root, 'People'));
const write = (name, fm) =>
  fs.writeFileSync(path.join(root, 'People', `${name}.md`), `---\n${fm}\n---\n\nbody\n`);

// Mirrors the shape that produced the bug: an alias whose owner has no address,
// beside a different person whose name starts with the same letters.
write('Nathan Button', 'aliases:\n  - Nathan\n  - Nath');
write('Nathan Rutland', 'aliases:\n  - Nathan\nemail: nathan.rutland@example.test');
write('Sebastian Broome', 'aliases:\n  - Seb\nemail: seb.broome@example.test');
write('Naomi Wentworth', 'aliases:\n  - Naomi Winkworth\nemail: naomi.w@example.test');

process.env.OBSIDIAN_VAULT_PATH = root;
process.env.NEURO_DB_PATH = path.join(root, 'scratch.db');

// Keep the org directory out of it — this is about local resolution, and a real
// Graph call would make the test depend on whoever is signed in.
const microsoft = require('./microsoft');
const graphQueries = [];
microsoft.searchPeople = async (q) => { graphQueries.push(q); return []; };

const contacts = require('./contact-directory');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('an unambiguous alias resolves to its owner', async () => {
  const r = await contacts.resolveName('Seb');
  assert.strictEqual(r.status, 'resolved');
  assert.strictEqual(r.name, 'Sebastian Broome');
  assert.strictEqual(r.email, 'seb.broome@example.test');
});

test('a mis-transcribed name resolves to the real person', async () => {
  const r = await contacts.resolveName('Naomi Winkworth');
  assert.strictEqual(r.status, 'resolved');
  assert.strictEqual(r.name, 'Naomi Wentworth');
});

test('an alias never falls through onto a DIFFERENT person with a similar name', async () => {
  // The regression. `Nath` belongs to Nathan Button, who has no address; the
  // answer must be "no address for Nathan Button", never "Nathan Rutland".
  const r = await contacts.resolveName('Nath');
  assert.notStrictEqual(r.email, 'nathan.rutland@example.test', 'resolved to the WRONG Nathan');
  assert.strictEqual(r.status, 'unresolved');
  assert.strictEqual(r.aliasOf, 'Nathan Button', 'must still say who was meant');
});

test('the org directory is asked for the canonical name, not the alias', async () => {
  graphQueries.length = 0;
  await contacts.resolveName('Nath');
  assert.deepStrictEqual(graphQueries, ['Nathan Button'],
    'searching Graph for "Nath" is a guess; "Nathan Button" is not');
});

test('an alias two people claim resolves to nobody', async () => {
  // Both Nathans list `Nathan`, so it is not an identifier. It must not quietly
  // become one — and it must not report an aliasOf either.
  const r = await contacts.resolveName('Nathan');
  assert.strictEqual(r.aliasOf, undefined);
  assert.notStrictEqual(r.status, 'resolved');
});

test('a real full name still wins, and needs no alias', async () => {
  const r = await contacts.resolveName('Nathan Rutland');
  assert.strictEqual(r.status, 'resolved');
  assert.strictEqual(r.email, 'nathan.rutland@example.test');
});
