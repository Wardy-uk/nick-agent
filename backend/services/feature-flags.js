'use strict';

// Feature switches that are Nick's decision, settable in Settings.
//
// Every one of these was `process.env.X === 'true'` captured into a module-level
// const at require time, so changing his mind meant an SSH session, an .env edit
// and a pm2 restart. Two of them — the day planner and its health rule — are
// recorded in CLAUDE.md as HIS calls, which made them exactly the wrong things
// to bury behind six steps of friction on a system whose stated premise is that
// his bottleneck is initiation.
//
// Same shape as `notion-sync` and the OpenRouter key before it: the value lives
// in `agent_state`, the environment still WINS where explicitly set, and it is
// read at CALL time so a toggle takes effect immediately.
//
// ⚠ Read at call time is the load-bearing half. A module-level const captured at
// require time is why the .env edit needed a restart in the first place; moving
// the value to the DB without moving the READ would have changed nothing.

const db = require('../db/database');

const STATE_PREFIX = 'feature_flag:';

/**
 * ⚠ The two default polarities are NOT cosmetic and must be preserved exactly.
 *
 *   default false — the switch must be turned ON deliberately, because the thing
 *     it enables writes to the outside world or acts on Nick's behalf.
 *   default true  — the switch is a KILL SWITCH for behaviour that is already
 *     live and wanted; flipping the default would silently disable a working
 *     feature the moment this file shipped.
 */
const FLAGS = [
  {
    key: 'day_planner',
    env: 'DAY_PLANNER_ENABLED',
    default: false,
    label: 'Auto-plan focus blocks',
    description: 'Books real calendar events twice a day (07:15 and 12:30, Mon–Fri) '
      + 'against gaps in your diary.',
    impact: 'writes to your calendar',
  },
  {
    key: 'day_planner_health',
    env: 'DAY_PLANNER_HEALTH_CAPACITY',
    default: false,
    label: 'Lighter plan on a low-recovery day',
    description: 'Plans one shorter block when readiness is down. It only ever REDUCES, '
      + 'never reorders, and an unknown reading plans as normal. '
      + 'Measured: no effect on output (p = 0.97) — this is a preference, not a prediction.',
    requires: 'day_planner',
  },
  {
    key: 'capture_dedupe',
    env: 'CAPTURE_DEDUPE_ENABLED',
    default: true,
    description: 'Folds the same commitment extracted from several meeting notes into one '
      + 'action. Measured: 258 pending actions collapse to 54.',
    label: 'Fold duplicate captured commitments',
  },
  {
    key: 'teams_dm',
    env: 'TEAMS_DM_ENABLED',
    default: true,
    label: 'Send chases as a Teams DM',
    description: 'Falls back to email when Teams cannot deliver. Dark until the '
      + 'ChatMessage.Send scope is consented by a tenant admin.',
  },
  {
    key: 'vesta_photo',
    env: 'VESTA_PHOTO_ENABLED',
    default: false,
    label: 'Read the fridge from a photo',
    description: 'Lets the household surface turn a photograph of a shelf into a proposed '
      + 'list somebody confirms. It writes nothing on its own. The condition was to '
      + 'prove the typed path first — and it is the only route on the public mount that '
      + 'spends money, so it is capped per account per day.',
    impact: 'costs money per photo',
  },
  {
    key: 'dnd_vault_read_only',
    env: 'DND_VAULT_READ_ONLY',
    default: false,
    label: 'D&D vault mirror is read-only',
    description: 'Blocks writes through the D&D vault API. Notion is the source for that '
      + 'tree, so the mirror should not be edited from here.',
  },
];

const BY_KEY = new Map(FLAGS.map((f) => [f.key, f]));

/**
 * Did the environment explicitly say something?
 *
 * ⚠ `undefined` and `''` both mean "not set", and the distinction matters for a
 * default-TRUE flag: `!== 'false'` treats an unset variable as on, so an empty
 * string must not read as an explicit choice.
 */
function envValue(flag) {
  const raw = process.env[flag.env];
  if (raw === undefined || raw === '') return null;
  return raw === 'true';
}

function storedValue(flag) {
  try {
    const raw = db.getState(`${STATE_PREFIX}${flag.key}`);
    if (raw === null || raw === undefined || raw === '') return null;
    return raw === 'true';
  } catch { return null; }
}

/** Is this switch on? Env wins, then the stored value, then the default. */
function isEnabled(key) {
  const flag = BY_KEY.get(key);
  if (!flag) return false;

  // A dependent switch is off whenever its parent is, whatever it says itself —
  // otherwise the panel shows "lighter plan" as ON while the planner that would
  // act on it is not running, which is a claim about behaviour that cannot happen.
  if (flag.requires && !isEnabled(flag.requires)) return false;

  const fromEnv = envValue(flag);
  if (fromEnv !== null) return fromEnv;
  const stored = storedValue(flag);
  if (stored !== null) return stored;
  return flag.default;
}

function setEnabled(key, on) {
  const flag = BY_KEY.get(key);
  if (!flag) return { ok: false, error: `Unknown switch "${key}".` };
  if (envValue(flag) !== null) {
    return {
      ok: false,
      error: `${flag.env} is set in the environment, so it cannot be changed here.`,
    };
  }
  db.setState(`${STATE_PREFIX}${flag.key}`, on ? 'true' : 'false');
  return { ok: true, key, enabled: isEnabled(key) };
}

/** Everything the panel needs — never the raw env values. */
function list() {
  return FLAGS.map((flag) => ({
    key: flag.key,
    label: flag.label,
    description: flag.description,
    impact: flag.impact || null,
    requires: flag.requires || null,
    enabled: isEnabled(flag.key),
    // So the UI can disable the control and SAY why, rather than offering a
    // toggle that silently does nothing.
    lockedByEnv: envValue(flag) !== null,
    envVar: flag.env,
    default: flag.default,
    // A dependent switch that is off only because its parent is.
    blockedBy: flag.requires && !isEnabled(flag.requires) ? flag.requires : null,
  }));
}

module.exports = { FLAGS, STATE_PREFIX, isEnabled, setEnabled, list };
