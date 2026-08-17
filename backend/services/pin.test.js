'use strict';

/**
 * Changing the PIN from the UI.
 *
 * The rules are pure and the file write is atomic, so both are testable without
 * touching the real `.env` (#119). What these mostly pin is the failure
 * behaviour: a bad write must leave the running system working, and a rejected
 * PIN must say which field was wrong.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pin = require('./pin');

const SAMPLE_ENV = [
  '# NEURO config',
  'NEURO_PIN=140277',
  'NEURO_API_TOKEN=abc123',
  'OPENROUTER_MODEL=google/gemini-2.5-flash',
  '',
].join('\n');

async function withEnv(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, contents, 'utf-8');
  const prevPath = process.env.NEURO_ENV_PATH;
  const prevPin = process.env.NEURO_PIN;
  process.env.NEURO_ENV_PATH = file;
  process.env.NEURO_PIN = '140277';
  try {
    return await fn(file, dir);
  } finally {
    if (prevPath === undefined) delete process.env.NEURO_ENV_PATH; else process.env.NEURO_ENV_PATH = prevPath;
    if (prevPin === undefined) delete process.env.NEURO_PIN; else process.env.NEURO_PIN = prevPin;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── validation ────────────────────────────────────────────────────────────

test('a good PIN passes', () => {
  assert.equal(pin.validate('528193', { current: '140277' }), null);
});

test('non-digits are refused — the Watch and both PWAs use a number pad', () => {
  assert.match(pin.validate('12ab56', { current: '1' }), /digits only/);
  assert.match(pin.validate('abcdef', { current: '1' }), /digits only/);
});

test('length is bounded at both ends', () => {
  assert.match(pin.validate('123', { current: '1' }), /4–12 digits/);
  assert.match(pin.validate('1234567890123', { current: '1' }), /4–12 digits/);
});

test('reusing the current PIN is refused', () => {
  assert.match(pin.validate('140277', { current: '140277' }), /already your PIN/);
});

test('the two PINs everyone tries first are refused', () => {
  // This guards every /api route on a host that serves publicly via Funnel.
  assert.match(pin.validate('000000', { current: '1' }), /same digit/);
  assert.match(pin.validate('123456', { current: '1' }), /Sequential/);
  assert.match(pin.validate('654321', { current: '1' }), /Sequential/);
  // ...but a PIN that merely contains a run is fine.
  assert.equal(pin.validate('123480', { current: '1' }), null);
});

test('an empty PIN asks for one rather than erroring obscurely', () => {
  assert.match(pin.validate('', { current: '1' }), /Enter a new PIN/);
});

// ── the .env rewrite ──────────────────────────────────────────────────────

test('only the NEURO_PIN line changes', () => {
  const out = pin.replacePinLine(SAMPLE_ENV, '528193');
  assert.ok(out.includes('NEURO_PIN=528193'));
  assert.ok(!out.includes('140277'));
  // Everything else must survive — a botched write here takes out every
  // setting in the file, not just the PIN.
  assert.ok(out.includes('NEURO_API_TOKEN=abc123'));
  assert.ok(out.includes('OPENROUTER_MODEL=google/gemini-2.5-flash'));
  assert.ok(out.includes('# NEURO config'));
});

test('a missing NEURO_PIN line is appended rather than lost', () => {
  const out = pin.replacePinLine('OTHER=1\n', '528193');
  assert.ok(out.includes('OTHER=1'));
  assert.ok(out.includes('NEURO_PIN=528193'));
});

test('CRLF .env rewrites without duplicating the line', () => {
  const out = pin.replacePinLine(SAMPLE_ENV.replace(/\n/g, '\r\n'), '528193');
  const lines = out.split(/\r?\n/).filter(l => l.startsWith('NEURO_PIN='));
  assert.deepEqual(lines, ['NEURO_PIN=528193']);
});

test('a duplicate NEURO_PIN line is refused, not silently half-written', () => {
  // dotenv takes the FIRST occurrence, so writing the second would leave the
  // old PIN live while the file looks changed.
  const dupe = 'NEURO_PIN=111111\nNEURO_PIN=222222\n';
  assert.throws(() => pin.replacePinLine(dupe, '528193'), /exactly one NEURO_PIN line/);
});

// ── change() ──────────────────────────────────────────────────────────────

test('a successful change writes the file AND takes effect immediately', async () => {
  await withEnv(SAMPLE_ENV, async (file) => {
    const out = pin.change({ currentPin: '140277', newPin: '528193' });
    assert.equal(out.ok, true);
    assert.equal(out.length, 6);
    // On disk, so it survives a restart...
    assert.match(fs.readFileSync(file, 'utf-8'), /NEURO_PIN=528193/);
    // ...and in memory, so no restart is needed.
    assert.equal(process.env.NEURO_PIN, '528193');
    assert.ok(Array.isArray(out.consumers) && out.consumers.length > 0);
  });
});

test('the wrong current PIN changes nothing', async () => {
  await withEnv(SAMPLE_ENV, async (file) => {
    const out = pin.change({ currentPin: '999999', newPin: '528193' });
    assert.equal(out.ok, false);
    assert.equal(out.field, 'currentPin');
    assert.match(fs.readFileSync(file, 'utf-8'), /NEURO_PIN=140277/);
    assert.equal(process.env.NEURO_PIN, '140277', 'the running PIN is untouched');
  });
});

test('an invalid new PIN changes nothing and names the field', async () => {
  await withEnv(SAMPLE_ENV, async (file) => {
    const out = pin.change({ currentPin: '140277', newPin: '11' });
    assert.equal(out.ok, false);
    assert.equal(out.field, 'newPin');
    assert.match(fs.readFileSync(file, 'utf-8'), /NEURO_PIN=140277/);
    assert.equal(process.env.NEURO_PIN, '140277');
  });
});

test('an unwritable .env leaves the running PIN working', async () => {
  await withEnv(SAMPLE_ENV, async (_file, dir) => {
    // Point at a path inside a directory that does not exist: the write fails.
    process.env.NEURO_ENV_PATH = path.join(dir, 'nope', '.env');
    const out = pin.change({ currentPin: '140277', newPin: '528193' });
    assert.equal(out.ok, false);
    // The whole point of writing the file BEFORE touching memory: a failed
    // change must leave a system that still authenticates.
    assert.equal(process.env.NEURO_PIN, '140277');
  });
});

test('no temp file is left behind beside .env', async () => {
  await withEnv(SAMPLE_ENV, async (_file, dir) => {
    pin.change({ currentPin: '140277', newPin: '528193' });
    const strays = fs.readdirSync(dir).filter(f => f.startsWith('.env.tmp'));
    assert.deepEqual(strays, []);
  });
});

test('the backup never lands beside .env — that is one git add from a leak', async () => {
  await withEnv(SAMPLE_ENV, async (_file, dir) => {
    const out = pin.change({ currentPin: '140277', newPin: '528193' });
    const beside = fs.readdirSync(dir).filter(f => f !== '.env');
    // Verified with `git check-ignore`: `neuro-env-backup-<ts>` and
    // `.env.tmp-<pid>-<ts>` are NOT ignored, so a secret written beside .env
    // here would be one `git add -A` from the public repo — exactly how #123
    // and the #59 crypt-secret leak happened.
    assert.deepEqual(beside, [], 'nothing but .env in the env directory');
    if (out.backup) {
      assert.ok(!out.backup.startsWith(dir), 'backup is outside the env directory');
      assert.match(fs.readFileSync(out.backup, 'utf-8'), /NEURO_PIN=140277/);
      fs.rmSync(out.backup, { force: true });
    }
  });
});

test('status never returns the PIN itself', async () => {
  await withEnv(SAMPLE_ENV, async () => {
    const s = pin.status();
    assert.equal(s.configured, true);
    assert.equal(s.length, 6);
    assert.equal(JSON.stringify(s).includes('140277'), false, 'the value must never be serialised');
  });
});

test('the current-PIN check is length-safe', async () => {
  await withEnv(SAMPLE_ENV, async () => {
    // timingSafeEqual throws on a length mismatch if not guarded — a wrong-length
    // guess must return false, not crash the route.
    assert.equal(pin.matchesCurrent('1'), false);
    assert.equal(pin.matchesCurrent(''), false);
    assert.equal(pin.matchesCurrent(undefined), false);
    assert.equal(pin.matchesCurrent('140277'), true);
  });
});

test('every consumer names an action', () => {
  // A list of things that broke, with no instruction, is just an apology.
  for (const c of pin.consumers()) {
    assert.ok(c.label, 'consumer has a label');
    assert.ok(c.action && c.action.length > 10, `consumer ${c.id} says what to do`);
  }
  const ids = pin.consumers().map(c => c.id);
  for (const required of ['watch-siri', 'sara-pwa', 'sara-kiosk', 'mcp', 'n8n']) {
    assert.ok(ids.includes(required), `${required} is listed`);
  }
});
