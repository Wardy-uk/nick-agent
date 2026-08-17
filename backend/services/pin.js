'use strict';

/**
 * Changing the NEURO PIN from the UI.
 *
 * Until now the PIN could only be changed by editing `backend/.env` over SSH and
 * restarting the backend — which is why, when it turned out to have been sitting
 * in a PUBLIC repo since 15 July (#123), rotating it was a manual job that had
 * been outstanding for days. A credential you cannot rotate from the app is a
 * credential that does not get rotated.
 *
 * **`.env` stays the single source of truth, deliberately.** The AI settings
 * precedent puts runtime config in `agent_state` and bootstraps it into
 * `process.env` on first request — that is right for an API key, and wrong for
 * this. The PIN is checked by the `/api` middleware on EVERY request including
 * the first, so a DB-backed value has a window at boot where the stored PIN is
 * not loaded yet and the stale `.env` one is still live. Worse, it would create
 * exactly the two-sources-of-truth split (`.env` says one thing, the DB another)
 * that this repo keeps having to unpick. Writing `.env` keeps one answer, and it
 * is what a human would have done over SSH anyway.
 *
 * Immediate effect comes from also setting `process.env.NEURO_PIN` in memory, so
 * no restart is needed; the file write is what survives one.
 *
 * ⚠ The backup goes to the OS temp dir, never beside `.env`. A `.env.bak-…` in
 * the backend folder is not matched by the `.env` gitignore rule, so it is one
 * `git add` away from committing the OLD PIN to the public repo — the precise
 * failure #123 and the #59 crypt-secret leak were both instances of.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MIN_LENGTH = 4;
const MAX_LENGTH = 12;

/** Where `.env` lives. Overridable so tests never touch the real one (#119). */
function envPath() {
  return process.env.NEURO_ENV_PATH || path.join(__dirname, '..', '.env');
}

function currentPin() {
  return process.env.NEURO_PIN || '';
}

function isConfigured() {
  return Boolean(currentPin());
}

