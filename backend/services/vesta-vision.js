'use strict';

/**
 * VESTA — a photograph of the fridge, turned into a PROPOSED list.
 *
 * Nick, 31 Aug 2026: he wants to photograph the shelf rather than type it. His
 * own handoff put this THIRD and said why: *"do this last, after the typed path
 * is proven — if the list is wrong, a photo just makes it wrong faster."* That
 * gate is respected by `VESTA_PHOTO_ENABLED`, which DEFAULTS FALSE — the same
 * idiom as `DAY_PLANNER_ENABLED` and `NOTION_SYNC_ENABLED`, both of which guard
 * a feature that acts on the real world on a timer. Lifting it is his call, not
 * this file's.
 *
 * ── It PROPOSES. It never writes. ───────────────────────────────────────────
 * The output is a list she ticks; each accepted item then goes through the SAME
 * `/catalogue/:slug/add` route a typed one does. Nothing here touches the vault.
 * A vision model reading "chicken thighs" off a packet is right most of the
 * time, and the whole point of the kitchen list is that it can be trusted — a
 * write that happens without a person agreeing to it turns a helpful guess into
 * a wrong fact about the freezer, which is exactly the failure that makes
 * somebody shop for food that is already in.
 *
 * ── The photo is not kept ───────────────────────────────────────────────────
 * ⚠ Never written to disk, never logged, never stored in the DB, never echoed
 * back in the response. A photo of a kitchen is a photo of somebody's home: the
 * post on the worktop, a prescription, a laptop screen, whoever is standing in
 * it. It exists in memory for the life of one request and then it is gone. That
 * is a stricter rule than the rest of VESTA needs, because this is the only
 * route that ever receives something a camera saw.
 *
 * ── It costs money, on a PUBLIC mount ───────────────────────────────────────
 * ⚠ Every other route on `/api/v` is a cheap read or a small write. This one
 * spends on a vision call, and `/api/v` is exempt from the PIN and reachable
 * from the open internet. A signed-in account with a stuck finger — or a stolen
 * token — is a bill. Hence a per-account daily cap ON TOP of the account's own
 * submission throttle, and the routing layer's budget gate on top of that.
 *
 * PURE where it judges: `parseProposal`, `placeSection` and `withinCap` take
 * plain data and return plain data, so the rules pin without an API key, a
 * network or a clock.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');

const STATE_KEY = 'vesta_scan_usage';

// A generous day of honest use and nowhere near a runaway. Deliberately small:
// this is a fridge, not a stock take, and the typed path is always there.
const DAILY_CAP = Number(process.env.VESTA_PHOTO_DAILY_CAP || 12);

// Anthropic's per-image ceiling is 5MB; a phone photo is 2-4MB. Refusing above
// this is better than a 400 from the API, because the reason can then be a
// sentence she understands rather than a stack trace.
const MAX_BYTES = 4 * 1024 * 1024;

const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * ⚠ Asked of `feature-flags`, NOT of `process.env` directly, so the switch is
 * reachable from NEURO Settings instead of an SSH session and a pm2 restart.
 * That registry still lets `VESTA_PHOTO_ENABLED` win when it IS set in the
 * environment — an env var is an operator overriding the UI, and the panel
 * disables the control and says so rather than offering a toggle that silently
 * does nothing. Unset, as it is on the Pi, the stored value decides and the
 * default is still FALSE.
 */
function isEnabled() {
  return require('./feature-flags').isEnabled('vesta_photo');
}

// ── The rules, pure ──────────────────────────────────────────────────────────

/**
 * Has this account got a scan left today? PURE.
 *
 * ⚠ Counts a WINDOW, not a running total that resets on restart. `ai-routing`'s
 * daily counter had exactly that bug — a module-level number that really meant
 * "per uptime", on a backend that restarts several times a day.
 */
function withinCap(stamps = [], now = Date.now(), cap = DAILY_CAP) {
  const cutoff = now - 24 * 3600 * 1000;
  const recent = (Array.isArray(stamps) ? stamps : []).filter(t => t > cutoff);
  return { ok: recent.length < cap, used: recent.length, cap, recent };
}

/**
 * Put a proposed item into one of the catalogue's REAL sections. PURE.
 *
 * ⚠ Returns null rather than guessing. The model is told which sections exist,
 * but a model asked to pick from a list will occasionally answer "Larder"
 * anyway — and `catalogue.addItem` refuses a section it does not know, so an
 * invented one would fail at the moment she taps Confirm, with the failure
 * attached to the item rather than to the guess that caused it. A null comes
 * back as "you choose", which is honest and costs one tap.
 */
function placeSection(proposed, sections = []) {
  const want = String(proposed || '').trim().toLowerCase();
  if (!want) return null;
  return sections.find(s => String(s).toLowerCase() === want) || null;
}

/**
 * The model's answer, turned into items. PURE.
 *
 * ⚠ Refuses an unparseable answer rather than returning an empty list. "I could
 * not read the photo" and "there is nothing in the photo" are different facts —
 * the rule the whole of VESTA is built on — and an empty array here would be
 * rendered as a fridge she has just been told is bare.
 */
