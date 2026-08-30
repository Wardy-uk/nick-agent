// SARA capture bridge — the write seam back into the canonical brain.
//
// SARA's frontend has always POSTed to /api/capture/note and /api/capture/todo, and
// sara/backend never mounted them: every capture made at the kiosk 404'd. This is the
// forwarder that closes that hole, and the shape of it is the point:
//
//   * SARA stores NOTHING. There is no SARA capture table, no queue, no local copy.
//     A capture is a NEURO capture or it is not a capture. NEURO owns the note file
//     and the tasks row, and its own routes already run the vault hooks, the activity
//     tracking and the task-store dedupe that make a capture real.
//   * A capture is reported saved ONLY when NEURO acknowledged it. Every other
//     outcome — unconfigured, refused, unreachable, upstream error — comes back
//     `saved: false` with a reason a human can act on. There is deliberately no
//     retry queue here (Phase 1 non-goal): SARA says it did not save, and the words
//     stay on the screen so Nick can save them somewhere that works.
//   * Nothing logs a PIN, a token, or the captured text. The text is Nick's; the
//     credential is a credential. Logs carry the kind, the outcome and the reason.
//
// CommonJS only — matches the NEURO backend convention (no ESM).

const neuroConfig = require('./neuroConfig');

const DEFAULT_TIMEOUT_MS = 8000;

// The bounded set of captures SARA is allowed to forward. A kind not in this table
// is refused locally rather than proxied — this is a named bridge to two known NEURO
// routes, not an open proxy into the brain.
const KINDS = {
  note: {
    path: '/api/capture/note',
    /** @returns {{body: object}|{error: string}} */
    build(input) {
      const content = String(input?.content ?? input?.text ?? '').trim();
      if (!content) return { error: 'content is required' };
      const title = String(input?.title || '').trim();
      return { body: { content, ...(title ? { title } : {}) } };
    },
  },
  todo: {
    path: '/api/capture/todo',
    build(input) {
      const text = String(input?.text ?? input?.content ?? '').trim();
      if (!text) return { error: 'text is required' };
      return {
        body: {
          text,
          // NEURO's task-store takes these; passing them through keeps SARA a
          // transport rather than a place where a capture loses its detail.
          ...(input.priority ? { priority: input.priority } : {}),
          ...(input.moscow ? { moscow: input.moscow } : {}),
          ...(input.due ? { due: input.due } : {}),
          // Provenance NEURO can see. `source` is a real column on tasks.
          source: String(input.source || 'sara-capture'),
        },
      };
    },
  },
};

/** The HTTP status SARA answers its own UI with, per failure reason. */
const STATUS_FOR_REASON = {
  'unsupported-kind': 400,
  invalid: 400,
  'not-configured': 503,
  unauthorized: 502,
  rejected: 400, // overridden by the upstream status where it is a sane 4xx
  unreachable: 504,
  timeout: 504,
  'upstream-error': 502,
};

function result(fields) {
  return {
    ok: false,
    saved: false,
    reason: null,
    detail: null,
    status: 500,
    upstream: null,
    ...fields,
  };
}

function buildUrl(baseUrl, path) {
  return new URL(path.startsWith('/') ? path : `/${path}`, `${baseUrl}/`).toString();
}

/**
 * Forward one capture to NEURO.
 *
 * @param {'note'|'todo'} kind
 * @param {object} input the request body from the SARA UI
 * @param {object} [options] `{ env, fetchImpl, timeoutMs, signal }` — injected for tests
 * @returns {Promise<{ok:boolean, saved:boolean, reason:?string, detail:?string, status:number, upstream:?object}>}
 */
async function forward(kind, input, options = {}) {
  const env = options.env || process.env;
  const doFetch = options.fetchImpl || globalThis.fetch;
  const spec = KINDS[kind];

  if (!spec) {
    return result({
      reason: 'unsupported-kind',
      detail: `SARA does not forward "${kind}" captures.`,
      status: STATUS_FOR_REASON['unsupported-kind'],
    });
  }

  const built = spec.build(input || {});
  if (built.error) {
    return result({ reason: 'invalid', detail: built.error, status: STATUS_FOR_REASON.invalid });
  }

  // Refuse BEFORE the network. An unconfigured bridge must never look like a
  // transient outage — the fix is different and the message should say so.
  const readiness = neuroConfig.readiness(env);
  if (!readiness.ready) {
    return result({
      reason: 'not-configured',
      detail: readiness.problems.join(' '),
      status: STATUS_FOR_REASON['not-configured'],
    });
  }

  const url = buildUrl(readiness.baseUrl, spec.path);
  const timeoutMs = Number(options.timeoutMs) || Number(env.SARA_NEURO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  let res;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...neuroConfig.authHeaders(env),
      },
      body: JSON.stringify(built.body),
      signal: options.signal || AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return result({
      reason: timedOut ? 'timeout' : 'unreachable',
      detail: timedOut
        ? `NEURO did not answer within ${timeoutMs}ms.`
        : `Could not reach NEURO — ${error?.message || 'network error'}.`,
      status: timedOut ? STATUS_FOR_REASON.timeout : STATUS_FOR_REASON.unreachable,
    });
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (res.status === 401 || res.status === 403) {
    return result({
      reason: 'unauthorized',
      detail: 'NEURO rejected SARA\'s credential. Check NEURO_API_TOKEN / NEURO_PIN.',
      status: STATUS_FOR_REASON.unauthorized,
      upstream: { status: res.status },
    });
  }

  if (!res.ok) {
    const clientFault = res.status >= 400 && res.status < 500;
    return result({
      reason: clientFault ? 'rejected' : 'upstream-error',
      detail: payload?.error || `NEURO answered HTTP ${res.status}.`,
      status: clientFault ? res.status : STATUS_FOR_REASON['upstream-error'],
      upstream: { status: res.status, body: payload },
    });
  }

  // A 200 is necessary but not sufficient. NEURO's capture routes answer
  // `{ success: true, ... }`; anything else on a 200 is not an acknowledgement, and
  // claiming a save on it is exactly the lie this bridge exists to avoid.
  const acknowledged = payload?.success === true || payload?.ok === true;
  if (!acknowledged) {
    return result({
      reason: 'upstream-error',
      detail: payload?.error || 'NEURO answered without acknowledging the capture.',
      status: STATUS_FOR_REASON['upstream-error'],
      upstream: { status: res.status, body: payload },
    });
  }

  return {
    ok: true,
    saved: true,
    reason: null,
    detail: null,
    status: 200,
    upstream: { status: res.status, body: payload },
  };
}

module.exports = { forward, buildUrl, KINDS, STATUS_FOR_REASON, DEFAULT_TIMEOUT_MS };
