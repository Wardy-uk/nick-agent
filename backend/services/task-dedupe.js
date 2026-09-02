'use strict';

/**
 * Task de-duplication — NEURO tasks vs Microsoft (Planner / To Do).
 *
 * NEURO owns tasks (13 Aug 2026) but Microsoft owns its own, so `parseVaultTodos`
 * deliberately merges Microsoft lines in WITHOUT deduping them — the DB-task merge
 * only ever suppressed Master Todo and Daily lines. That is correct as far as it
 * goes and it leaves a real hole: the same action written twice, once by Nick in
 * To Do and once by a meeting promotion into NEURO, shows up as two tasks.
 *
 * `dedupe_key` cannot close it. It is a normalised-text UNIQUE key, so it matches
 * only re-imports of the SAME wording. Measured on the live vault: Planner holds
 * "Succession plan" and NEURO #58 holds "Build succession plan — cover for HoTS and
 * emerging team leads…". Same work, no shared key, and no amount of normalising
 * gets one to the other.
 *
 * So this is a SUGGESTER, not a merger. It ranks pairs and hands them to Nick side
 * by side; nothing is ever linked without him saying so. Two reasons that is not
 * timidity: the populations are small enough that reviewing is cheap (16 Microsoft
 * against ~159 NEURO), and a wrong auto-merge hides a real task behind an unrelated
 * one — silently, and in the one place he goes to find out what he has to do.
 *
 * Matching is deterministic: token overlap weighted by inverse document frequency
 * over the two task lists. No model call, so it is instant, free, identical every
 * run and works with the Pi offline. IDF is what makes it usable on Nick's corpus
 * specifically — "review", "support" and "customer" appear in dozens of his tasks
 * and carry almost no evidence, while "succession" or "sandford" appear once or
 * twice and nearly identify a task on their own. An unweighted overlap ranks the
 * common words equally and buries the real pairs.
 *
 * The top half is PURE — it takes plain arrays and returns plain objects, so the
 * ranking (which is the product) is testable without a DB, a vault or a clock,
 * the same split as pi-health.assess() and state-of-play.assess().
 */

const db = require('../db/database');
const taskStore = require('./task-store');

// ── Pure: tokens, weights, scoring ───────────────────────────────────────────

// Grammatical noise only. Domain words are NOT stripped here — IDF discounts them
// by how often they actually occur in Nick's tasks, which is a fact about his list
// rather than a guess baked into a constant.
const STOPWORDS = new Set([
  'a', 'about', 'across', 'after', 'against', 'all', 'also', 'an', 'and', 'any',
  'are', 'as', 'at', 'be', 'been', 'before', 'being', 'between', 'both', 'but',
  'by', 'can', 'do', 'does', 'doing', 'done', 'e', 'each', 'eg', 'etc', 'for',
  'from', 'g', 'get', 'gets', 'had', 'has', 'have', 'he', 'her', 'his', 'how',
  'i', 'if', 'in', 'into', 'is', 'it', 'its', 'me', 'more', 'most', 'my', 'need',
  'needs', 'no', 'not', 'of', 'on', 'once', 'one', 'only', 'or', 'other', 'our',
  'out', 'over', 'own', 'per', 'she', 'should', 'so', 'some', 'such', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'through', 'to', 'up', 'us', 'use', 'via', 'was', 'we', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'will', 'with', 'would',
  'you', 'your',
]);

// Short numerals and single letters survive normalisation but identify nothing.
function isContentToken(t) {
  if (t.length < 3) return false;
  if (STOPWORDS.has(t)) return false;
  if (/^\d+$/.test(t)) return false;
  return true;
}

/**
 * Crude suffix folding so "reports"/"report" and "incentives"/"incentive" match.
 * Deliberately not a real stemmer: a stemmer's aggressive cases (ational → ate)
 * collapse words that mean different things, and the whole point here is that a
 * shared rare token is treated as strong evidence.
 *
 * The gerund rule is not optional. Nick writes the same job as a noun in one
 * place and an activity in the other — "Succession plan" in Planner against
 * "Succession planning for team leads" — and without folding -ing those share
 * ONE token, drop under the two-token rule and are never offered. Measured: that
 * pair scores 0.195 unfolded and 1.0 folded. Same for report/reporting and
 * review/reviewing, which are most of his task verbs.
 *
 * Doubled consonants are collapsed after stripping (planning → plann → plan),
 * or the fold produces a stem that matches nothing and the rule does no work.
 */
function stem(token) {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('es') && !token.endsWith('ses')) return undouble(token.slice(0, -2));
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  if (token.length > 5 && token.endsWith('ing')) return undouble(token.slice(0, -3));
  if (token.length > 4 && token.endsWith('ed') && !token.endsWith('eed')) return undouble(token.slice(0, -2));
  return token;
}

/** planning → plann → plan. Vowels are left alone: "seed" must not become "sed". */
function undouble(stemmed) {
  if (stemmed.length > 3 && /([bdfglmnprt])\1$/.test(stemmed)) return stemmed.slice(0, -1);
  return stemmed;
}

