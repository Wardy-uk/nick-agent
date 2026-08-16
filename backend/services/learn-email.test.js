'use strict';

/**
 * #38 feedback loop — an address Nick types by hand is written back to the
 * People note, so the next chase to that person does not ask him again.
 *
 * The hazard here is not the loop, it is the WRITE. People notes carry `aliases:`
 * lists (30 of 41 of them), and `obsidian.updateFrontmatter` reserialises
 * frontmatter line by line and drops list values — so the obvious implementation
 * would silently delete the alias map the rest of #38 depends on, on the first
 * address ever learned. The regression test for that is the first one below and
 * it is the reason this is a hand-written single-line edit.
 *
 * Throwaway vault throughout (#119).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// `async` and awaited — a sync version's `finally` deletes the vault the moment
// an async callback yields, so every await inside it runs against a directory
// that is already gone. That failure looks exactly like the code being broken.
async function withVault(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'neuro-learn-'));
  fs.mkdirSync(path.join(root, 'People'));
  const prev = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = root;
  process.env.NEURO_DB_PATH = path.join(root, 'scratch.db');
  delete require.cache[require.resolve('./entities')];
  delete require.cache[require.resolve('./contact-directory')];

  // Keep the org directory out of it — a real Graph call would make these
  // depend on whoever happens to be signed in.
  require('./microsoft').searchPeople = async () => [];

  const write = (name, body) => fs.writeFileSync(path.join(root, 'People', `${name}.md`), body);
  const read = (name) => fs.readFileSync(path.join(root, 'People', `${name}.md`), 'utf-8');
  try {
    return await fn({ contacts: require('./contact-directory'), write, read, root });
  } finally {
    process.env.OBSIDIAN_VAULT_PATH = prev;
    delete require.cache[require.resolve('./entities')];
    delete require.cache[require.resolve('./contact-directory')];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const NOTE = '---\naliases:\n  - Heidi\n  - H\nrole: Support Lead\ncadence: fortnightly\n---\n\nNotes about Heidi.\n';

test('learning an address does NOT destroy the aliases list', async () => {
  await withVault(({ contacts, write, read }) => {
    write('Heidi Power', NOTE);
    const r = contacts.learnEmail('Heidi', 'heidi.power@example.test');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.person, 'Heidi Power');

    const after = read('Heidi Power');
    assert.match(after, /email: heidi\.power@example\.test/);
    // The whole point of the hand-written edit.
    assert.match(after, /aliases:\n {2}- Heidi\n {2}- H/, 'aliases list was mangled');
    assert.match(after, /role: Support Lead/);
    assert.match(after, /cadence: fortnightly/);
    assert.match(after, /Notes about Heidi\./, 'body must be untouched');
  });
});

test('the learned address is usable immediately — the cache is invalidated', async () => {
  await withVault(async ({ contacts, write }) => {
    write('Heidi Power', NOTE);
    const before = await contacts.resolveName('Heidi');
    assert.notStrictEqual(before.status, 'resolved', 'sanity: no address yet');

    contacts.learnEmail('Heidi', 'heidi.power@example.test');

    const after = await contacts.resolveName('Heidi');
    assert.strictEqual(after.status, 'resolved');
    assert.strictEqual(after.email, 'heidi.power@example.test');
  });
});

test('an existing address is never overwritten', async () => {
  await withVault(({ contacts, write, read }) => {
    write('Heidi Power', '---\naliases:\n  - Heidi\nemail: real@example.test\n---\n\nbody\n');
    const r = contacts.learnEmail('Heidi', 'typo@example.test');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'already-set');
    assert.match(read('Heidi Power'), /email: real@example\.test/);
  });
});

test('an ambiguous first name learns nothing', async () => {
  await withVault(({ contacts, write, read }) => {
    write('Chris Middleton', '---\naliases:\n  - Chris\n---\n\nbody\n');
    write('Chris Smith', '---\naliases:\n  - Chris\n---\n\nbody\n');
    const r = contacts.learnEmail('Chris', 'chris@example.test');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-person-note');
    assert.ok(!/email:/.test(read('Chris Middleton')), 'must not guess a Chris');
    assert.ok(!/email:/.test(read('Chris Smith')));
  });
});

test('a name with no People note creates nothing', async () => {
  await withVault(({ contacts, root }) => {
    const r = contacts.learnEmail('Someone External', 'ext@example.test');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'no-person-note');
    assert.deepStrictEqual(fs.readdirSync(path.join(root, 'People')), []);
  });
});

test('the note is backed up before it is touched', async () => {
  await withVault(({ contacts, write, root }) => {
    write('Heidi Power', NOTE);
    contacts.learnEmail('Heidi', 'heidi.power@example.test');
    const backups = path.join(root, 'Scripts', '.lint-backups');
    const stamps = fs.readdirSync(backups);
    assert.strictEqual(stamps.length, 1);
    const saved = fs.readFileSync(path.join(backups, stamps[0], 'Heidi Power.md'), 'utf-8');
    assert.strictEqual(saved, NOTE, 'the backup must be the ORIGINAL, pre-edit');
  });
});

test('a CRLF note stays CRLF', async () => {
  await withVault(({ contacts, write, read }) => {
    write('Heidi Power', NOTE.replace(/\n/g, '\r\n'));
    assert.strictEqual(contacts.learnEmail('Heidi', 'h@example.test').ok, true);
    const after = read('Heidi Power');
    assert.ok(after.includes('\r\n'), 'line endings were rewritten');
    assert.ok(!/[^\r]\n/.test(after), 'mixed line endings introduced');
    assert.match(after, /email: h@example\.test/);
  });
});

test('rubbish input is refused rather than written', async () => {
  await withVault(({ contacts, write, read }) => {
    write('Heidi Power', NOTE);
    assert.strictEqual(contacts.learnEmail('Heidi', 'not-an-address').ok, false);
    assert.strictEqual(contacts.learnEmail('', 'h@example.test').ok, false);
    assert.ok(!/email:/.test(read('Heidi Power')));
  });
});
