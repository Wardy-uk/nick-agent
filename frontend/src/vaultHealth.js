/**
 * What to say above a set of vault search results. PURE — no React, no fetch.
 *
 * Split out for the same reason `pi-health.assess()` and `context-state` are:
 * the judgement is the product, and it has to be assertable without mounting a
 * component. The rule it encodes is NEURO's oldest one, applied to search —
 * ⚠ **an incomplete search is never proof that nothing exists.** A degraded
 * index, a capped walk, an unreadable vault and a genuinely empty folder all
 * render as the same short list, and only the last of them is evidence.
 *
 * Three states have to stay apart, because conflating them is how a broken
 * search starts lying:
 *   - `error`    — the request itself failed. NOT an empty result.
 *   - `incomplete` — it answered, but from part of what it should have read.
 *   - complete   — it read everything it meant to. Say nothing.
 *
 * "Part of what it should have read" covers three independent failures that all
 * produce the same short list: the embeddings provider being down, the vault
 * walk being capped, and — the quietest — the semantic INDEX not holding the
 * whole vault while the provider answers perfectly.
 *
 * The last one matters as much as the others: a permanent warning above every
 * search is one nobody reads by week two.
 */

/** The sentence an empty-but-incomplete result must carry. Verbatim, by contract. */
export const EMPTY_INCOMPLETE_LINE =
  'No matches found in the available search results. This is not confirmation that the vault contains nothing.';

/**
 * @param {object} input
 * @param {object|null} input.health   the `health` block from /api/vault/search
 * @param {Array|null}  input.results  the results array (null = no search run)
 * @param {string|null} input.error    a request-level failure message
 * @param {string}      input.scope    the folder the search was scoped to, if any
 * @returns {{state:'error'|'incomplete'|'ok', banner:object|null, emptyLine:string|null, scopeLabel:string|null}}
 */
export function assessSearchHealth({ health = null, results = null, error = null, scope = '' } = {}) {
  const scopeLabel = scope ? `in ${scope}/` : null;

  // A failed request must never render as an authoritative empty result — that
  // is the same species as reporting a dead sensor as a quiet one.
  if (error) {
    return {
      state: 'error',
      banner: {
        tone: 'error',
        title: 'Search did not run',
        detail: `${error}. Nothing below is a statement about the vault.`,
      },
      emptyLine: 'The search could not be run, so there is nothing to show — this is not an empty vault.',
      scopeLabel,
    };
  }

  const reasons = [];
  if (health && health.semanticAvailable === false) {
    reasons.push('Semantic search was unavailable, so this is keyword matching only.');
  }

  // ⚠ A coverage gap is not the same failure as a dead provider, and it is the
  // quieter one: semantic search answers perfectly, from an index that does not
  // hold your whole vault. Said in the same breath, because the result set is
  // indistinguishable.
  if (health && health.semanticCoverageComplete === false) {
    const detail = (health.semanticCoverageReasons || []).filter(Boolean).join('; ');
    reasons.push(
      detail
        ? `The semantic index does not cover the whole vault — ${detail}.`
        : 'The semantic index does not cover the whole vault.'
    );
  }
  for (const r of (health && health.truncationReasons) || []) {
    reasons.push(`Part of the vault was not searched — ${r}.`);
  }
  if (health && health.truncated && reasons.length === 0) {
    reasons.push('Part of the vault was not searched.');
  }

  const partial = ((health && health.incomplete) || []).length;
  if (partial > 0) {
    reasons.push(
      partial === 1
        ? '1 note below is only partly indexed — its tail was not searched.'
        : `${partial} notes below are only partly indexed — their tails were not searched.`
    );
  }

  if (reasons.length === 0) {
    // Complete. Neutral, and silent — no reassurance banner.
    return { state: 'ok', banner: null, emptyLine: 'No matches', scopeLabel };
  }

  return {
    state: 'incomplete',
    banner: {
      // Neutral, not alarming: nothing is broken for the user to fix, the
      // answer is simply narrower than it looks.
      tone: 'warn',
      title: 'This search saw only part of the vault',
      detail: reasons.join(' '),
    },
    emptyLine: EMPTY_INCOMPLETE_LINE,
    scopeLabel,
  };
}