/** Content tokens of a task, deduped. Reuses task-store's normaliser so the two
 *  halves of de-duplication cannot disagree on what a task's text even is. */
function tokenize(text) {
  const norm = taskStore.normalizeText(text);
  const out = new Set();
  for (const raw of norm.split(' ')) {
    if (!isContentToken(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/**
 * Inverse document frequency across every task in play, both sides.
 * Smoothed, and floored at 0 so a token present in EVERY task contributes
 * nothing rather than going negative.
 */
function buildIdf(tokenSets) {
  const n = Math.max(tokenSets.length, 1);
  const docCount = new Map();
  for (const set of tokenSets) {
    for (const t of set) docCount.set(t, (docCount.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [token, count] of docCount) {
    idf.set(token, Math.max(0, Math.log((n + 1) / (count + 0.5))));
  }
  return idf;
}

function weightOf(tokens, idf) {
  let sum = 0;
  for (const t of tokens) sum += idf.get(t) ?? 1;
  return sum;
}

// A pair needs this much evidence before it is worth Nick's attention at all.
// Below it the screen fills with coincidences ("review", "team") and stops being
// read — the failure mode that matters more than a missed pair, because a missed
// pair is the status quo and a noisy screen is a new problem.
//
// MEASURED, not picked. Scored over the live lists (159 NEURO × 16 Microsoft =
// 2,544 pairs) the ranking separates cleanly: exactly one true duplicate at 1.0
// ("Succession plan" / "Build succession plan — cover for HoTS…"), and the highest
// scoring NON-duplicate is 0.397 ("Extract Production Ops from Support" against
// "Provide realistic headcount for production/support per squad"). 0.42 sits in
// that gap. Worth knowing what this implies: the screen is EMPTY most days, and
// that is the correct answer rather than a broken matcher — the value is in
// catching pairs as meetings keep promoting tasks, not in a one-off cleanup.
// `weakMinScore` on the route is the way to look under the line deliberately.
const MIN_SCORE = 0.42;
const STRONG_SCORE = 0.7;
const MIN_SHARED_TOKENS = 2;

/**
 * Score one pair. Pure.
 *
 * Two measures, and the higher wins:
 *   containment — how much of the SHORTER task is inside the longer one. This is
 *     the one that catches "Succession plan" against the fuller NEURO wording,
 *     and it is why a plain Jaccard is not enough: that pair scores 0.14 on
 *     Jaccard and 1.0 on containment, and it is a genuine duplicate.
 *   jaccard — how much the two overlap overall, which is what catches two
 *     similar-length rewordings of the same action.
 *
 * Both are weighted by IDF, so overlap on rare words counts and overlap on
 * Nick's stock vocabulary barely does.
 */
function scorePair(aTokens, bTokens, idf) {
  const shared = [];
  for (const t of aTokens) if (bTokens.has(t)) shared.push(t);
  if (shared.length === 0) return { score: 0, shared: [], containment: 0, jaccard: 0 };

  const sharedWeight = weightOf(shared, idf);
  const aWeight = weightOf(aTokens, idf);
  const bWeight = weightOf(bTokens, idf);
  const unionWeight = aWeight + bWeight - sharedWeight;

  const smaller = Math.min(aWeight, bWeight);
  const containment = smaller > 0 ? sharedWeight / smaller : 0;
  const jaccard = unionWeight > 0 ? sharedWeight / unionWeight : 0;

  // A single shared token can reach containment 1.0 when the shorter task is one
  // word long ("FOC report" vs anything mentioning reports). Require two shared
  // content tokens before containment is allowed to carry a pair on its own.
  const score = shared.length >= MIN_SHARED_TOKENS
    ? Math.max(containment, jaccard)
    : jaccard;

  return {
    score: Number(score.toFixed(3)),
    shared: shared.sort((x, y) => (idf.get(y) ?? 0) - (idf.get(x) ?? 0)),
    containment: Number(containment.toFixed(3)),
    jaccard: Number(jaccard.toFixed(3)),
  };
}

/**
 * The words a human should look at to judge the pair — the shared tokens carrying
 * the most evidence. Shown on the card so the score is never the only thing said;
 * a bare "78%" is not reviewable, "shares: succession, plan" is.
 */
function distinctiveShared(shared, idf, limit = 4) {
  return shared.slice(0, limit).map(t => ({ token: t, weight: Number((idf.get(t) ?? 0).toFixed(2)) }));
}

/** Human-readable notes about the pair beyond the text match. Facts, not fudges —
 *  none of these move the score, because a due date agreeing is corroboration for
 *  Nick to read, not evidence that two different jobs are one job. */
function pairNotes(neuro, ms) {
  const notes = [];
  if (neuro.due_date && ms.due_date) {
    notes.push(neuro.due_date === ms.due_date
      ? `Same due date (${neuro.due_date})`
      : `Due dates differ — NEURO ${neuro.due_date}, Microsoft ${ms.due_date}`);
  } else if (ms.due_date && !neuro.due_date) {
    notes.push(`Only Microsoft has a due date (${ms.due_date})`);
  } else if (neuro.due_date && !ms.due_date) {
    notes.push(`Only NEURO has a due date (${neuro.due_date})`);
  }
  return notes;
}

/**
 * Rank candidate duplicates. PURE — pass the two lists and the dismissed set.
 *
 * neuroTasks: [{ id, text, due_date, source, created_at, ms_id }]
 * msTasks:    [{ ms_id, text, due_date, source }]
 * dismissed:  Set of `${taskId}::${msId}` pairs Nick has already said are NOT the same
 *
 * A Microsoft task can appear against more than one NEURO task and vice versa —
 * they are suggestions, and collapsing to a single best guess per side hides the
 * near-miss that is often the right answer.
 */
function rankCandidates({ neuroTasks = [], msTasks = [], dismissed = new Set(), minScore = MIN_SCORE } = {}) {
  const neuro = neuroTasks
    .filter(t => !t.ms_id)          // already linked — nothing left to decide
    .map(t => ({ task: t, tokens: tokenize(t.text) }))
    .filter(t => t.tokens.size > 0);
  const ms = msTasks
    .filter(t => t.ms_id)
    .map(t => ({ task: t, tokens: tokenize(t.text) }))
    .filter(t => t.tokens.size > 0);

  const idf = buildIdf([...neuro.map(t => t.tokens), ...ms.map(t => t.tokens)]);

  const pairs = [];
  for (const m of ms) {
    for (const n of neuro) {
      if (dismissed.has(pairKey(n.task.id, m.task.ms_id))) continue;
      const scored = scorePair(n.tokens, m.tokens, idf);
      if (scored.score < minScore) continue;
      pairs.push({
        pairKey: pairKey(n.task.id, m.task.ms_id),
        score: scored.score,
        confidence: scored.score >= STRONG_SCORE ? 'strong' : 'possible',
        matchedOn: scored.containment >= scored.jaccard ? 'containment' : 'overlap',
        sharedWords: distinctiveShared(scored.shared, idf),
        notes: pairNotes(n.task, m.task),
        neuro: {
          id: n.task.id,
          text: n.task.text,
          due_date: n.task.due_date || null,
          source: n.task.source || null,
          origin_path: n.task.origin_path || null,
          created_at: n.task.created_at || null,
          moscow: n.task.moscow || null,
        },
        ms: {
          ms_id: m.task.ms_id,
          text: m.task.text,
          due_date: m.task.due_date || null,
          source: m.task.source || null,
          // The board it sits on. Carried into the link so a confirmed pair can
          // still say where the Microsoft half lives once its line is suppressed.
          msPlan: m.task.msPlan || null,
        },
      });
    }
  }

  pairs.sort((a, b) => b.score - a.score || a.neuro.id - b.neuro.id);
  return pairs;
}

function pairKey(taskId, msId) {
  return `${taskId}::${msId}`;
}

// ── NEURO against itself ─────────────────────────────────────────────────────
//
// The gap this closes, found 31 Aug 2026 by measuring the live list rather than
// by a failure: `rankCandidates` above compares NEURO against MICROSOFT, and
// NOTHING has ever compared NEURO tasks against each other. The only guard on
// that side is `task-store.dedupeKey` — the first 80 characters of normalised
// text, UNIQUE — which matches a re-import of the same wording and nothing else.
// So two captures of one commitment, worded differently, are two rows for ever.
//
// Measured over the 143 open NEURO tasks on the Pi (10,153 pairs):
//
//   1.000  "Prepare MyAudience vs iMail price comparisons (for Chris -> SLT)"
//          "Nick to prepare price comparisons between MyAudience and iMail..."
//   1.000  "Consult Annabelle for insights"
//          "Nick Ward will consult Annabelle, who is further ahead..., for insights"
//   1.000  "Continue phone-answering coaching; complete session with remaining..."
//          "Continue coaching on phone answering; complete the planned session..."
//   1.000  "Nick will consult with Annabelle, who is further ahead in this process"
//          "Nick Ward will consult Annabelle, who is further ahead..., for insights"
//   0.867  "Get support \"ring every ticket\" trial results from Zoe and evaluate"
//          "Chris/Nick to obtain support trial results from Zoe and evaluate..."
//   0.708  "Flight risks identified and mitigated"
//          "Flight risks identified and documented with action plans."
//   -- the gap --
//   0.584  "Career progression pathways defined by Day 45"          <- DIFFERENT
//          "Kayleigh Russell - career progression plans for DD team by Day 30"
//   0.533  "Provide timescales for LSL and EXP dashboards"          <- DIFFERENT
//          "Compile list of EXP/LSL dashboard users to grant access"
//
// INTERNAL_MIN_SCORE is 0.65, in that gap. It is NOT task-dedupe's 0.42, for the
// same reason `action-candidates.FOLD_SCORE` is not: 0.42 was measured on two
// INDEPENDENTLY WORDED lists (NEURO against Microsoft), and this corpus is the
// opposite — every row is Nick's own vocabulary, mostly extracted from his own
// meetings, so the stock words are shared almost completely and the floor has to
// sit higher. At 0.42 the list carries eight pairs that are plainly different
// jobs, which is the failure that matters: a screen of coincidences stops being
// read, and then the four real ones are lost too.
//
// Nothing here merges. Same rule as the Microsoft half: a wrong auto-merge hides
// a real task behind an unrelated one, silently, in the one place Nick goes to
// find out what he owes.

const INTERNAL_MIN_SCORE = 0.65;

/** Internal pairs are stored in the same rejection map as the Microsoft ones, so
 *  the key has to be unmistakable. Lowest id first, so a pair has ONE key however
 *  the two tasks are ordered when they are scored. */
function internalPairKey(aId, bId) {
  const [lo, hi] = [Number(aId), Number(bId)].sort((x, y) => x - y);
  return `task:${lo}::task:${hi}`;
}

/**
 * Rank duplicate pairs WITHIN the NEURO task list. PURE.
 *
 * tasks:     [{ id, text, due_date, source, origin_path, created_at, moscow, status }]
 * dismissed: the same Set `rankCandidates` takes — internal keys cannot collide
 *            with `${taskId}::${msId}` because they carry the `task:` prefix.
 *
 * Each pair is scored once, not twice: the IDF is built over the whole list, and
 * the upper triangle is walked so a pair cannot appear as both (a,b) and (b,a).
 * The OLDER task is presented as the one to keep — it is the row other things
 * may already point at (a focus session, a block, a Microsoft link) — but that is
 * a default for the screen to render, not a decision taken here.
 */
function rankInternalCandidates({ tasks = [], dismissed = new Set(), minScore = INTERNAL_MIN_SCORE } = {}) {
  const rows = tasks
    .map(t => ({ task: t, tokens: tokenize(t.text) }))
    .filter(t => t.tokens.size > 0);

  const idf = buildIdf(rows.map(r => r.tokens));

  const pairs = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (dismissed.has(internalPairKey(a.task.id, b.task.id))) continue;
      const scored = scorePair(a.tokens, b.tokens, idf);
      if (scored.score < minScore) continue;

      // Older first. A task that has been around is the one with history hanging
      // off it; dropping it in favour of a fresh capture of the same words loses
      // whatever was attached.
      const [keep, drop] = orderByAge(a.task, b.task);

      pairs.push({
        pairKey: internalPairKey(a.task.id, b.task.id),
        score: scored.score,
        confidence: scored.score >= STRONG_SCORE ? 'strong' : 'possible',
        matchedOn: scored.containment >= scored.jaccard ? 'containment' : 'overlap',
        sharedWords: distinctiveShared(scored.shared, idf),
        notes: internalPairNotes(keep, drop),
        keep: internalTaskView(keep),
        drop: internalTaskView(drop),
      });
    }
  }

  pairs.sort((x, y) => y.score - x.score || x.keep.id - y.keep.id);
  return pairs;
}

function orderByAge(a, b) {
  const at = a.created_at || '';
  const bt = b.created_at || '';
  if (at && bt && at !== bt) return at < bt ? [a, b] : [b, a];
  return a.id <= b.id ? [a, b] : [b, a];
}

function internalTaskView(t) {
  return {
    id: t.id,
    text: t.text,
    status: t.status || null,
    due_date: t.due_date || null,
    moscow: t.moscow || null,
    source: t.source || null,
    origin_path: t.origin_path || null,
    created_at: t.created_at || null,
    ms_id: t.ms_id || null,
  };
}

/** Facts about the pair beyond the words. None of them move the score — a due
 *  date agreeing is corroboration for Nick to read, not evidence. */
function internalPairNotes(keep, drop) {
  const notes = [];
  if (keep.due_date && drop.due_date) {
    notes.push(keep.due_date === drop.due_date
      ? `Same due date (${keep.due_date})`
      : `Due dates differ — #${keep.id} ${keep.due_date}, #${drop.id} ${drop.due_date}`);
  } else if (keep.due_date || drop.due_date) {
    const which = keep.due_date ? keep : drop;
    notes.push(`Only #${which.id} has a due date (${which.due_date})`);
  }
  if (keep.ms_id && drop.ms_id) {
    notes.push('Both are linked to Microsoft — unlink one before merging');
  } else if (keep.ms_id || drop.ms_id) {
    notes.push(`#${(keep.ms_id ? keep : drop).id} is linked to Microsoft`);
  }
  if (keep.moscow && drop.moscow && keep.moscow !== drop.moscow) {
    notes.push(`Rated differently — #${keep.id} ${keep.moscow}, #${drop.id} ${drop.moscow}`);
  }
  return notes;
}

/**
 * Score arbitrary texts against the open task list. PURE apart from the tasks
 * passed in.
 *
 * Added for VANTAGE, which needs to ask "does a task already exist for this
 * Support Review action?" before offering to create one. It is deliberately the
 * same tokeniser, IDF and scorer as rankCandidates rather than a second matcher
 * in the other codebase: two implementations of "are these the same job" would
 * disagree, and the disagreement would surface as VANTAGE creating a duplicate
 * of a task Planner already holds.
 *
 * Three differences from rankCandidates, all intentional:
 *
 * - **BOTH populations are searched.** This is the one that matters. The task
 *   store and the Microsoft mirror are separate lists joined only by the links
 *   below, and on 20 Aug 2026 there were no links at all: 163 tasks, zero with
 *   an `ms_id`, while eighteen live Planner items sat in the vault. Searching
 *   the task store alone answered "nothing exists for this action" for actions
 *   that were sitting on Mel's board with a due date on them. An absent link is
 *   not an absent task.
 * - Tasks ALREADY linked to Microsoft are still scored. rankCandidates excludes
 *   them because their question is answered; here a plan action mapping onto a
 *   task that is already merged with the board is the *best* possible answer,
 *   not a disqualified one.
 * - The IDF is built over every candidate and the queries together, so a word
 *   common to all of them ("review", "process") is correctly cheap.
 *
 * texts:    [{ id, text }] — id is the caller's, echoed back untouched.
 * tasks:    NEURO task rows.
 * msTasks:  the Microsoft mirror — [{ ms_id, text, due_date, source }].
 *
 * Each match carries `kind`, because what the caller does next differs: a
 * `neuro` match is linked to, a `microsoft` match has no NEURO task yet and one
 * has to be made and merged.
 */
function matchText({ texts = [], tasks = [], msTasks = [], minScore = MIN_SCORE, limit = 3 } = {}) {
  const queries = texts
    .map(q => ({ id: q.id, text: q.text, tokens: tokenize(q.text || '') }))
    .filter(q => q.tokens.size > 0);

  const linkedMs = new Set(tasks.map(t => t.ms_id).filter(Boolean));

  const candidates = [
    ...tasks.map(t => ({
      kind: 'neuro',
      key: `n${t.id}`,
      tokens: tokenize(t.text || ''),
      item: {
        id: t.id,
        text: t.text,
        status: t.status || null,
        due_date: t.due_date || null,
        moscow: t.moscow || null,
        source: t.source || null,
        origin_path: t.origin_path || null,
        ms_id: t.ms_id || null,
        ms_source: t.ms_source || null,
        ms_plan: t.ms_plan || null,
      },
    })),
    // A Microsoft line already merged into a task would otherwise be offered
    // twice, as itself and as the task — the same suppression the vault parser
    // does once a pair is linked.
    ...msTasks
      .filter(m => m.ms_id && !linkedMs.has(m.ms_id))
      .map(m => ({
        kind: 'microsoft',
        key: `m${m.ms_id}`,
        tokens: tokenize(m.text || ''),
        item: {
          ms_id: m.ms_id,
          text: m.text,
          due_date: m.due_date || null,
          ms_source: normaliseMsSource(m.source) || m.source || 'Microsoft',
          // Which board/list it is on, so the review screen names it too.
          ms_plan: m.msPlan || null,
        },
      })),
  ].filter(c => c.tokens.size > 0);

  const idf = buildIdf([...candidates.map(c => c.tokens), ...queries.map(q => q.tokens)]);

  return queries.map(q => {
    const scored = [];
    for (const c of candidates) {
      const s = scorePair(q.tokens, c.tokens, idf);
      if (s.score < minScore) continue;
      scored.push({
        score: s.score,
        confidence: s.score >= STRONG_SCORE ? 'strong' : 'possible',
        sharedWords: distinctiveShared(s.shared, idf),
        kind: c.kind,
        ...(c.kind === 'neuro' ? { task: c.item } : { ms: c.item }),
      });
    }
    // Ties break towards the NEURO task: it is the one that can simply be linked.
    scored.sort((a, b) => b.score - a.score
      || (a.kind === b.kind ? 0 : a.kind === 'neuro' ? -1 : 1));
    return { id: q.id, matches: scored.slice(0, limit) };
  });
}

// ── Stateful: what Nick has decided ──────────────────────────────────────────
//
// A confirmed link is `tasks.ms_id` — the column already existed and is what the
// vault parser and the completion push both read, so there is exactly one place
// that answers "is this linked". Only the REJECTIONS need somewhere to live, and
// they go in agent_state rather than a table: a rejection is a pair of ids and a
// date, nothing queries it by anything but the pair, and a schema migration on the
// live DB is a bigger risk than the query convenience is worth (same call as
// standup-session).
//
// Not remembering them is what would make this feature unusable: 2,544 pairs are
// scored every run, so a pair Nick has already rejected would come back every
// single time he opened the screen.

const DISMISS_KEY = 'task_ms_dismissed';

function loadDismissed() {
  try {
    const raw = db.getState(DISMISS_KEY);
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('[TaskDedupe] Could not read dismissals:', e.message);
    return {};
  }
}

function saveDismissed(map) {
  db.setState(DISMISS_KEY, JSON.stringify(map));
}

function dismissedKeySet() {
  return new Set(Object.keys(loadDismissed()));
}

/** Nick says these two are NOT the same task. Remembered so it is never asked again. */
function dismissPair(taskId, msId, reason = null) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || !msId) throw new Error('taskId and msId are required');
  const map = loadDismissed();
  map[pairKey(id, msId)] = { at: new Date().toISOString(), reason: reason || null };
  saveDismissed(map);
  return { ok: true, dismissed: pairKey(id, msId) };
}

function undismissPair(taskId, msId) {
  const map = loadDismissed();
  const key = pairKey(Number(taskId), msId);
  if (!(key in map)) return { ok: false, reason: 'not_dismissed' };
  delete map[key];
  saveDismissed(map);
  return { ok: true };
}

/**
 * Nick says these two ARE the same task.
 *
 * One NEURO row is what NEURO counts, ranks and completes; the Microsoft line
 * stops listing separately, and ticking the task pushes completion to Graph.
 * Nothing is deleted in Microsoft — the task stays there, and stays open until
 * it is actually finished.
 *
 * ── Which wording leads ─────────────────────────────────────────────────────
 *
 * `lead` decides whose WORDS the surviving row carries, and nothing else — both
 * records still exist, NEURO still owns the count and the completion push
 * either way. The default is `neuro`, which is the old behaviour and usually
 * right: the NEURO wording is the fuller one (*"Share the action plan planner
 * with the team once it is in a workable state"* against Planner's *"Communicate
 * the action plan to all teams"*). `microsoft` is for the other case — when the
 * board's wording is the one Nick's team is reading and the two should agree.
 *
 * ⚠ Adoption is a ONE-OFF COPY, not a subscription. Nothing re-applies it when
 * the Planner card is later renamed, and the card says so; storing a `lead`
 * flag that only something in the future would honour is a reader waiting for a
 * writer, which is how the Jira cache came to state a seven-week-old snapshot
 * as current fact.
 *
 * ⚠ Adoption NEVER blanks what NEURO already had. An absent Planner due date is
 * "the board does not track one", not "clear the date Nick set" — the two look
 * identical in a null and only one of them is a decision.
 *
 * ⚠ The link stands even when the adoption fails. `updateTask` refuses a text
 * that would collide with another task's dedupe key, and the pair being the
 * same task is a separate fact from whose wording won — throwing the link away
 * over a rename would make Nick answer the duplicate question twice.
 */
function linkPair(taskId, msId, msSource = null, msPlan = null, options = {}) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || !msId) throw new Error('taskId and msId are required');

  const row = db.getTaskRow(id);
  if (!row) return { ok: false, reason: 'task_not_found' };
  if (row.ms_id && row.ms_id !== msId) {
    return { ok: false, reason: 'already_linked', linkedTo: row.ms_id };
  }

  // One Microsoft task cannot back two NEURO tasks — the second link would hide a
  // real task behind a completion it never earned.
  const clash = db.listTaskRows({ status: 'all', includeDone: true })
    .find(t => t.ms_id === msId && t.id !== id);
  if (clash) return { ok: false, reason: 'ms_task_already_linked', linkedTo: clash.id };

  // ms_plan is display only — the board the Microsoft half sits on, so the card
  // can go on saying so once the Microsoft line stops listing separately. An
  // unknown plan is stored as null, never as the Microsoft source doubling for it.
  db.updateTaskRow(id, {
    ms_id: msId,
    ms_source: normaliseMsSource(msSource),
    ms_plan: (typeof msPlan === 'string' && msPlan.trim()) ? msPlan.trim() : null,
  });
  taskStore.scheduleExport();

  // A pair that has been linked should not also sit in the rejected pile.
  try { undismissPair(id, msId); } catch {}

  const lead = options.lead === 'microsoft' ? 'microsoft' : 'neuro';
  let adopted = null;
  if (lead === 'microsoft') {
    const msText = typeof options.msText === 'string' ? options.msText.trim() : '';
    if (!msText) {
      adopted = { ok: false, reason: 'no_microsoft_text' };
    } else {
      const fields = { text: msText };
      // Only where Microsoft actually has one — see the note above.
      if (options.msDue) fields.due_date = options.msDue;
      try {
        taskStore.updateTask(id, fields);
        adopted = { ok: true, text: msText, dueDate: fields.due_date || null };
      } catch (e) {
        adopted = { ok: false, reason: e.message };
      }
    }
  }

  return { ok: true, task: db.getTaskRow(id), lead, adopted };
}

