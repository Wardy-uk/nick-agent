'use strict';

const db = require('../db/database');
const { evaluateEmail } = require('./email-priority');

// CLAUDE_MODEL removed in Phase 3 — AI routing handles provider selection
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_TRIAGE_MODEL || 'qwen2.5:3b';
const TRIAGE_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function classifyWithOllama(emailList) {
  const prompt = `You are classifying emails for Nick Ward, Head of Technical Support.
Classify each email into exactly one category:
- ACTION: Requires Nick to do something or reply
- FYI: Informational only, no action needed
- DELEGATE: Someone else should handle this
- IGNORE: Automated, spam, or irrelevant

Respond with ONLY a JSON array. No markdown, no explanation.
Format: [{"index": 0, "category": "ACTION", "reason": "brief reason max 8 words"}, ...]

Emails:
${emailList}`;

  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_ctx: 4096, num_predict: 512 }
    }),
    signal: AbortSignal.timeout(30000) // 30s — fail fast to AI routing
  });

  if (!res.ok) throw new Error(`Ollama error: ${res.status}`);
  const data = await res.json();
  const text = data.response || '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('No JSON array in Ollama response');
  return JSON.parse(jsonMatch[0]);
}

// The model sees the mail in batches of this size (26 Aug 2026).
//
// It used to see `emails.slice(0, 20)` and nothing else, while the result was
// mapped over ALL of them — we fetch 40, so on any busy day the back half was
// never shown to the model at all. Worse, an email with no classification fell
// through to `aiCategory = 'FYI'`, which is indistinguishable from the model
// having read it and said FYI. So the newest 20 were triaged and the rest were
// quietly filed as informational, with nothing anywhere saying so.
//
// 20 is kept as the BATCH size rather than raised to 40 in one call: the reply
// budget is 1024 tokens, and 40 items of JSON overruns it — which truncates the
// array, fails the parse and silently drops the whole run to deterministic
// rules. Two batches of 20 each fit, and a batch that fails costs only itself.
const CLASSIFY_BATCH = 20;

async function classifyBatch(batch) {
  const emailList = batch.map((e, i) =>
    `[${i}] From: ${e.from} <${e.fromEmail}>\nSubject: ${e.subject}\nPreview: ${e.preview?.substring(0, 150) || '(no preview)'}`
  ).join('\n\n');

  // Route through AI provider (Pi 4 worker first, then local fallback)
  // DO NOT call Pi 5 Ollama directly — it blocks interactive use
  const aiProvider = require('./ai-provider');
  // Built once and shared with the shadow comparison below, so the candidate
  // model is asked the IDENTICAL question — rebuilding it there would let the
  // comparison drift from what production actually sends.
  const prompt = `You are classifying emails for Nick Ward, Head of Technical Support at Nurtur.
Classify each email into exactly one category: ACTION, FYI, DELEGATE, or IGNORE.
Respond with ONLY a JSON array. Format: [{"index": 0, "category": "ACTION", "reason": "brief reason max 8 words"}, ...]

Classify these ${batch.length} emails:\n\n${emailList}`;
  const result = await aiProvider.triageEmails(prompt);
  // Both of these used to return an EMPTY ARRAY, which is the silent failure
  // this file keeps having to relearn: no answer and "the model read them and
  // said nothing" are the same value, so a provider that is down, refusing or
  // out of credit reads as a batch that was successfully classified as
  // nothing. Throwing puts it through the failed-batch path instead, where it
  // is counted and logged. Found live 1 Sep 2026: the Anthropic key is out of
  // credit, so whole runs came back 663/663 unanswered with no error anywhere.
  if (!result.text) {
    throw new Error(`no text from ${result.provider || 'any provider'}`);
  }

  const clean = result.text.replace(/```json|```/g, '').trim();
  const jsonMatch = clean.match(/\[[\s\S]*\]/);
  // A reply truncated by the token budget has no closing bracket, so the match
  // fails — that is a cut-off answer, not an empty one.
  if (!jsonMatch) {
    throw new Error(`unparseable answer from ${result.provider || 'unknown'} (${clean.length} chars)`);
  }
  const parsed = JSON.parse(jsonMatch[0]);
  console.log(`[EmailTriage] Classified ${batch.length} via ${result.provider}`);
  // Batch-local indices become global ones here, so the caller never has to
  // know the batching happened.
  // Batch-local indices become EMAIL IDS here, so the caller never has to know
  // the batching happened — and, since only unclassified mail is batched now,
  // never has to reason about which slice of the inbox a batch covered.
  const mapped = parsed
    .filter(c => Number.isInteger(c?.index) && c.index >= 0 && c.index < batch.length)
    .map(c => ({ ...c, id: batch[c.index].id }));

  // Deliberately NOT awaited: the shadow comparison must never delay triage,
  // and must never change its answer. Off unless TRIAGE_SHADOW_ENABLED=true.
  try {
    require('./triage-shadow').compare(batch, mapped, prompt);
  } catch { /* a comparison harness may never cost the thing it measures */ }

  return mapped;
}

/**
 * Classify a fetched list.
 *
 * `prior` is what triage already knows about these ids, and it is what keeps a
 * 14-day window affordable: an email's text never changes, so its MODEL answer
 * never changes either, and re-asking for it every 30 minutes is pure spend.
 * Only mail with no answer yet is batched — including mail whose earlier batch
 * FAILED, which is the case the old code could not tell from a real 'FYI'.
 *
 * The DETERMINISTIC half is always re-run, on the freshly fetched fields, so a
 * message that has since been read or flagged is re-rated on what is true now.
 */
