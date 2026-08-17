'use strict';

/**
 * A team filter that does not match must ERROR, not quietly widen to everyone.
 *
 * Found while verifying #13 against the running Pi: `?team=Nope` answered
 * `ok:true` with all 39 issues and `team: "Nope"` in the body. `allPeople()`
 * falls back to the whole roster when the filter misses, so the existing
 * `!people.length` guard could only fire when the roster itself was empty and
 * the "Unknown team" message was unreachable.
 *
 * Same species as every other silent cap here: the caller cannot tell the
 * filter was ignored, so a scoped question comes back with an unscoped answer
 * wearing the scope's label.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const teamHealth = require('./team-health');
const roster = require('./team-roster');

async function withVault(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-'));
  fs.mkdirSync(path.join(dir, 'People'), { recursive: true });
  const prev = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = dir;
  try {
    fs.writeFileSync(
      path.join(dir, 'People', 'Abdi Mohamed.md'),
      '---\ntype: person\nteam: Support\nline: 2nd Line\ndirect-report: true\n---\n\n## Notes\n',
      'utf-8'
    );
    roster.readPeople({ force: true });
    return await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.OBSIDIAN_VAULT_PATH;
    else process.env.OBSIDIAN_VAULT_PATH = prev;
    roster.readPeople({ force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an unknown team is an error, not the whole roster relabelled', async () => {
  await withVault(async () => {
    const out = teamHealth.teamHealthSnapshot({ team: 'Nope' });
    assert.equal(out.status, 'error');
    assert.match(out.error, /Unknown team: Nope/);
    // The message must name the real options, from the derived roster.
    assert.match(out.error, /2nd Line Technical Support/);
    assert.ok(!out.issues, 'an unknown team returns no issues at all');
  });
});

test('a known team still filters normally', async () => {
  await withVault(async () => {
    const out = teamHealth.teamHealthSnapshot({ team: '2nd Line Technical Support' });
    assert.equal(out.status, 'ok');
    assert.equal(out.team, '2nd Line Technical Support');
  });
});

test('no filter returns the whole roster, as before', async () => {
  await withVault(async () => {
    const out = teamHealth.teamHealthSnapshot({});
    assert.equal(out.status, 'ok');
  });
});

test('TEAMS is live, not frozen at module load', async () => {
  await withVault(async dir => {
    assert.deepEqual(Object.keys(teamHealth.TEAMS), ['2nd Line Technical Support']);
    fs.writeFileSync(
      path.join(dir, 'People', 'New Starter.md'),
      '---\ntype: person\nteam: Platform\ndirect-report: true\n---\n\n## Notes\n',
      'utf-8'
    );
    roster.readPeople({ force: true });
    // A frozen snapshot is exactly what made the old hardcoded list wrong.
    assert.deepEqual(Object.keys(teamHealth.TEAMS).sort(), ['2nd Line Technical Support', 'Platform']);
  });
});