function unlinkPair(taskId) {
  const id = Number(taskId);
  const row = db.getTaskRow(id);
  if (!row) return { ok: false, reason: 'task_not_found' };
  if (!row.ms_id) return { ok: false, reason: 'not_linked' };
  db.updateTaskRow(id, { ms_id: null, ms_source: null, ms_plan: null });
  taskStore.scheduleExport();
  return { ok: true, task: db.getTaskRow(id) };
}

/**
 * Nick says these two NEURO tasks are the same job.
 *
 * The kept row absorbs whatever the other one knew and the other is marked
 * `dropped` — a real status, reversible, and NOT a delete. Deleting would throw
 * away the wording that says why the duplicate existed, and this is a matcher
 * making a judgement, so it has to be possible to disagree with it afterwards.
 *
 * Filling blanks follows `createTask`'s rule exactly: a second sighting of the
 * same action is a chance to fill in what is missing, never to overwrite a
 * decision Nick has already made. So a due date or a MoSCoW rating on the dropped
 * row lands only where the kept row has none.
 *
 * It REFUSES rather than guessing in the one case that loses something: a dropped
 * row carrying a Microsoft link. Moving the link across would make the kept task
 * responsible for pushing completion to a board it was never matched against, and
 * silently — so the answer is "unlink it first, or merge the other way round".
 */