async function classifyEmails(emails, prior = new Map()) {
  if (!emails || emails.length === 0) return [];

  const pending = emails.filter(e => !prior.get(e.id)?.aiClassified);
  const classifications = [];
  let failedBatches = 0;

  // Sequential, not parallel: these are cloud calls against a shared daily
  // budget and a rate limit, and triage is a background job with nobody
  // waiting on it.
  for (let offset = 0; offset < pending.length; offset += CLASSIFY_BATCH) {
    const batch = pending.slice(offset, offset + CLASSIFY_BATCH);
    try {
      classifications.push(...await classifyBatch(batch));
    } catch (aiErr) {
      failedBatches++;
      console.error(`[EmailTriage] AI classification failed for emails ${offset}-${offset + batch.length - 1}:`, aiErr.message);
    }
  }

  const byId = new Map(classifications.map(c => [c.id, c]));
  const unclassified = pending.length - byId.size;
  if (unclassified > 0) {
    // Loud, because the failure is otherwise invisible: an email the model
    // never saw looks exactly like one it called FYI.
    console.warn(`[EmailTriage] ${unclassified}/${pending.length} emails got no model answer`
      + `${failedBatches ? ` (${failedBatches} batch(es) failed)` : ''} — deterministic rules only`);
  }
  if (pending.length < emails.length) {
    console.log(`[EmailTriage] ${emails.length - pending.length}/${emails.length} already classified — reused, ${pending.length} sent to the model`);
  }

  return emails.map((email) => {
    const cls = byId.get(email.id);
    const was = prior.get(email.id);
    const deterministic = evaluateEmail(email);
    // No answer means NO ANSWER. Defaulting to 'FYI' and storing it in the same
    // field the model writes made "never looked at" and "judged informational"
    // the same record — so the blend below then treated a non-answer as the
    // model actively disagreeing with the deterministic rules.
    const aiCategory = cls ? String(cls.category || 'FYI').toUpperCase()
      : (was?.aiClassified ? (was.aiCategory || null) : null);
    let category = aiCategory || deterministic.category;
    if (deterministic.category === 'IGNORE') category = 'IGNORE';
    else if (deterministic.category === 'FYI' && aiCategory === 'ACTION') category = 'FYI';
    else if (deterministic.category === 'ACTION' && aiCategory === 'IGNORE') category = 'ACTION';
    else if (deterministic.category === 'DELEGATE' && aiCategory !== 'ACTION') category = 'DELEGATE';
    else if (deterministic.forced) category = deterministic.category;

    const lane =
      category === 'IGNORE' ? 'ignore'
        : category === 'DELEGATE' ? 'delegate'
          : deterministic.lane === 'urgent' ? 'urgent'
            : category === 'ACTION' ? 'reply'
              : deterministic.lane || 'fyi';

    return {
      ...email,
      category,
      lane,
      urgency: deterministic.urgency,
      urgent: lane === 'urgent',
      needsReply: lane === 'reply' || lane === 'urgent',
      reason: deterministic.reasons.length
        ? deterministic.reasons.join(' · ')
        : (cls?.reason || ''),
      aiCategory,
      // Null aiCategory already says it, but only to code that remembers to
      // check. This says it plainly to anything reading the record later.
      aiClassified: cls != null || !!was?.aiClassified,
      triaged: true,
      // When the model answer is reused, so is the stamp — it says when this
      // mail was judged, not when a pass last happened to walk past it.
      triagedAt: cls ? new Date().toISOString() : (was?.triagedAt || new Date().toISOString())
    };
  });
}

// What the last run was actually looking at. Not a store of items — the pile
// that caused all this was a store of items. Just "is the input the same mail
// as last time", so a 30-minute cadence does not pay for 21 identical
// classifications a day (26 Aug 2026).
const INPUT_KEY = 'email_triage_input';

// ── Keeping the store from becoming the next pile ───────────────────────────
//
// Measured 26 Aug: 748 entries, 743 of them dismissed, **668 KB** — parsed in
// full on every read, and there are a lot of reads (the nudge, both context
// feeds, the panel polling). Growing ~57 entries a day with nothing pruning.
// Not wrong the way `inbox_items` was wrong, but the same shape of mistake one
// step later: a store nobody empties.
//
// A dismissed entry is kept for exactly three reasons, and none needs the
// whole email:
//   1. The merge in `runTriage` must not resurrect it while its id can still
//      come back in the 24-hour fetch window. Seven days is a wide margin.
//   2. The #70 feedback score reads urgency/category/dismissReason.
//   3. The model's verdict must survive, or the mail is re-classified on every
//      run for as long as it is still being fetched (see DISMISSED_FIELDS).
// So dismissed entries are COMPACTED to those fields on write (668 KB → 192 KB
// on today's data, and the id is most of what remains), then pruned by age —
// with their contribution to the feedback score ROLLED UP first, so pruning
// costs history rather than throwing it away. The classifier's only free
// feedback signal must not quietly reset every week.
// DERIVED FROM THE LOOKBACK WINDOW, never a fixed number again. It was a
// literal 7 while the comment above still described a 24-hour fetch, and the
// window widened to 14 days on 1 Sep without it - so a dismissal on mail still
// sitting in the Inbox was pruned at day 7, re-fetched on day 8, and came back
// as new. "It keeps coming back", for the SAME email. A dismissed entry has to
// outlive every fetch that can still return its id, so the retention is the
// window plus a margin, computed from the window itself.
const DISMISSED_RETAIN_DAYS = () => LOOKBACK_DAYS + 7;

// ── How far back triage looks, and what it means to stop looking ────────────
//
// The window was 24 hours and the merge kept only DISMISSED entries, so the
// store's memory was exactly backwards: mail Nick had finished with survived a
// week, and mail he had NOT dealt with vanished a day after it arrived. The
// ACTION lane emptied itself overnight, and a promotion — the button that
// means "keep this in front of me" — expired in 24 hours.
//
// Two rules now, and they are separate:
//   • The window is 14 days, PAGED, so a fetch is a real walk of the period
//     rather than the newest 40 messages.
//   • NOTHING leaves the panel by age. An entry leaves when Nick acts on it,
//     or when it has demonstrably left the Inbox (below) — never because the
//     clock moved.
const LOOKBACK_DAYS = Number(process.env.EMAIL_TRIAGE_LOOKBACK_DAYS || 14);
const LOOKBACK_HOURS = LOOKBACK_DAYS * 24;
// Sized against the live mailbox, not guessed: **663** messages sat in the
// 14-day Inbox window when this was measured (1 Sep 2026), and a cap of 500
// truncated it — which is worse than a smaller window, because a truncated
// read reports `complete: false` and the departure rule below then never fires
// at all. Headroom, and the walk still says so loudly if it is ever hit.
const MAX_FETCH = Number(process.env.EMAIL_TRIAGE_MAX_FETCH || 1500);

