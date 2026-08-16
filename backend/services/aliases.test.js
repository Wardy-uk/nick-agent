'use strict';

/**
 * #38 — `aliases:` frontmatter, and the trap in the ticket.
 *
 * The ticket said wiring aliases in would "let the entity roster resolve first
 * names that are currently skipped as ambiguous (`nathan`, `andrea`, `chris` —
 * three of my team)". Measured against the live vault it does the opposite:
 * `Chris` is listed as an alias on BOTH Chris Middleton and Chris Smith, and
 * `Nathan` on both Nathans. The aliases do not disambiguate those names, they
 * assert them twice — so trusting them would re-create the exact bug
 * `firstNames` exists to prevent (mistakes.md, 15 Aug: one Lucy's 16
 * commitments attributed to four different Lucys).
 *
 * These tests build a throwaway People/ folder rather than reading Nick's vault
 * — see #119 for why that matters. They pin the three rejection rules and the
 * two parser forms; the second rejection rule is the one the ticket missed and
 * the one a naive implementation gets wrong.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function withVault(people, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-aliases-'));
  fs.mkdirSync(path.join(root, 'People'));
  for (const [name, body] of Object.entries(people)) {
    fs.writeFileSync(path.join(root, 'People', `${name}.md`), body);
  }
  const prev = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = root;
  // entities captures VAULT_PATH at require time, so load it fresh per vault.
  delete require.cache[require.resolve('./entities')];
  try {
    return fn(require('./entities'));
  } finally {
    process.env.OBSIDIAN_VAULT_PATH = prev;
    delete require.cache[require.resolve('./entities')];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const note = (aliases, inline = false) => aliases === null
  ? '---\nrole: engineer\n---\n\nbody\n'
  : inline
    ? `---\naliases: [${aliases.join(', ')}]\nrole: engineer\n---\n\nbody\n`
    : `---\naliases:\n${aliases.map(a => `  - ${a}`).join('\n')}\nrole: engineer\n---\n\nbody\n`;

test('readAliases handles both forms the vault actually contains', () => {
  const { readAliases } = require('./entities');
  assert.deepStrictEqual(readAliases(note(['Seb', 'Sebastian B'])), ['Seb', 'Sebastian B']);
  assert.deepStrictEqual(readAliases(note(['Seb', 'Sebastian B'], true)), ['Seb', 'Sebastian B']);
  assert.deepStrictEqual(readAliases(note(null)), []);
  assert.deepStrictEqual(readAliases(''), []);
});

test('readAliases survives CRLF — the vault is mixed line endings', () => {
  const { readAliases } = require('./entities');
  const crlf = note(['Seb', 'Nath']).replace(/\n/g, '\r\n');
  assert.deepStrictEqual(readAliases(crlf), ['Seb', 'Nath']);
});

test('readAliases stops at the next frontmatter key', () => {
  const { readAliases } = require('./entities');
  const src = '---\naliases:\n  - Seb\nrole: engineer\ntags:\n  - team\n---\n\nbody\n';
  assert.deepStrictEqual(readAliases(src), ['Seb']);
});

test('an alias two people claim is refused — the bug the ticket would have shipped', () => {
  withVault({
    'Chris Middleton': note(['Chris', 'Chris M']),
    'Chris Smith': note(['Chris', 'Chris S']),
  }, (entities) => {
    const { aliases } = entities.getRoster();
    assert.strictEqual(aliases.has('chris'), false, '`Chris` is claimed by two people');
    assert.strictEqual(aliases.get('chris m'), 'Chris Middleton');
    assert.strictEqual(aliases.get('chris s'), 'Chris Smith');
    assert.deepStrictEqual(entities.extractEntities('Chris said he would look').people, []);
    assert.deepStrictEqual(
      entities.extractEntities('Chris S said he would look').people, ['Chris Smith']
    );
  });
});

test('an alias that is an ambiguous FIRST name is refused even when only one note claims it', () => {
  // The rule the ticket missed. Only Andrea Melisa lists `Andrea`, so counting
  // alias claims alone resolves it — while the bare first name correctly does
  // not, because a second Andrea exists on the roster.
  withVault({
    'Andrea Melisa': note(['Andrea']),
    'Andrea Glykofrydis': note(null),
  }, (entities) => {
    const { aliases, firstNames } = entities.getRoster();
    assert.strictEqual(firstNames.has('andrea'), false, 'sanity: two Andreas on the roster');
    assert.strictEqual(
      aliases.has('andrea'), false,
      'one note claiming it is not enough — the roster still has two Andreas'
    );
    assert.deepStrictEqual(entities.extractEntities('Andrea is on it').people, []);
  });
});

test("an alias that is somebody else's full name is refused", () => {
  withVault({
    'Steve Ryan': note(['Steve R', 'Paul Adams']),
    'Paul Adams': note(['Paul']),
  }, (entities) => {
    const { aliases } = entities.getRoster();
    assert.strictEqual(aliases.get('paul adams'), undefined, 'a real person owns that name');
    assert.strictEqual(aliases.get('steve r'), 'Steve Ryan');
    assert.deepStrictEqual(entities.extractEntities('Paul Adams replied').people, ['Paul Adams']);
  });
});

test('an unambiguous alias resolves to the FULL name, including a mis-transcription', () => {
  withVault({
    'Naomi Wentworth': note(['Naomi', 'Naomi Winkworth']),
    'Sebastian Broome': note(['Seb']),
  }, (entities) => {
    const { aliases } = entities.getRoster();
    assert.strictEqual(aliases.get('naomi winkworth'), 'Naomi Wentworth');
    assert.strictEqual(aliases.get('seb'), 'Sebastian Broome');
    // Storing the full name is what makes it reach the person's page — a
    // mention stored as "Seb" matches nothing on an exact-name lookup.
    assert.deepStrictEqual(
      entities.extractEntities('Naomi Winkworth raised it with Seb').people.sort(),
      ['Naomi Wentworth', 'Sebastian Broome']
    );
  });
});

test('alias matching is whole-word — "Seb" must not fire inside "Sebastopol"', () => {
  withVault({ 'Sebastian Broome': note(['Seb']) }, (entities) => {
    assert.deepStrictEqual(entities.extractEntities('the Sebastopol account').people, []);
    assert.deepStrictEqual(entities.extractEntities('asked Seb.').people, ['Sebastian Broome']);
  });
});