function mergeInternalPair(keepId, dropId) {
  const keep = Number(keepId);
  const drop = Number(dropId);
  if (!Number.isInteger(keep) || !Number.isInteger(drop)) throw new Error('keepId and dropId are required');
  if (keep === drop) return { ok: false, reason: 'same_task' };

  const keepRow = db.getTaskRow(keep);
  const dropRow = db.getTaskRow(drop);
  if (!keepRow) return { ok: false, reason: 'keep_not_found' };
  if (!dropRow) return { ok: false, reason: 'drop_not_found' };
  if (dropRow.status === 'dropped') return { ok: false, reason: 'already_dropped' };
  if (dropRow.status === 'done') return { ok: false, reason: 'drop_is_done' };
  if (dropRow.ms_id) return { ok: false, reason: 'drop_is_linked_to_microsoft', linkedTo: dropRow.ms_id };

  const patch = {};
  if (dropRow.due_date && !keepRow.due_date) patch.due_date = dropRow.due_date;
  if (dropRow.moscow && !keepRow.moscow) patch.moscow = dropRow.moscow;
  if (dropRow.priority && !keepRow.priority) patch.priority = dropRow.priority;
  if (dropRow.estimate_minutes && !keepRow.estimate_minutes) patch.estimate_minutes = dropRow.estimate_minutes;
  if (dropRow.origin_path && !keepRow.origin_path) {
    patch.origin_path = dropRow.origin_path;
    patch.origin_line = dropRow.origin_line == null ? null : dropRow.origin_line;
  }
  if (Object.keys(patch).length) db.updateTaskRow(keep, patch);

  db.updateTaskRow(drop, { status: 'dropped' });

  // The record is what makes this reversible AND what keeps the other wording
  // readable — the whole reason for folding rather than deleting is that the
  // second sighting said something, and it should not vanish with the row.
  const merges = loadMerges();
  merges[String(drop)] = {
    keptId: keep,
    droppedText: dropRow.text,
    keptText: keepRow.text,
    filled: Object.keys(patch),
    at: new Date().toISOString(),
  };
  saveMerges(merges);

  // A merged pair should not also sit in the rejected pile.
  try { undismissInternalPair(keep, drop); } catch {}

  taskStore.scheduleExport();
  return { ok: true, keep: db.getTaskRow(keep), dropped: db.getTaskRow(drop), filled: Object.keys(patch) };
}