// Absence from a fetch is only evidence when the fetch actually covered the
// message. Two guards, and both are needed:
//   • the read must be COMPLETE (`fetchRecentEmailsDetailed` says so — a
//     capped or part-failed page walk is a short list that looks like a small
//     mailbox, and reading absence out of it would sweep the panel), and
//   • the message must have arrived comfortably INSIDE the window, so an email
//     sitting on the boundary is never mistaken for one that has gone.
// Anything older than the window is kept indefinitely: we did not look, so we
// know nothing, and "I could not see it" is not "it is gone".
const DEPARTURE_GRACE_MS = 15 * 60 * 1000;
// ⚠ THE MODEL ANSWER IS ONE OF THE FIELDS, and leaving it out cost ~600 cloud
// calls a day in silence. `classifyEmails` decides what to send to the model
// with `!prior.get(e.id)?.aiClassified` — so a dismissed entry that has lost
// that flag is indistinguishable from mail the model has never seen, and is
// re-classified on EVERY run for as long as it stays in the fetch window.
// Measured on the live store (8 Sep 2026): **961 dismissed entries, ZERO
// carrying `aiClassified`** — only the 33 undismissed ones had it — so a run
// reported "25/623 already classified — reused, 598 sent to the model" three
// times a day, blowing the daily budget before 09:00 and dropping the standup,
// chat and focus enhancement to Ollama, which cannot do the job. A classified
// email never needs classifying twice: the text does not change.
//
// `aiCategory` and `triagedAt` travel with it because reuse reads all three —
// the flag alone would say "judged" while the verdict it stands for was gone,
// and the stamp says when the mail was JUDGED, not when a pass last walked
// past it. Three short fields against a re-classification: ~50 bytes an entry.
const DISMISSED_FIELDS = ['id', 'dismissed', 'dismissedAt', 'dismissReason', 'urgency', 'category',
  'aiClassified', 'aiCategory', 'triagedAt'];
const FEEDBACK_ROLLUP_KEY = 'email_triage_feedback_rollup';

function compact(entry) {
  if (!entry.dismissed) return entry;
  const out = {};
  for (const f of DISMISSED_FIELDS) if (entry[f] !== undefined) out[f] = entry[f];
  return out;
}

// -- Muting a sender (4 Sep 2026) -------------------------------------------
//
// "Not relevant" was a statement about ONE MESSAGE, and the mail it gets
// pressed on is overwhelmingly a NEWSLETTER: a new id, a new subject, every
// single day. Measured on the live store the morning this was found -
// THIRTEEN National Club Golfer emails between 19 Aug and 3 Sep, thirteen
// distinct ids, every one still undismissed, because dismissing yesterday's
// edition says nothing about today's. Nick pressed the button ten times and
// the classifier learned nothing, which teaches him the button does nothing.
//
// So the verdict is recorded against the SENDER ADDRESS rather than the
// message, and it takes effect on the FIRST press (Nick's call, 4 Sep - the
// alternative was earning it after two, and he wants one press to be the end
// of it).
//
// THE RULE IS THE DURABLE THING, NOT THE DISMISSED ENTRY. Entries are
// compacted and pruned by age; the rule is not. That is what makes muting
// survive the pruning of the entries it produces, rather than depending on
// them: a muted sender's mail is re-filed the moment it is seen again,
// however many times its entry has been pruned.
//
// It mutes an ADDRESS, never a display name. "National Club Golfer" is
// whatever the sender chooses to call itself this week and two senders can
// share one; the address is the identity.
const SENDER_RULES_KEY = 'email_triage_muted_senders';

// NEURO's own act, not one of Nick's verdicts - so, exactly like `left-inbox`,
// it is deliberately absent from DISMISS_REASONS (no caller can pass it) and
// excluded from `isJudged`. Counting it would pad the #70 feedback score with
// hundreds of verdicts nobody gave: Nick judged the SENDER once, and every
// message auto-filed afterwards is that one verdict being applied, not a new
// one being made.
const SENDER_MUTED = 'sender-muted';

// Lowercased and trimmed. Anything that is not a usable address returns null
// and is REFUSED rather than normalised into a key - muting "" would be a rule
// matching every email whose sender could not be read.
function normaliseSender(address) {
  const clean = String(address || '').trim().toLowerCase();
  if (!clean || !clean.includes('@')) return null;
  return clean;
}

