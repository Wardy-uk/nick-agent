'use strict';

/**
 * Triage shadow log — what a cheaper model WOULD have said.
 *
 * `email_triage` is 69% of NEURO's cloud bill (356 calls / $1.42 over the seven
 * days to 1 Sep 2026), and a one-off probe of eight synthetic emails put
 * `mistral-small-3.2-24b` at the same 7/8 agreement as Haiku 4.5 for a
 * twentieth of the price. That probe is not evidence enough to switch the one
 * surface that decides what Nick sees in his inbox.
 *
 * So: keep classifying with the live model, and record — on the SAME real
 * emails — what a candidate model answers. After a week the model decision has
 * a body of genuine disagreements behind it rather than my eight fixtures.
 *
 * Four rules, all of them the same rule wearing different hats:
 *
 *  ⚠ IT NEVER TOUCHES THE ANSWER. The shadow call runs after the live one, its
 *    result is written to a log and read by nobody, and any failure is
 *    swallowed. A comparison harness that can change the thing it measures is
 *    not a comparison harness.
 *
 *  ⚠ IT NEVER DELAYS THE ANSWER. Fired and not awaited by the caller, so a slow
 *    candidate cannot make the inbox slower.
 *
 *  ⚠ IT IS OFF BY DEFAULT and sampled. It spends real money to answer a
 *    question nobody is asking yet, so it needs saying yes to — and at a
 *    twentieth of the price a full shadow of triage is pennies a week, which is
 *    the point, but the sample rate keeps that true if the candidate changes.
 *
 *  ⚠ NO EMAIL CONTENT IS STORED. The log keeps the email id, the two verdicts
 *    and whether they agreed. The prompt already goes to OpenRouter; the log is
 *    a local file NEURO reads back, and a second copy of Nick's inbox in
 *    `agent_state` is exactly the pile this codebase keeps having to clear out.
 */

const STATE_KEY = 'email_triage_shadow';
const MAX_ROWS = 2000;          // ~2 weeks at current volume; bounded on write
const DEFAULT_MODEL = 'mistralai/mistral-small-3.2-24b-instruct';

function isEnabled() {
  return process.env.TRIAGE_SHADOW_ENABLED === 'true';
}

function shadowModel() {
  return process.env.TRIAGE_SHADOW_MODEL || DEFAULT_MODEL;
}

/** 0..1. Defaults to everything — the candidate is ~20x cheaper than the live model. */
function sampleRate() {
  const raw = parseFloat(process.env.TRIAGE_SHADOW_SAMPLE);
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return 1;
  return raw;
}

function _load() {
  try {
    const raw = require('../db/database').getState(STATE_KEY);
    if (!raw) return { rows: [] };
    const parsed = JSON.parse(raw);
    return { rows: Array.isArray(parsed?.rows) ? parsed.rows : [] };
  } catch {
    // Unreadable is NOT empty. Returning {rows:[]} here and then writing it
    // would erase the comparison — the same shape as the budget counter bug.
    return null;
  }
}

function _append(rows) {
  const existing = _load();
  if (!existing) return false;             // could not read — never overwrite
  const merged = existing.rows.concat(rows).slice(-MAX_ROWS);
  try {
    require('../db/database').setState(STATE_KEY, JSON.stringify({ rows: merged }));
    return true;
  } catch { return false; }
}

/**
 * Run the candidate over the same batch, compare, log. Never throws.
 *
 * @param batch   the emails as passed to classifyBatch
 * @param live    the live verdicts, already mapped to {id, category, reason}
 * @param prompt  the exact prompt the live model was given, so the two models
 *                are asked the identical question — rebuilding it here would
 *                let the comparison drift from what is actually in production
 */
async function compare(batch, live, prompt) {
  if (!isEnabled() || !batch?.length || !live?.length) return;
  if (Math.random() > sampleRate()) return;

  const model = shadowModel();
  try {
    const aiRouting = require('./ai-routing');
    if (!aiRouting.isCloudAllowed('email_triage')) return;

    const openrouter = require('./providers/openrouter-provider');
    if (!openrouter.isConfigured()) return;

    const started = Date.now();
    const res = await openrouter.chat('', [{ role: 'user', content: prompt }], {
      model,
      temperature: 0.2,
      maxTokens: 1024,
    });
    const ms = Date.now() - started;

    const text = (res?.text || '').replace(/```json|```/g, '').trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) {
      _append([{ at: new Date().toISOString(), model, ok: false, reason: 'unparseable', ms }]);
      return;
    }
    const parsed = JSON.parse(match[0]);

    const byIndex = new Map(
      parsed
        .filter(c => Number.isInteger(c?.index) && c.index >= 0 && c.index < batch.length)
        .map(c => [c.index, c.category])
    );
    const liveById = new Map(live.map(c => [c.id, c.category]));

    const rows = [];
    batch.forEach((e, i) => {
      const shadow = byIndex.get(i) || null;
      const actual = liveById.get(e.id) || null;
      if (!actual) return;                   // the live model had no answer either
      rows.push({
        at: new Date().toISOString(),
        model,
        id: e.id,                            // id only — never subject or body
        live: actual,
        shadow,
        agree: shadow != null && shadow === actual,
        ms,
      });
    });

    if (rows.length) {
      _append(rows);
      const agreed = rows.filter(r => r.agree).length;
      console.log(`[TriageShadow] ${model}: ${agreed}/${rows.length} agreed (${ms}ms)`);
    }

    // Reported so shadow spend shows up in the ledger like everything else —
    // this bypasses the routing tiers, so nothing else would record it.
    if (res?.usage) {
      aiRouting.recordUsage(res.usage, { provider: 'openrouter', model, taskType: 'email_triage_shadow' });
    }
  } catch (e) {
    console.warn(`[TriageShadow] ${model} failed: ${e.message}`);
  }
}

/** What the week bought: agreement rate, and where the two disagree. */
function summary() {
  const loaded = _load();
  if (!loaded) return { known: false, reason: 'shadow log unreadable' };
  const rows = loaded.rows.filter(r => r.id);
  if (!rows.length) return { known: true, samples: 0, note: 'nothing compared yet' };

  const byModel = {};
  for (const r of rows) {
    const m = (byModel[r.model] ||= { samples: 0, agreed: 0, unparseable: 0, confusion: {} });
    m.samples++;
    if (r.agree) m.agreed++;
    if (r.shadow == null) m.unparseable++;
    else if (!r.agree) {
      const k = `${r.live} -> ${r.shadow}`;
      m.confusion[k] = (m.confusion[k] || 0) + 1;
    }
  }
  for (const m of Object.values(byModel)) {
    m.agreementPct = Math.round((m.agreed / m.samples) * 100);
  }
  return {
    known: true,
    samples: rows.length,
    since: rows[0].at,
    byModel,
  };
}

module.exports = { compare, summary, isEnabled, shadowModel, sampleRate, _internals: { _load, MAX_ROWS } };