/** The way back. Reopens the dropped task and forgets the merge — it does NOT
 *  undo the blanks that were filled on the kept row, because those may have been
 *  edited since and a blind revert would overwrite a decision. */
function unmergeInternalPair(dropId) {
  const drop = Number(dropId);
  const merges = loadMerges();
  const record = merges[String(drop)];
  if (!record) return { ok: false, reason: 'not_merged' };

  const row = db.getTaskRow(drop);
  if (!row) return { ok: false, reason: 'drop_not_found' };
  if (row.status === 'dropped') db.updateTaskRow(drop, { status: 'open' });

  delete merges[String(drop)];
  saveMerges(merges);
  taskStore.scheduleExport();
  return { ok: true, task: db.getTaskRow(drop), wasMergedInto: record.keptId };
}

const MERGE_KEY = 'task_internal_merges';

function loadMerges() {
  try {
    const raw = db.getState(MERGE_KEY);
    if (!raw) return {};
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('[TaskDedupe] Could not read merges:', e.message);
    return {};
  }
}

function saveMerges(map) {
  db.setState(MERGE_KEY, JSON.stringify(map));
}

/** Every merge, for the review screen's "already merged" list and its undo. */
function listMerges() {
  const merges = loadMerges();
  return Object.entries(merges).map(([droppedId, record]) => ({
    droppedId: Number(droppedId),
    keptId: record.keptId,
    droppedText: record.droppedText || null,
    keptText: record.keptText || null,
    filled: record.filled || [],
    at: record.at || null,
  })).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/** Nick says these two NEURO tasks are NOT the same. Remembered in the same map
 *  as the Microsoft rejections — the `task:` prefix keeps them apart. */
function dismissInternalPair(aId, bId, reason = null) {
  const a = Number(aId);
  const b = Number(bId);
  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new Error('both task ids are required');
  if (a === b) throw new Error('a task cannot be a duplicate of itself');
  const map = loadDismissed();
  map[internalPairKey(a, b)] = { at: new Date().toISOString(), reason: reason || null };
  saveDismissed(map);
  return { ok: true, dismissed: internalPairKey(a, b) };
}

function undismissInternalPair(aId, bId) {
  const map = loadDismissed();
  const key = internalPairKey(Number(aId), Number(bId));
  if (!(key in map)) return { ok: false, reason: 'not_dismissed' };
  delete map[key];
  saveDismissed(map);
  return { ok: true };
}

/** 'MS Planner' / 'MS ToDo' from the vault section heading, kept as a hint for the
 *  completion push. Without it completeMicrosoftTask tries Planner first and pays a
 *  wasted Graph read on every To Do task. Unknown stays null rather than guessing —
 *  the fallback handles null correctly and a wrong hint sends it to the wrong API. */
function normaliseMsSource(source) {
  if (!source) return null;
  if (/planner/i.test(source)) return 'MS Planner';
  if (/to-?do/i.test(source)) return 'MS ToDo';
  return null;
}

/** Every confirmed link, for the review screen's "already linked" list. */
function listLinks() {
  return db.listTaskRows({ status: 'all', includeDone: true })
    .filter(t => t.ms_id)
    .map(t => ({
      taskId: t.id,
      text: t.text,
      status: t.status,
      ms_id: t.ms_id,
      ms_source: t.ms_source || null,
      ms_plan: t.ms_plan || null,
    }));
}

/** The set of Microsoft ids NEURO now owns — what the vault parser suppresses. */
/**
 * Which NEURO task each linked Microsoft id belongs to.
 *
 * `linkedMsIds` answers "should this line be suppressed"; this answers "and
 * whose row swallowed it", which is what lets the surviving card go on naming
 * the Microsoft half it now stands for. Read once per parse, like the Set.
 */
function linkedMsMap() {
  const map = new Map();
  try {
    for (const row of db.listTaskRows({ status: 'all', includeDone: true })) {
      if (row.ms_id) map.set(row.ms_id, row.id);
    }
  } catch (e) {
    console.error('[TaskDedupe] Could not read links:', e.message);
  }
  return map;
}

function linkedMsIds() {
  const ids = new Set();
  try {
    for (const row of db.listTaskRows({ status: 'all', includeDone: true })) {
      if (row.ms_id) ids.add(row.ms_id);
    }
  } catch (e) {
    // Suppression failing open shows a task twice, which is the bug this feature
    // exists to fix but is strictly better than hiding one.
    console.error('[TaskDedupe] Could not read links:', e.message);
  }
  return ids;
}

/**
 * The best equivalent of `text` among `others`, or null. PURE — no DB, no clock.
 *
 * The text-against-text case, which `matchText` does not cover: that one scores
 * queries against task ROWS and returns their ids, and the caller here has no
 * rows, only strings that may or may not already be saying the same thing.
 *
 * This exists for the capture_todo flood. Plaud writes several summary variants
 * of one recording, `action-candidates` extracts from each note independently,
 * and its only dedupe is `getSaraActionsBySource` — scoped to ONE note by
 * design, so fourteen notes describing one meeting produce fourteen copies of
 * every commitment in it. Measured on the live queue: 258 pending, 54 distinct.
 *
 * Reuses `scorePair`/`tokenize`/`buildIdf` rather than growing a second matcher,
 * so the threshold that was measured against Nick's corpus is the threshold that
 * applies here too. The IDF is built over the whole set including the query, so
 * his stock vocabulary ("review", "ticket", "process") stays correctly cheap —
 * which is the entire reason a plain overlap would not do this job.
 */
function findEquivalent(text, others = [], { minScore = MIN_SCORE } = {}) {
  const aTokens = tokenize(text || '');
  if (!aTokens.size) return null;

  const otherTokens = others.map(o => tokenize(o || ''));
  const idf = buildIdf([aTokens, ...otherTokens]);

  let best = null;
  for (let i = 0; i < otherTokens.length; i++) {
    if (!otherTokens[i].size) continue;
    const result = scorePair(aTokens, otherTokens[i], idf);
    if (result.score < minScore) continue;
    if (!best || result.score > best.score) {
      best = {
        index: i,
        score: result.score,
        containment: result.containment,
        jaccard: result.jaccard,
        shared: distinctiveShared(result.shared, idf),
      };
    }
  }
  return best;
}

module.exports = {
  MIN_SCORE,
  INTERNAL_MIN_SCORE,
  STRONG_SCORE,
  buildIdf,
  findEquivalent,
  dismissInternalPair,
  dismissPair,
  dismissedKeySet,
  internalPairKey,
  linkPair,
  linkedMsIds,
  linkedMsMap,
  listLinks,
  listMerges,
  mergeInternalPair,
  matchText,
  normaliseMsSource,
  pairKey,
  rankCandidates,
  rankInternalCandidates,
  scorePair,
  tokenize,
  undismissInternalPair,
  undismissPair,
  unlinkPair,
  unmergeInternalPair,
};