function readSenderRules() {
  try {
    const raw = db.getState(SENDER_RULES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function writeSenderRules(rules) {
  db.setState(SENDER_RULES_KEY, JSON.stringify(rules));
}

/**
 * Record "never surface this sender again".
 *
 * Nick's OWN address is refused. He is the sender on anything he has sent to
 * himself and on some meeting traffic, and a self-mute would silently hide his
 * own mail with no visible cause - the one rule here whose blast radius is
 * unbounded. The refusal is REPORTED, never swallowed, because a mute that did
 * not happen looks identical from the panel to one that did.
 *
 * `selfAddress` is PASSED IN rather than read here, and that is deliberate:
 * the real answer is `microsoft.getSignedInAddress()`, which is async while
 * this path is synchronous, and an env var invented for the purpose would be a
 * guessed identifier that reads as empty for ever (the `sleep_core_hours` /
 * `meeting_alert` species - a wrong name returns nothing rather than failing).
 * The route resolves it from the MSAL cache and hands it over.
 *
 * When it cannot be resolved the mute still PROCEEDS. Refusing would break the
 * button on exactly the days Microsoft auth has expired, and the real safety
 * net here is not this check - it is that every rule is listed in the panel and
 * revocable in one click.
 */
function muteSender(address, { name = null, subject = null, selfAddress = null } = {}) {
  const key = normaliseSender(address);
  if (!key) return { ok: false, reason: 'no sender address on that email' };
  const self = normaliseSender(selfAddress);
  if (self && key === self) return { ok: false, reason: 'that is your own address' };

  const rules = readSenderRules();
  const existing = rules[key];
  rules[key] = {
    address: key,
    name: name || existing?.name || null,
    mutedAt: existing?.mutedAt || new Date().toISOString(),
    // What it was pressed on, so a rule Nick does not recognise months later
    // can be identified without going to Outlook to work out who this is.
    sampleSubject: existing?.sampleSubject || subject || null,
  };
  writeSenderRules(rules);
  return { ok: true, muted: key, alreadyMuted: !!existing };
}

function unmuteSender(address) {
  const key = normaliseSender(address);
  if (!key) return { ok: false, reason: 'not a valid address' };
  const rules = readSenderRules();
  if (!rules[key]) return { ok: false, reason: 'that sender is not muted' };
  delete rules[key];
  writeSenderRules(rules);
  // Deliberately does NOT resurrect the entries it filed away. Un-muting says
  // "show me this sender from now on", not "put a fortnight of newsletters
  // back in the panel".
  return { ok: true, unmuted: key };
}

function listMutedSenders() {
  return Object.values(readSenderRules())
    .sort((a, b) => String(b.mutedAt || '').localeCompare(String(a.mutedAt || '')));
}

/**
 * PURE. Applies the sender rules to one entry.
 *
 * It never touches an entry Nick has already acted on - a `done` or a `replied`
 * is his record of what he did with that message, and overwriting the reason
 * with NEURO's own would erase a verdict the feedback score reads.
 */
function applySenderMute(entry, rules, now = new Date().toISOString()) {
  if (entry.dismissed) return entry;
  const key = normaliseSender(entry.fromEmail);
  if (!key || !rules[key]) return entry;
  return {
    ...entry,
    dismissed: true,
    dismissedAt: now,
    dismissReason: SENDER_MUTED,
    category: 'IGNORE',
    lane: 'ignore',
    urgent: false,
    needsReply: false,
  };
}

// -- The FYI section ages out (7 Sep 2026) ----------------------------------
//
// 715 informational emails standing in one collapsed section, oldest 20 days
// old. Nick: "ain't no way I'm ever going to get to them." That is the correct
// reading of the number - a pile that only grows is one nobody opens, and its
// count then makes every other number on the panel harder to read.
//
// SO IT IS THE **SECTION** THIS SWEEPS, NOT THE FYI CATEGORY. Measured on the
// live store the morning it was asked for: the store held 224 FYI and 491
// IGNORE, and the panel renders BOTH under one "FYI (715)" heading. Sweeping
// the category alone would clear 224 of the 715 he is looking at and leave the
// heading reading 491 - a fix that appears not to have worked. What he named
// is what the screen says.
//
// ACTION and DELEGATE are never touched, at any age. "Nothing leaves the panel
// by age" is the rule that fixed the 24-hour window, and it still holds for
// everything that is actually owed - only the informational lanes age out, and
// only because being informational is precisely the claim that not reading
// them costs nothing.
//
// A PROMOTED entry is never aged out either. Promotion means "you filed this
// wrong, keep it in front of me" - it already re-categorises to ACTION, so the
// category test covers it, but the guard is explicit because the whole point
// of that button is that a NEURO rule does not get to overrule Nick.
//
// The age is the RECEIVED date, not when it was classified: a re-classified
// email is not a new one, and keying on classification time would reset every
// email's clock on any pass that re-read it.
//
// An entry with no readable received date is KEPT. Not knowing how old
// something is is not evidence that it is old, and a guess here silently
// deletes mail from the panel.
//
// `aged-out` is NEURO's own act, not one of Nick's verdicts - so, exactly like
// `left-inbox` and `sender-muted`, it is absent from DISMISS_REASONS (no
// caller can pass it) and excluded from `isJudged`. Counting hundreds of
// timed-out FYIs as "Nick said not relevant" would swamp the #70 feedback
// score with verdicts nobody gave.
const AGE_OUT_DAYS = Number(process.env.EMAIL_TRIAGE_FYI_AGE_DAYS || 7);
const AGE_OUT_CATEGORIES = new Set(['FYI', 'IGNORE']);
const AGED_OUT = 'aged-out';

// The one definition of "in the FYI section, and still standing". Both sweeps
// read it, so the timed one and the manual one cannot come to disagree about
// what the section contains — which is the whole reason "Clear all" is safe to
// offer next to a heading whose count comes from somewhere else.
function isInformational(e) {
  return !e.dismissed && !e.promoted && AGE_OUT_CATEGORIES.has(e.category);
}

/**
 * PURE. Closes informational entries older than the age-out window.
 *
 * Returns the ORIGINAL array when nothing qualifies, so a caller can use
 * identity to decide whether a write is needed.
 */
function ageOutInformational(entries, { now = Date.now(), days = AGE_OUT_DAYS } = {}) {
  // 0 or a nonsense value switches the rule off rather than ageing everything
  // out at once, which is the failure direction that cannot be undone.
  if (!Number.isFinite(days) || days <= 0) return { entries, aged: 0 };
  const cutoff = now - days * 86400000;
  const stamp = new Date(now).toISOString();
  let aged = 0;

  const out = entries.map((e) => {
    if (!isInformational(e)) return e;
    const arrived = e.received ? Date.parse(e.received) : NaN;
    if (!Number.isFinite(arrived) || arrived >= cutoff) return e;
    aged++;
    return { ...e, dismissed: true, dismissedAt: stamp, dismissReason: AGED_OUT };
  });

  return { entries: aged ? out : entries, aged };
}

// -- Clear all (7 Sep 2026) -------------------------------------------------
//
// The seven-day rule took the section from 715 to 234, Nick read what was left
// and said none of it was relevant. The per-card buttons are the wrong tool for
// that: 234 presses to say one thing.
//
// It closes exactly what the FYI section RENDERS - the same `isInformational`
// predicate the timed sweep uses, so the button cannot clear something the
// heading was not counting, and cannot leave behind something it was. ACTION,
// DELEGATE and anything promoted are untouched at any age, so the one genuinely
// bad outcome - a bulk press taking work with it - is impossible by
// construction rather than by the caller passing the right filter.
//
// ⚠ `section-cleared` is its OWN reason and is excluded from `isJudged`, and
// that is a deliberate call rather than an oversight. Nick says he read them,
// and that is true - but the gesture costs one click whether the section holds
// five emails or five hundred, so counting it as N verdicts would make the
// classifier's score a function of HOW BIG THE PILE GOT rather than of how
// often it was wrong. That is the sender-mute rule (one press must not swamp
// the score) with the multiplier applied all at once instead of over a
// fortnight. The per-card "Not relevant" is still the way to teach it, and it
// still mutes the sender.
const SECTION_CLEARED = 'section-cleared';

/**
 * PURE. Closes everything the FYI section is currently showing.
 *
 * Deliberately takes no age: "clear all" is a statement about what is on the
 * screen, and an age filter here would silently leave rows behind.
 */
function clearInformational(entries, { now = Date.now() } = {}) {
  const stamp = new Date(now).toISOString();
  let cleared = 0;
  const out = entries.map((e) => {
    if (!isInformational(e)) return e;
    cleared++;
    return { ...e, dismissed: true, dismissedAt: stamp, dismissReason: SECTION_CLEARED };
  });
  return { entries: cleared ? out : entries, cleared };
}

/**
 * Clear the FYI section now. `dryRun` is the count the confirmation quotes, so
 * the number Nick agrees to is the number that goes.
 */
function clearFyiSection({ dryRun = false } = {}) {
  const stored = getStoredTriage();
  const { entries, cleared } = clearInformational(stored);
  if (cleared && !dryRun) storeTriage(entries);
  return { ok: true, cleared, dryRun, remaining: entries.filter(e => !e.dismissed).length };
}

/**
 * Apply the rule to the stored blob now. The scheduled triage does this on
 * every pass; this is the manual press and the preview behind it.
 */
function purgeAgedInformational({ dryRun = false, days = AGE_OUT_DAYS } = {}) {
  const stored = getStoredTriage();
  const { entries, aged } = ageOutInformational(stored, { days });
  if (aged && !dryRun) storeTriage(entries);
  return { ok: true, aged, dryRun, days, remaining: entries.filter(e => !e.dismissed).length };
}

function readRollup() {
  try {
    const raw = JSON.parse(db.getState(FEEDBACK_ROLLUP_KEY) || '{}');
    // Every counter must be listed here. This normaliser is also what
    // `foldUnderRanked` reads before incrementing, so a field it forgets is a
    // field that silently resets to 0 on every write — `underRanked` could
    // never have exceeded 1.
    return {
      judged: raw.judged || 0,
      notRelevant: raw.notRelevant || 0,
      underRanked: raw.underRanked || 0,
      byCategory: raw.byCategory || {},
    };
  } catch { return { judged: 0, notRelevant: 0, underRanked: 0, byCategory: {} }; }
}

function isJudged(e) {
  // `left-inbox` is triage noticing the mail has gone from the Inbox, not Nick
  // telling the classifier anything — counting it would pad the feedback score
  // with verdicts nobody gave.
  return e.dismissed && e.dismissReason
    && e.dismissReason !== 'unspecified' && e.dismissReason !== 'left-inbox'
    // Nick judged the SENDER once. Every message auto-filed by that rule
    // afterwards is the same verdict being applied, not a new one being made -
    // counting them would let one mute press swamp the whole feedback score.
    && e.dismissReason !== SENDER_MUTED
    // Same again for the age-out sweep: a timed-out FYI is NEURO deciding
    // nobody was ever going to read it, not Nick saying it was misfiled.
    && e.dismissReason !== AGED_OUT
    // And the bulk clear. One click is one gesture however many rows it
    // covered; N verdicts out of it would score the classifier on the size of
    // the pile rather than on how often it was wrong.
    && e.dismissReason !== SECTION_CLEARED;
}

// Anything judged that is about to leave the blob — pruned by age, or dropped
// by a deliberate clear — pays its verdict into the rollup on the way out.
// Nick pressing "clear" means he wants a fresh triage, not that he wants the
// classifier to forget he ever corrected it.
function foldIntoRollup(entries) {
  const judged = entries.filter(isJudged);
  if (!judged.length) return;
  const rollup = readRollup();
  for (const e of judged) {
    const key = `${e.urgency || 'none'}/${e.category || 'none'}`;
    rollup.byCategory[key] = rollup.byCategory[key] || { judged: 0, notRelevant: 0 };
    rollup.byCategory[key].judged++;
    rollup.judged++;
    if (e.dismissReason === 'not-relevant') {
      rollup.byCategory[key].notRelevant++;
      rollup.notRelevant++;
    }
  }
  db.setState(FEEDBACK_ROLLUP_KEY, JSON.stringify(rollup));
}

/**
 * The single write path for the triage blob. Compacts dismissed entries, drops
 * ones older than the retention window, and folds anything dropped into the
 * feedback rollup on its way out.
 */
function storeTriage(items, now = Date.now()) {
  const cutoff = now - DISMISSED_RETAIN_DAYS() * 86400000;
  const kept = [];
  const expired = [];

  for (const e of items) {
    // A dismissed entry with no timestamp cannot be aged, so it is kept rather
    // than guessed at — it will be stamped the next time it is dismissed.
    const age = e.dismissed && e.dismissedAt ? new Date(e.dismissedAt).getTime() : null;
    if (age != null && age < cutoff) expired.push(e);
    else kept.push(compact(e));
  }

  if (expired.length) {
    foldIntoRollup(expired);
    console.log(`[EmailTriage] Pruned ${expired.length} dismissed entries older than ${DISMISSED_RETAIN_DAYS()}d`);
  }

  db.setState('email_triage', JSON.stringify(kept));
  return { kept: kept.length, pruned: expired.length };
}

// The one shape every runTriage branch reports its numbers in: what is still
// on Nick's plate, never what a particular pass happened to look at.
function outstandingCounts() {
  const cat = getTriageByCategory();
  return {
    count: cat.action.length + cat.fyi.length + cat.delegate.length,
    urgent: cat.urgent.length,
    reply: cat.reply.length,
    action: cat.action.length,
    fyi: cat.fyi.length,
    delegate: cat.delegate.length,
    ignore: cat.ignore.length,
  };
}

function inputFingerprint(emails) {
  return require('crypto')
    .createHash('sha1')
    .update(emails.map(e => e.id).sort().join('|'))
    .digest('hex');
}

/**
 * Run a full triage cycle — fetch, classify, store.
 *
 * `force` skips the unchanged-input check. Anything Nick pressed himself, and
 * anything that has just wiped the stored blob, must actually re-run.
 */
async function runTriage({ force = false } = {}) {
  const microsoft = require('./microsoft');
  if (!microsoft.isBridgeConfigured() && !(await microsoft.isAuthenticated())) {
    return { ok: false, reason: 'M365 not connected' };
  }

  try {
    const fetched = await microsoft.fetchRecentEmailsDetailed(LOOKBACK_HOURS, MAX_FETCH);
    const emails = fetched?.emails ?? null;
    const complete = !!fetched?.complete;

    // `null` means we could not READ the mailbox; `[]` means we read it and
    // there was nothing. Those were one branch, and it wiped the stored triage
    // either way — so a Graph outage published an empty inbox, and now that the
    // urgent banner is driven from here it would have cleared that too. An
    // all-clear NEURO never actually established is the exact failure the
    // retired scanner's pile was the other half of. Leave the last known state
    // alone and say why.
    if (emails === null) {
      console.warn('[EmailTriage] Mailbox unreachable — keeping the last known triage rather than publishing an empty one');
      return { ok: false, reason: 'mailbox unreachable', stale: true };
    }

    // An empty read used to wipe everything undismissed. It no longer gets a
    // branch of its own: it is just a fetch containing nothing, and the merge
    // below already knows what to do with mail it did not see.

    // Same mail as last time → the classification would be identical, so skip
    // the (cloud, paid) model call. Gated on HAVING a stored classification,
    // not on it being non-empty: an inbox Nick has fully actioned is the normal
    // end state of a good day, and treating that as "nothing stored" would pay
    // for a full re-classification every 30 minutes precisely when there is
    // nothing to do. A `/triage/clear` forces instead.
    const fingerprint = inputFingerprint(emails);
    const stored = getStoredTriage();
    if (!force && fingerprint === db.getState(INPUT_KEY) && stored.length > 0) {
      // The age-out sweep still runs. It is a function of the CLOCK, not of the
      // mail, so gating it behind "new mail arrived" would leave an FYI that
      // crossed the seven-day line sitting in the section until something else
      // landed — a rule that only fires when it happens to be convenient.
      const swept = ageOutInformational(stored);
      if (swept.aged) {
        storeTriage(swept.entries);
        console.log(`[EmailTriage] Aged out ${swept.aged} informational email(s) older than ${AGE_OUT_DAYS}d`);
      }
      // We DID look — the panel's "last triage" is a statement about when NEURO
      // last checked the inbox, and it checked.
      db.setState('email_triage_time', String(Date.now()));
      console.log(`[EmailTriage] ${emails.length} emails, none new since last run — skipped the model call`);
      return { ok: true, skipped: true, classified: 0, ...outstandingCounts() };
    }

    const priorById = new Map(stored.map(e => [e.id, e]));
    // `force` skips the FINGERPRINT check, and only that. It deliberately does
    // NOT re-buy classifications: an email's text has not changed, so the only
    // things a re-ask produces are cost and churn. Measured on the button's
    // first live press — 663 emails re-classified, and the categories moved
    // (FYI 241 → 285, IGNORE 190 → 149) on no new information at all, which is
    // a panel disagreeing with itself rather than a panel being refreshed.
    // `/triage/clear` empties the store, so a genuine re-triage happens there
    // by construction.
    const classified = await classifyEmails(emails, priorById);
    db.setState(INPUT_KEY, fingerprint);

    // ── The merge ───────────────────────────────────────────────────────────
    //
    // This used to be `existing.filter(dismissed)` plus whatever the fetch
    // returned — so an email Nick had NOT dealt with was carried by nothing and
    // disappeared the moment it fell out of the window. The set is now keyed by
    // id and every entry has to be positively accounted for.
    //
    // Nick's verdicts are the things a re-classification must NOT overwrite.
    // That was already true of `dismissed`; it is equally true of a promotion,
    // and at a 30-minute cadence a promotion that did not survive the merge
    // would silently drop back to FYI within the half hour — the button would
    // appear to work and then quietly undo itself.
    const fetchedIds = new Set(emails.map(e => e.id));
    const windowStart = Date.now() - LOOKBACK_HOURS * 3600000;
    let departed = 0;

    // Keying on id also removes a duplicate the old shape produced: a dismissed
    // email still inside the window appeared in both halves of the list.
    const byId = new Map(stored.map(e => [e.id, e]));

    for (const e of stored) {
      if (e.dismissed || fetchedIds.has(e.id)) continue;
      // We could not see the whole window, so its absence says nothing.
      if (!complete) continue;
      const arrived = e.received ? Date.parse(e.received) : NaN;
      // Older than what we looked at — kept, indefinitely. Age is never a
      // reason to drop something Nick has not answered.
      if (!Number.isFinite(arrived) || arrived < windowStart + DEPARTURE_GRACE_MS) continue;
      // Inside a complete read and not there: it has been deleted, filed or
      // moved out of the Inbox. Recorded rather than silently deleted, and with
      // a reason that is plainly not one of Nick's.
      byId.set(e.id, {
        ...e,
        dismissed: true,
        dismissedAt: new Date().toISOString(),
        dismissReason: LEFT_INBOX,
      });
      departed++;
    }

    // A sender rule is durable and the entries it produces are not, so the
    // rules are re-applied on every pass. That is what makes a mute survive the
    // pruning of its own dismissed entries, and what files a muted sender's NEW
    // mail without Nick having to press anything again.
    const senderRules = readSenderRules();
    let autoFiled = 0;

    for (const e of classified) {
      const prev = priorById.get(e.id);
      byId.set(e.id, applyPromotion({
        ...e,
        dismissed: prev?.dismissed || false,
        dismissedAt: prev?.dismissedAt || null,
        dismissReason: prev?.dismissReason,
        promoted: prev?.promoted || false,
        promotedAt: prev?.promotedAt || null,
      }));
    }

    let updated = [...byId.values()];
    if (Object.keys(senderRules).length) {
      const stamp = new Date().toISOString();
      updated = updated.map((e) => {
        const after = applySenderMute(e, senderRules, stamp);
        if (after !== e) autoFiled++;
        return after;
      });
      if (autoFiled) {
        console.log(`[EmailTriage] ${autoFiled} email(s) auto-filed by a muted-sender rule`);
      }
    }
    if (departed) {
      console.log(`[EmailTriage] ${departed} entr${departed === 1 ? 'y' : 'ies'} no longer in the Inbox — closed as ${LEFT_INBOX}`);
    }

    // LAST of the three sweeps, and after the merge, so it judges the category
    // this pass just assigned rather than the one the previous pass did.
    const swept = ageOutInformational(updated);
    updated = swept.entries;
    if (swept.aged) {
      console.log(`[EmailTriage] Aged out ${swept.aged} informational email(s) older than ${AGE_OUT_DAYS}d`);
    }

    storeTriage(updated);
    db.setState('email_triage_time', String(Date.now()));

    // Raise/refresh/clear the urgent-email banner off the set just stored.
    // The retired scanner used to own this; the nudge now fires from the same
    // pass that produces the list it describes. Never allowed to fail triage.
    try {
      require('./nudges').triggerUrgentEmailNudge();
    } catch (e) {
      console.warn('[EmailTriage] Failed to sync urgent email nudge:', e.message);
    }

    // ── Lift the obligations out ────────────────────────────────────────────
    //
    // Triage's own chain ends at classification, and for months that was the
    // whole of it: an ACTION-lane card said "this email needs attention" and
    // nothing anywhere said "this is a thing you agreed to do". This asks the
    // urgent and reply lanes what Nick has actually been asked for and queues
    // it for REVIEW — never as a task, never auto-promoted.
    //
    // Awaited but never allowed to fail triage, exactly like the calendar sync
    // below it: classifying the inbox is the job, this is a passenger. It reads
    // `updated` rather than `classified` so it sees dismissals and promotions
    // as they were just stored.
    try {
      await require('./email-actions').extractFromTriage(updated);
    } catch (e) {
      console.warn('[EmailTriage] Obligation extraction failed:', e.message);
    }

    const urgentCount = classified.filter(e => e.lane === 'urgent').length;
    const replyCount = classified.filter(e => e.lane === 'reply').length;
    console.log(`[EmailTriage] Classified ${classified.length} emails, ${urgentCount} urgent, ${replyCount} need reply`);

    // Meeting invites arrive as email, so triage is the earliest point we know
    // one landed. Sync the calendar here rather than waiting for the next timer
    // — sync reports which events are new and checks those for a missing agenda,
    // so the ask reaches the organiser while they are still thinking about the
    // meeting they just sent. Awaited but never allowed to fail the triage:
    // classifying the inbox is the job, this is a passenger.
    try {
      await require('./calendar-sync').sync({ days: 14 });
    } catch (e) {
      console.warn('[EmailTriage] Calendar sync after triage failed:', e.message);
    }

    // Reported as what is STILL OUTSTANDING, not as what was just classified.
    // Those are different populations — a run over 40 emails Nick has already
    // dealt with is a run with nothing to show for it — and the skip branch
    // could only ever report the outstanding one. Two branches returning the
    // same field names for different things is how the 37 happened.
    // `classified` is kept separately: it says what the run DID.
    return { ok: true, classified: classified.length, ...outstandingCounts() };
  } catch (e) {
    console.error('[EmailTriage] Failed:', e.message);
    return { ok: false, error: e.message };
  }
}

function getStoredTriage() {
  try {
    const raw = db.getState('email_triage');
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function getTriageByCategory() {
  const all = getStoredTriage().filter(e => !e.dismissed);
  return {
    urgent: all.filter(e => e.lane === 'urgent'),
    reply: all.filter(e => e.lane === 'reply'),
    action: all.filter(e => e.category === 'ACTION'),
    fyi: all.filter(e => e.category === 'FYI'),
    delegate: all.filter(e => e.category === 'DELEGATE'),
    ignore: all.filter(e => e.category === 'IGNORE'),
    lastRun: db.getState('email_triage_time')
  };
}

// The ONE definition of "someone is waiting on Nick today" (26 Aug 2026).
//
// This used to live in nudges.js, computed against a SECOND, independent scan:
// `inbox-scanner.js` writing the `inbox_items` table. Nothing reconciled the
// two. Dismissing in the panel writes here and never wrote there, no frontend
// ever called the scanner's dismiss route, and the 24-hour purge was reachable
// only from a manual endpoint — so that table was a write-only pile going back
// twelve days, and the push notification counted it. Measured the morning it
// was found: SARA said **37 urgent emails**, the panel showed 3, and all 114
// rows in the table had `dismissed = 0`. Two scanners were also paying the AI
// to classify the same mailbox on two different schedules.
//
// So the scanner is retired and this is the only store. The nudge, the chat
// context and the panel now read one blob through one predicate: the count
// that interrupts Nick and the list he opens cannot describe different mail.
function getUrgentEmails() {
  return getStoredTriage().filter(e => !e.dismissed && e.lane === 'urgent');
}

const URGENCY_RANK = { high: 0, medium: 1, low: 2 };

/**
 * Everything triage is still holding, worst first — the chat and SARA context
 * feed. Replaces `inbox-scanner.getFlaggedItems()` and keeps its shape so the
 * consumers did not have to learn a second vocabulary.
 *
 * `lastRun` is null when triage has never run, and is NOT the same claim as an
 * empty list: "we have not looked" must stay distinguishable from "your inbox
 * is clear", which is the whole lesson of the pile this replaces.
 */
function getFlaggedItems() {
  const items = getStoredTriage()
    .filter(e => !e.dismissed && e.lane !== 'ignore')
    .map(e => ({
      emailId: e.id,
      subject: e.subject,
      from: e.from,
      fromEmail: e.fromEmail,
      urgency: e.urgency,
      category: e.category,
      // The blob carries no model-written summary — the deterministic reason
      // and the preview are what we actually have. Stating the preview as a
      // summary would be inventing one.
      summary: (e.preview || '').slice(0, 160),
      reason: e.reason,
      received: e.received,
      isRead: !!e.isRead,
      hasAttachments: !!e.hasAttachments,
    }))
    .sort((a, b) => (URGENCY_RANK[a.urgency] ?? 3) - (URGENCY_RANK[b.urgency] ?? 3));

  const lastRun = db.getState('email_triage_time');
  return {
    items,
    lastScan: lastRun ? new Date(Number(lastRun)).toISOString() : null,
  };
}

// #70 — why it was dismissed, not just that it was.
//
// "Done" and "Not relevant" called the identical endpoint, so the distinction
// was painted on. Every "not relevant" is Nick telling triage its ranking was
// wrong, and that was discarded on the spot — the only feedback this classifier
// will ever get for free. Two buttons that do the same thing quietly teach him
// they mean nothing.
// `left-inbox` is NEURO's own observation, not one of Nick's verdicts, so it is
// deliberately absent from this set: it can only be written by the merge, never
// by a caller passing a string.
const DISMISS_REASONS = new Set(['done', 'not-relevant', 'replied', 'unspecified']);
const LEFT_INBOX = 'left-inbox';

function dismissEmail(emailId, reason = 'unspecified', { selfAddress = null } = {}) {
  const clean = DISMISS_REASONS.has(reason) ? reason : 'unspecified';
  const all = getStoredTriage();
  const item = all.find(e => e.id === emailId);
  const now = new Date().toISOString();
  let updated = all.map(e =>
    e.id === emailId
      ? { ...e, dismissed: true, dismissedAt: now, dismissReason: clean }
      : e
  );

  // "Not relevant" mutes the sender on the first press, and the rule is applied
  // to what is ALREADY in the panel in the same breath. The twelve editions
  // that arrived before Nick got round to pressing it are precisely the mail he
  // is telling us he does not want, and leaving them sitting there would make
  // the button look like it had half worked.
  let muted = null;
  if (clean === 'not-relevant' && item) {
    muted = muteSender(item.fromEmail, { name: item.from, subject: item.subject, selfAddress });
    if (muted.ok) {
      const rules = readSenderRules();
      let swept = 0;
      updated = updated.map((e) => {
        if (e.id === emailId) return e;
        const after = applySenderMute(e, rules, now);
        if (after !== e) swept++;
        return after;
      });
      console.log(`[Triage] Muted ${muted.muted}`
        + (swept ? ` - filed ${swept} already in the panel` : ''));
    } else {
      console.warn(`[Triage] Did NOT mute the sender of `
        + `"${(item.subject || emailId).slice(0, 60)}" - ${muted.reason}`);
    }
  }

  storeTriage(updated);
  if (clean === 'not-relevant') {
    // Logged loudly on purpose: it is a misclassification report, and until
    // something consumes it the log is the only place it exists.
    console.log(`[Triage] Misranked — "${(item?.subject || emailId).slice(0, 80)}" `
      + `was ${item?.urgency || '?'}/${item?.category || '?'} and Nick says not relevant`);
  }

  // Clearing the last urgent email should silence the banner on the spot, not
  // at the next triage run. Actioning mail and watching the count stay put is
  // exactly the bug this whole change exists to fix.
  try { require('./nudges').triggerUrgentEmailNudge(); } catch {}

  // The caller says what happened to the SENDER, not just to the message - a
  // refused mute (no address, or Nick's own) must reach the panel in words
  // rather than being a silent no-op behind a button that looked like it fired.
  return { ok: true, muted };
}

// ── "This should have been an action" (26 Aug 2026) ─────────────────────────
//
// The mirror of "Not relevant", and the half that was missing. Triage can be
// wrong in two directions, and only one of them had a button: over-ranking got
// recorded as a misclassification, while under-ranking — the expensive
// direction, since a buried ACTION is work Nick never sees — could only be
// fixed by going and finding the email in Outlook, which teaches him the
// classifier cannot be corrected.
//
// It is NOT a dismissal. "Not relevant" says "take this away"; this says "you
// filed it wrong, keep it in front of me", so the email stays in the list and
// moves to the ACTION group.
//
// Deliberately lands in `reply`, never `urgent`: the urgent lane is what drives
// the push notification, and a correction Nick makes while reading the panel is
// not a reason to interrupt the person already reading it.
function applyPromotion(entry) {
  if (!entry.promoted) return entry;
  return {
    ...entry,
    category: 'ACTION',
    lane: 'reply',
    // Never demote something the rules already rated higher.
    urgency: entry.urgency === 'high' ? 'high' : 'medium',
    urgent: false,
    needsReply: true,
    reason: entry.reason ? `${entry.reason} · promoted by Nick` : 'promoted by Nick',
  };
}

function promoteEmail(emailId) {
  const all = getStoredTriage();
  const item = all.find(e => e.id === emailId);
  // Distinguishable from "promoted it": the caller can say so rather than
  // reporting a success that moved nothing.
  if (!item) return { ok: false, reason: 'not in triage' };
  if (item.dismissed) return { ok: false, reason: 'already dismissed' };

  const promotedAt = new Date().toISOString();
  storeTriage(all.map(e => (
    e.id === emailId ? applyPromotion({ ...e, promoted: true, promotedAt }) : e
  )));

  // Recorded against what triage SAID, not what it now says — the whole point
  // is which verdict was wrong.
  foldUnderRanked(item);
  console.log(`[Triage] Under-ranked — "${(item.subject || emailId).slice(0, 80)}" `
    + `was ${item.urgency || '?'}/${item.category || '?'} and Nick says it needs action`);

  return { ok: true, promoted: true };
}

function foldUnderRanked(item) {
  const rollup = readRollup();
  const key = `${item.urgency || 'none'}/${item.category || 'none'}`;
  rollup.byCategory[key] = rollup.byCategory[key] || { judged: 0, notRelevant: 0 };
  rollup.byCategory[key].judged++;
  rollup.byCategory[key].underRanked = (rollup.byCategory[key].underRanked || 0) + 1;
  rollup.judged++;
  rollup.underRanked = (rollup.underRanked || 0) + 1;
  db.setState(FEEDBACK_ROLLUP_KEY, JSON.stringify(rollup));
}

/**
 * How the classifier is doing, by its own output, against Nick's verdict.
 *
 * Deliberately counts only what he has actually judged: an email still sitting
 * in triage is not evidence either way, and folding it in would make the score
 * improve simply because he has not got to it yet.
 *
 * `judged` counts VERDICTS, not emails — an email promoted and later marked
 * done carries two, because Nick said two separate things about it. Triage can
 * be wrong in both directions and `misrankRate` now covers both: over-ranking
 * (`notRelevant`) and under-ranking (`underRanked`). A score that only ever
 * counted the over-ranked half flattered the classifier for the failure that
 * costs most — mail Nick never sees.
 */
function getDismissFeedback() {
  // Live judgements plus the rollup of the ones pruned out of the blob. Reading
  // only what is still stored would make the classifier's score silently reset
  // every seven days, and always look like a young classifier with a small
  // sample — the opposite of what a feedback score is for.
  const rollup = readRollup();
  const byCategory = {};
  for (const [key, v] of Object.entries(rollup.byCategory)) {
    byCategory[key] = { judged: v.judged, notRelevant: v.notRelevant, underRanked: v.underRanked || 0 };
  }
  let judged = rollup.judged;
  let notRelevant = rollup.notRelevant;
  const underRanked = rollup.underRanked || 0;

  for (const e of getStoredTriage().filter(isJudged)) {
    const key = `${e.urgency || 'none'}/${e.category || 'none'}`;
    byCategory[key] = byCategory[key] || { judged: 0, notRelevant: 0, underRanked: 0 };
    byCategory[key].judged++;
    judged++;
    if (e.dismissReason === 'not-relevant') {
      byCategory[key].notRelevant++;
      notRelevant++;
    }
  }

  return {
    judged,
    notRelevant,
    underRanked,
    // Null rather than 0 when nothing has been judged — an untested classifier
    // is not a perfect one.
    misrankRate: judged ? Math.round(((notRelevant + underRanked) / judged) * 100) : null,
    // Kept separate so a rate that moved can be attributed to a direction:
    // ranking things too high and burying things are different faults with
    // different fixes.
    overRankRate: judged ? Math.round((notRelevant / judged) * 100) : null,
    underRankRate: judged ? Math.round((underRanked / judged) * 100) : null,
    byCategory,
  };
}

function clearDismissed() {
  const all = getStoredTriage();
  foldIntoRollup(all.filter(e => e.dismissed));
  storeTriage(all.filter(e => !e.dismissed));
}

module.exports = {
  runTriage,
  getTriageByCategory,
  getUrgentEmails,
  getFlaggedItems,
  // Read-only accessor. The reply route needs the cached subject/sender to
  // record a sent reply (#69) without paying for a live Graph fetch — and a
  // fetch that can fail must not be on the path of bookkeeping for mail that
  // has already left.
  getStoredTriage,
  dismissEmail,
  promoteEmail,
  getDismissFeedback,
  clearDismissed,
  muteSender,
  unmuteSender,
  listMutedSenders,
  purgeAgedInformational,
  clearFyiSection,
  TRIAGE_CACHE_TTL,
  _internals: {
    inputFingerprint, storeTriage, DISMISSED_RETAIN_DAYS, CLASSIFY_BATCH,
    ageOutInformational, AGE_OUT_DAYS, AGED_OUT, AGE_OUT_CATEGORIES,
    clearInformational, SECTION_CLEARED, isInformational,
    applySenderMute, normaliseSender, readSenderRules, SENDER_MUTED, LOOKBACK_DAYS,
    classifyEmails, DISMISSED_FIELDS,
  },
};
