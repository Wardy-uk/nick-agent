'use strict';

/**
 * #13 — the roster is derived from People/ frontmatter, not typed into arrays.
 *
 * Six copies of the same name list had drifted four ways (Arman left, Willem
 * moved teams, Nathan Rutland and Sebastian Broome on the wrong lines) and the
 * vault was right about every one. These pin the rules that make deriving it
 * safe — most importantly that an archived person is gone and that a first name
 * is only an identifier when it points at exactly one person.
 *
 * Runs against a temp fixture vault. `npm test` must never touch the real one
 * (#119), and the fixture is what lets the assertions be positive rather than
 * pass-by-absence.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const roster = require('./team-roster');

function person(dir, name, fm) {
  fs.writeFileSync(path.join(dir, 'People', `${name}.md`), `---\n${fm}---\n\n## Notes\n`, 'utf-8');
}

/**
 * MUST be async and awaited — a sync scope-guard around an async callback runs
 * its `finally` the moment the body first awaits, deleting the fixture
 * mid-test, which then looks exactly like the feature being broken
 * (mistakes.md, 17 Aug).
 */
async function withVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
  fs.mkdirSync(path.join(dir, 'People'), { recursive: true });
  const prev = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = dir;
  try {
    roster.readPeople({ force: true });
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = prev;
    roster.readPeople({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The live shape, reduced: two lines, a production pair, one leaver, one team
// mover, and a non-report who shares a first name with a report.
function seed(dir) {
  person(dir, 'Abdi Mohamed', 'type: person\nteam: Support\nline: 2nd Line\ndirect-report: true\nstatus: Active\n');
  person(dir, 'Sebastian Broome', 'type: person\nteam: Support\nline: 2nd Line\ndirect-report: true\nstatus: Active\n');
  person(dir, 'Zoe Rees', 'type: person\nteam: Support\nline: 1st Line\ndirect-report: true\nstatus: Active\n');
  person(dir, 'Nathan Rutland', 'type: person\nteam: Support\nline: 1st Line\ndirect-report: true\nstatus: Active\n');
  person(dir, 'Isabel Busk', 'type: person\nteam: Production\nline: Production\ndirect-report: true\nstatus: Active\n');
  // Left the business — direct-report false AND archived true, as the live note is.
  person(dir, 'Arman Shazad', 'type: person\nteam: Support\nline: 2nd Line\ndirect-report: false\narchived: true\nstatus: Left the business\narchived-reason: Left the business\n');
  // Moved teams — same exclusion, different reason.
  person(dir, 'Willem Kruger', 'type: person\nteam: Support\nline: 2nd Line\ndirect-report: false\narchived: true\nstatus: Moved to another team\n');
  // Not a report, and shares a first name with one.
  person(dir, 'Nathan Button', 'type: person\nteam: TOM\n');
  person(dir, 'Chris Middleton', 'type: person\nteam: Infrastructure\n');
  person(dir, '_about', 'type: index\n');
  roster.readPeople({ force: true });
}

test('a departed employee is not a direct report — the ticket', async () => {
  await withVault(async dir => {
    seed(dir);
    const names = roster.directReports().map(p => p.name);
    assert.ok(!names.includes('Arman Shazad'), 'Arman left the business');
    assert.ok(!names.includes('Willem Kruger'), 'Willem moved teams');
    assert.ok(roster.isDirectReport('Abdi Mohamed'));
    assert.equal(roster.isDirectReport('Arman Shazad'), false);
  });
});

test('only actual direct reports count — a manager is not one of Nick\'s people', async () => {
  await withVault(async dir => {
    seed(dir);
    const names = roster.directReports().map(p => p.name);
    // The reason `entities.getRoster()` alone could not do this job: it knows
    // every name in the vault, including the ones above Nick and outside his org.
    assert.ok(!names.includes('Chris Middleton'));
    assert.ok(!names.includes('Nathan Button'));
    assert.deepEqual(names.sort(), [
      'Abdi Mohamed', 'Isabel Busk', 'Nathan Rutland', 'Sebastian Broome', 'Zoe Rees',
    ]);
  });
});

test('_about.md is not a person', async () => {
  await withVault(async dir => {
    seed(dir);
    assert.ok(!roster.readPeople().some(p => p.name === '_about'));
  });
});

test('teams come from the vault, so the two mis-filed people land correctly', async () => {
  await withVault(async dir => {
    seed(dir);
    const t = roster.teams();
    // The hardcoded array had Sebastian on 1st Line and Nathan Rutland on 2nd.
    // The vault says the opposite and the vault is right.
    assert.ok(t['2nd Line Technical Support'].includes('Sebastian Broome'));
    assert.ok(t['1st Line Customer Care'].includes('Nathan Rutland'));
    assert.ok(!t['2nd Line Technical Support'].includes('Nathan Rutland'));
    assert.ok(!t['1st Line Customer Care'].includes('Sebastian Broome'));
  });
});

test('the existing display labels are preserved, so the board does not silently rename', async () => {
  await withVault(async dir => {
    seed(dir);
    assert.deepEqual(roster.teamNames(), [
      '1st Line Customer Care', '2nd Line Technical Support', 'Digital Design',
    ]);
  });
});

test('an archived person does not leave an empty team behind', async () => {
  await withVault(async dir => {
    person(dir, 'Only Member', 'type: person\nteam: Support\nline: 2nd Line\ndirect-report: false\narchived: true\n');
    roster.readPeople({ force: true });
    assert.deepEqual(roster.teams(), {});
  });
});

test('an unmapped team appears as itself rather than vanishing', async () => {
  await withVault(async dir => {
    person(dir, 'New Person', 'type: person\nteam: Platform\nline: 3rd Line\ndirect-report: true\n');
    roster.readPeople({ force: true });
    // Dropping the unknown is how a roster silently under-reports — the exact
    // bug one level up. It must show up as its own words.
    assert.deepEqual(roster.teamNames(), ['Platform — 3rd Line']);
  });
});

test('a team with no line is labelled by team alone', async () => {
  await withVault(async dir => {
    person(dir, 'Solo Person', 'type: person\nteam: Platform\ndirect-report: true\n');
    roster.readPeople({ force: true });
    assert.deepEqual(roster.teamNames(), ['Platform']);
  });
});

test('a first name identifies a report only when it points at exactly one person', async () => {
  await withVault(async dir => {
    seed(dir);
    const first = roster.reportFirstNames();
    // Nathan Rutland IS a report, but Nathan Button exists, so "Nathan" is not
    // an identifier. Ambiguity is judged against the whole vault, not the
    // reports — the narrower test is what put one Lucy's items on four Lucys.
    assert.equal(first.has('nathan'), false);
    assert.equal(first.get('abdi'), 'Abdi Mohamed');
    assert.equal(first.get('zoe'), 'Zoe Rees');
    // Not a report at all, however unambiguous the name.
    assert.equal(first.has('chris'), false);
  });
});

test('the prompt block lists the live roster and omits the departed', async () => {
  await withVault(async dir => {
    seed(dir);
    const block = roster.promptBlock();
    assert.ok(block.startsWith("## Nick's direct reports"));
    assert.ok(block.includes('Abdi Mohamed'));
    assert.ok(!block.includes('Arman'), 'a departed name must never reach the model');
    assert.ok(!block.includes('Willem'));
    assert.ok(block.includes('1st Line Customer Care: Nathan Rutland, Zoe Rees'));
  });
});

test('no vault degrades to empty, never to a guess', async () => {
  const prev = process.env.OBSIDIAN_VAULT_PATH;
  delete process.env.OBSIDIAN_VAULT_PATH;
  try {
    roster.readPeople({ force: true });
    // Required at module load by the chat prompt, and npm test runs with no
    // vault (#119). It must not throw, and must not invent anyone.
    assert.deepEqual(roster.readPeople(), []);
    assert.deepEqual(roster.directReports(), []);
    assert.deepEqual(roster.teams(), {});
    assert.equal(roster.promptBlock(), '');
    assert.equal(roster.isDirectReport('Abdi Mohamed'), false);
  } finally {
    if (prev !== undefined) process.env.OBSIDIAN_VAULT_PATH = prev;
    roster.readPeople({ force: true });
  }
});

test('the cache is keyed on the vault path, so a fixture is never served live data', async () => {
  // Deliberately NOT using withVault: it forces a refresh on entry, which would
  // reset the cache and make this assertion pass without the keying existing.
  // The point is to leave a WARM cache and then move the vault underneath it.
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-b-'));
  const prev = process.env.OBSIDIAN_VAULT_PATH;
  try {
    for (const d of [a, b]) fs.mkdirSync(path.join(d, 'People'), { recursive: true });
    person(a, 'Vault A Person', 'type: person\nteam: Support\nline: 1st Line\ndirect-report: true\n');
    person(b, 'Vault B Person', 'type: person\nteam: Support\nline: 1st Line\ndirect-report: true\n');

    process.env.OBSIDIAN_VAULT_PATH = a;
    roster.readPeople({ force: true });
    assert.deepEqual(roster.directReports().map(p => p.name), ['Vault A Person'], 'cache is warm on A');

    // Switch vaults and read WITHOUT forcing, well inside the 5-minute TTL. A
    // TTL-only cache would still answer with A's people here.
    process.env.OBSIDIAN_VAULT_PATH = b;
    assert.deepEqual(roster.directReports().map(p => p.name), ['Vault B Person']);
  } finally {
    if (prev === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = prev;
    roster.readPeople({ force: true });
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});

test('CRLF frontmatter parses — the vault is Windows-authored', async () => {
  await withVault(async dir => {
    fs.writeFileSync(
      path.join(dir, 'People', 'Crlf Person.md'),
      '---\r\ntype: person\r\nteam: Support\r\nline: 1st Line\r\ndirect-report: true\r\n---\r\n\r\n## Notes\r\n',
      'utf-8'
    );
    roster.readPeople({ force: true });
    // `\r` is a JS line terminator, so an un-normalised line-anchored parse
    // silently returns nothing and the person disappears with no error.
    assert.deepEqual(roster.directReports().map(p => p.name), ['Crlf Person']);
    assert.equal(roster.directReports()[0].line, '1st Line');
  });
});

test('a quoted or oddly-cased boolean still reads as true', async () => {
  await withVault(async dir => {
    person(dir, 'Quoted Person', 'type: person\nteam: Support\nline: 1st Line\ndirect-report: "true"\n');
    person(dir, 'Cased Person', 'type: person\nteam: Support\nline: 1st Line\ndirect-report: True\n');
    roster.readPeople({ force: true });
    assert.equal(roster.directReports().length, 2);
  });
});

test('a list field does not leak into the scalar frontmatter', async () => {
  await withVault(async dir => {
    person(dir, 'Alias Person', 'type: person\naliases:\n  - Ali\n  - Al\nteam: Support\nline: 1st Line\ndirect-report: true\n');
    roster.readPeople({ force: true });
    const p = roster.directReports()[0];
    assert.equal(p.name, 'Alias Person');
    assert.equal(p.team, 'Support');
  });
});