/** Constant-time compare, so the current-PIN check cannot be probed by timing. */
function matchesCurrent(candidate) {
  const a = Buffer.from(String(candidate ?? ''), 'utf-8');
  const b = Buffer.from(currentPin(), 'utf-8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function _isSequential(s) {
  if (s.length < 3) return false;
  let up = true, down = true;
  for (let i = 1; i < s.length; i++) {
    const d = Number(s[i]) - Number(s[i - 1]);
    if (d !== 1) up = false;
    if (d !== -1) down = false;
  }
  return up || down;
}

/**
 * Why this PIN is unacceptable, or null if it is fine.
 *
 * Pure and exported, so the rules are testable without a filesystem and the UI
 * can show the SAME sentence the server would reject with — a client-side rule
 * that disagrees with the server is how "it says invalid but won't say why"
 * happens.
 */
function validate(newPin, { current = currentPin() } = {}) {
  const s = String(newPin ?? '');
  if (!s) return 'Enter a new PIN.';
  // Digits only: the Watch shortcut sends a header typed on a numeric keypad and
  // both PWAs present a number pad. A letter here locks the phone out.
  if (!/^\d+$/.test(s)) return 'The PIN must be digits only — the Watch shortcut and both PWAs use a number pad.';
  if (s.length < MIN_LENGTH || s.length > MAX_LENGTH) return `The PIN must be ${MIN_LENGTH}–${MAX_LENGTH} digits.`;
  if (current && s === current) return 'That is already your PIN.';
  // Two guesses anyone would try first. This PIN guards every /api route on a
  // host that serves publicly through a Tailscale Funnel, so the floor matters.
  if (/^(\d)\1+$/.test(s)) return 'All the same digit is too easy to guess — pick something else.';
  if (_isSequential(s)) return 'Sequential digits are too easy to guess — pick something else.';
  return null;
}

/**
 * Replace the NEURO_PIN line in `.env`.
 *
 * Atomic: written to a temp file in the same directory and renamed over the
 * original, so a crash mid-write cannot leave a truncated `.env` — which would
 * take out every other setting in it, not just the PIN.
 *
 * Pure-ish helper, exported for tests: takes the file contents, returns the new
 * contents, and refuses rather than guessing if the result looks wrong.
 */
function replacePinLine(raw, newPin) {
  const line = `NEURO_PIN=${newPin}`;
  const has = /^NEURO_PIN=.*$/m.test(raw);
  const next = has
    ? raw.replace(/^NEURO_PIN=.*$/m, line)
    : `${raw.replace(/\s*$/, '')}\n${line}\n`;

  // Belt and braces: exactly one NEURO_PIN line, and it is the new one. dotenv
  // takes the FIRST occurrence, so a duplicate would silently keep the old PIN.
  const matches = next.split(/\r?\n/).filter(l => /^NEURO_PIN=/.test(l));
  if (matches.length !== 1 || matches[0] !== line) {
    throw new Error(`Refusing to write .env — expected exactly one NEURO_PIN line, got ${matches.length}`);
  }
  return next;
}

/** Everything that has to be told the new PIN. Named, because a silent break is worse. */
function consumers() {
  return [
    { id: 'neuro-web', label: 'This NEURO web app', action: 'Updated automatically — no action needed.', automatic: true },
    { id: 'watch-siri', label: 'Apple Watch / Siri shortcut', action: 'Edit the shortcut’s `X-Neuro-Pin` header.' },
    { id: 'sara-pwa', label: 'SARA phone PWA (sara.nickward.co.uk)', action: 'Sign in again with the new PIN.' },
    { id: 'sara-kiosk', label: 'SARA desk kiosk backend (Pi 4, :3005)', action: 'Set NEURO_PIN in sara/backend/.env and restart sara-backend.' },
    { id: 'mcp', label: 'MCP server (Claude Code / Desktop)', action: 'Update NEURO_PIN in the MCP config, then restart Claude.' },
    { id: 'n8n', label: 'n8n flows using the PIN', action: 'Only affects flows using X-NEURO-PIN; those on X-NEURO-API-TOKEN are unaffected.' },
  ];
}

function status() {
  return {
    configured: isConfigured(),
    // Never the value. Length is enough to tell one PIN from another when
    // checking whether a change landed.
    length: currentPin().length,
    minLength: MIN_LENGTH,
    maxLength: MAX_LENGTH,
    lastChanged: _lastChanged(),
    envPath: envPath(),
    consumers: consumers(),
  };
}

function _lastChanged() {
  try {
    return require('../db/database').getState('neuro_pin_last_changed') || null;
  } catch {
    return null;
  }
}

/**
 * Change the PIN.
 *
 * Order matters: validate, then write the FILE, then update memory. If the write
 * fails the running PIN is untouched, so a failed change leaves a working system
 * rather than a backend whose in-memory PIN no longer matches anything on disk.
 */
function change({ currentPin: supplied, newPin } = {}) {
  if (isConfigured() && !matchesCurrent(supplied)) {
    return { ok: false, error: 'Current PIN is wrong.', field: 'currentPin' };
  }

  const invalid = validate(newPin);
  if (invalid) return { ok: false, error: invalid, field: 'newPin' };

  const file = envPath();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (e) {
    return { ok: false, error: `Could not read ${file}: ${e.message}` };
  }

  let next;
  try {
    next = replacePinLine(raw, String(newPin));
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // Backup to the OS temp dir — NEVER beside .env, where a `.env.bak-*` file is
  // outside the gitignore rule and one `git add` from publishing the old PIN.
  let backup = null;
  try {
    backup = path.join(os.tmpdir(), `neuro-env-backup-${Date.now()}`);
    fs.writeFileSync(backup, raw, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    backup = null; // best effort; never block the rotation on it
  }

  const tmp = path.join(path.dirname(file), `.env.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmp, next, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, file); // atomic on POSIX
  } catch (e) {
    try { fs.existsSync(tmp) && fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    return { ok: false, error: `Could not write ${file}: ${e.message}` };
  }

  // Live immediately — the /api middleware reads process.env on every request,
  // so this is what makes the change take effect without a restart.
  process.env.NEURO_PIN = String(newPin);

  const at = new Date().toISOString();
  try { require('../db/database').setState('neuro_pin_last_changed', at); } catch { /* not worth failing for */ }
  // Deliberately no value in the log line.
  console.log(`[PIN] Changed at ${at} (${String(newPin).length} digits)`);

  return { ok: true, changedAt: at, length: String(newPin).length, backup, consumers: consumers() };
}

module.exports = {
  change,
  validate,
  status,
  consumers,
  isConfigured,
  currentPin,
  matchesCurrent,
  replacePinLine,
  MIN_LENGTH,
  MAX_LENGTH,
  _internals: { envPath, _isSequential },
};