function parseProposal(text, sections = []) {
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, why: 'the model returned nothing' };

  // Models fence JSON in markdown often enough that stripping it is cheaper
  // than a retry, and it cannot make a good answer worse.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : raw).trim();

  // Tolerate a sentence either side of the array — asking for bare JSON does
  // not reliably get bare JSON, and the array itself is unambiguous.
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    return { ok: false, why: 'could not read the list the model produced' };
  }

  let parsed;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch (e) {
    // The classic shape of a truncated array. Worth naming, because the fix is
    // a bigger max_tokens rather than a better photograph.
    return { ok: false, why: `could not read the list the model produced (${e.message.slice(0, 60)})` };
  }
  if (!Array.isArray(parsed)) return { ok: false, why: 'the model did not return a list' };

  const seen = new Set();
  const items = [];
  for (const entry of parsed) {
    const name = String((entry && entry.name) || '').trim().slice(0, 120);
    if (!name) continue;
    // One shelf photographed twice, or a stack of four identical yoghurts, is
    // still one line on a list.
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ name, section: placeSection(entry && entry.section, sections) });
  }

  // A photo the model genuinely read and found no food in is a real answer and
  // NOT a failure — an empty worktop exists. It is told apart from the
  // unreadable cases above by `ok`, and the caller says so in different words.
  return { ok: true, items };
}

// ── The prompt ───────────────────────────────────────────────────────────────

const SYSTEM = [
  'You read photographs of food storage and list what is in them.',
  'You are helping run a household kitchen list. Be literal and be brief.',
].join(' ');

function buildPrompt(sections) {
  return [
    'List the food and drink you can actually see in this photograph.',
    '',
    'Rules:',
    '- Only what is visible. Do not infer what is behind or underneath something.',
    '- If you cannot tell what an item is, leave it out rather than guessing.',
    '- Use the everyday name ("chicken thighs", "semi-skimmed milk"), not the brand.',
    '- One entry per kind of thing, not per packet.',
    '- Ignore anything that is not food or drink.',
    '',
    `Assign each item to one of these sections, copied exactly: ${sections.map(s => JSON.stringify(s)).join(', ')}.`,
    'If none of them clearly fits, use null.',
    '',
    'Answer with a JSON array and nothing else, like:',
    '[{"name": "chicken thighs", "section": "Freezer"}]',
    '',
    'If there is no food or drink in the picture, answer with an empty array.',
  ].join('\n');
}

// ── The call ─────────────────────────────────────────────────────────────────

function _stamps() {
  const all = db.getState(STATE_KEY) || {};
  return (all && typeof all === 'object') ? all : {};
}

/**
 * ⚠ Synchronous from the read to the write, deliberately, with no `await`
 * between them. better-sqlite3 is synchronous and this is one Node process, so
 * that read-modify-write genuinely cannot interleave and is a real mutex here —
 * the same reasoning as `plaud-admin-blocks.acquireLock`, and it would NOT be
 * safe across processes. Recorded BEFORE the call, so a request that fails
 * expensively still costs a slot; the alternative is a retry loop that bills.
 */
function _claimSlot(username, now = Date.now()) {
  const all = _stamps();
  const state = withinCap(all[username], now);
  if (!state.ok) return state;
  all[username] = [...state.recent, now];
  db.setState(STATE_KEY, all);
  return { ...state, ok: true };
}

/**
 * A photo in, a proposal out. Writes nothing, anywhere.
 *
 * @returns {{ok, proposed?, why?, used?, cap?}}
 */
async function proposeFromPhoto({ username, imageBase64, mediaType, sections = [] } = {}) {
  if (!isEnabled()) {
    return { ok: false, why: 'Photos are not switched on yet.', disabled: true };
  }
  if (!sections.length) {
    return { ok: false, why: 'that catalogue has no sections to sort things into' };
  }
  if (!MEDIA_TYPES.has(String(mediaType))) {
    return { ok: false, why: 'that is not a kind of picture I can read' };
  }

  const data = String(imageBase64 || '');
  if (!data) return { ok: false, why: 'no photo arrived' };
  // base64 is 4 characters per 3 bytes.
  if (Math.floor(data.length * 3 / 4) > MAX_BYTES) {
    return { ok: false, why: 'that photo is too big — try one a bit smaller' };
  }

  const aiRouting = require('./ai-routing');
  // The routing layer's own budget, AI mode and daily caps. Asked BEFORE her
  // slot is claimed, so a switched-off day does not silently burn her allowance.
  if (!aiRouting.isCloudAllowed('vesta_photo')) {
    return { ok: false, why: "I can't read photos right now." };
  }

  const anthropic = require('./providers/anthropic-provider');
  if (!anthropic.isConfigured()) {
    return { ok: false, why: "I can't read photos right now." };
  }

  const slot = _claimSlot(username);
  if (!slot.ok) {
    return { ok: false, why: `That's ${slot.cap} photos today already. Try again tomorrow.`, used: slot.used, cap: slot.cap };
  }

  let result;
  try {
    result = await anthropic.vision(
      SYSTEM,
      { imageBase64: data, mediaType, prompt: buildPrompt(sections) },
      { model: process.env.VESTA_VISION_MODEL || 'claude-opus-5' }
    );
  } catch (e) {
    // ⚠ The message is NOT passed through to her. It is an API error string
    // that may name a model, a key state or an account, and this is the public
    // mount. Logged for Nick, generalised for her.
    console.warn('[VestaVision] Vision call failed:', e.message);
    return { ok: false, why: e.refusal ? "I couldn't read that photo." : "I couldn't read that photo just now." };
  }

  // Bookkeeping never fails the answer — it has already been produced.
  try {
    aiRouting.recordUsage(result.usage, {
      provider: 'anthropic',
      model: result.model,
      taskType: 'vesta_photo',
    });
  } catch { /* not fatal */ }

  const parsed = parseProposal(result.text, sections);
  if (!parsed.ok) return { ok: false, why: parsed.why };

  return { ok: true, proposed: parsed.items, used: slot.used + 1, cap: slot.cap };
}

module.exports = {
  // pure
  withinCap,
  placeSection,
  parseProposal,
  buildPrompt,
  // stateful
  isEnabled,
  proposeFromPhoto,
  // constants
  DAILY_CAP,
  MAX_BYTES,
  MEDIA_TYPES,
};
