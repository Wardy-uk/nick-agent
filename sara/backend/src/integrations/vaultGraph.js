// Vault cognition-graph bridge — bounded, read-only seam into NEURO's real vault graph.
//
// Builds the REAL backbone of Nick's second brain around his active context: it expands
// /api/vault/related + /api/vault/backlinks from a handful of seed notes (today's daily note,
// recent captures), and pulls real /api/knowledge-gaps for the void wells. This is the live
// substrate + uncertainty the Cognitive Convergence Graph renders.
//
// It makes NO decisions and owns NO shared state — it polls, caches, and exposes a snapshot.
// Stays honest when the upstream is absent/unauthenticated (available:false, empty graph).

const neuroConfig = require('./neuroConfig');
const neuro = require('./neuroSnapshot');

// ⚠ No default base URL — this module was the fourth copy of a hardcoded
// `https://nuero.nickward.co.uk`, and it was the one that kept POLLING it every 90
// seconds on a SARA with no NEURO configured at all. See neuroConfig.js.
function config(env = process.env) {
  return {
    baseUrl: neuroConfig.getBaseUrl(env),
    pin: neuroConfig.getPin(env),
    vaultKey: String(env.NEURO_VAULT_KEY || ''), // /api/vault/* needs X-Api-Key (not the PIN)
    timeoutMs: Number(env.SARA_NEURO_TIMEOUT_MS) || 6000,
    pollMs: Number(env.SARA_GRAPH_POLL_MS) || 90000,
    seeds: Number(env.SARA_GRAPH_SEEDS) || 4,
  };
}

function baseName(p) {
  return String(p || '').split('/').pop().replace(/\.md$/i, '');
}
function shorten(s, n = 24) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  return v.length > n ? `${v.slice(0, n - 1)}…` : v;
}

async function fetchJson(cfg, path) {
  const headers = { Accept: 'application/json' };
  if (cfg.pin) headers['x-neuro-pin'] = cfg.pin;
  // /api/vault/* is gated by an API key, not the PIN.
  if (cfg.vaultKey && path.startsWith('/api/vault')) headers['X-Api-Key'] = cfg.vaultKey;
  const res = await fetch(new URL(path, `${cfg.baseUrl}/`).toString(), {
    headers,
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
  return res.json();
}

let snapshot = { available: false, polledAt: null, nodes: [], edges: [], gaps: [] };

function getGraph() {
  return snapshot;
}

// Seed notes for the backbone expansion — the notes Nick is actively touching.
function seedPaths(cfg) {
  const data = neuro.getSnapshot().data || {};
  const seeds = new Set();
  if (data.context?.dailyNote?.path) seeds.add(data.context.dailyNote.path);
  for (const item of data.capture?.items || []) if (item.relativePath) seeds.add(item.relativePath);
  return [...seeds].slice(0, cfg.seeds);
}

async function refresh() {
  const cfg = config();
  if (!cfg.baseUrl) { return snapshot; }

  const nodes = new Map();
  const edges = [];
  const addNode = (p, name, k = 'note') => { if (!p) return; if (!nodes.has(p)) nodes.set(p, { id: p, label: shorten(name || baseName(p), 16), k }); };

  // Real knowledge gaps → void wells (single cheap call; gated by the PIN).
  let gaps = [];
  try {
    const g = await fetchJson(cfg, '/api/knowledge-gaps?daysBack=120');
    const items = g.suggestions || g.gaps || g.items || g.results || (Array.isArray(g) ? g : []);
    const seen = new Set();
    for (const x of items) {
      const topic = String(x.topic || x.title || x.label || x.gap || x.question || '').trim();
      if (!topic || topic.length < 4 || seen.has(topic.toLowerCase())) continue;
      seen.add(topic.toLowerCase());
      gaps.push({ id: `gap:${gaps.length}`, label: shorten(topic, 18) });
      if (gaps.length >= 4) break;
    }
  } catch { /* honest: no gaps when unreachable */ }

  // Real backbone — expand related + backlinks from the active seed notes. Vault routes need
  // the API key; without it we keep the PIN-only model (anchors + reasoning + gaps) honest.
  const seeds = cfg.vaultKey ? seedPaths(cfg) : [];
  for (const s of seeds) {
    addNode(s, null, 'note');
    try {
      const r = await fetchJson(cfg, `/api/vault/related?path=${encodeURIComponent(s)}&limit=6`);
      for (const rel of r.related || []) { addNode(rel.path, rel.title || rel.name, 'note'); edges.push([s, rel.path]); }
    } catch { /* skip seed */ }
    try {
      const b = await fetchJson(cfg, `/api/vault/backlinks?path=${encodeURIComponent(s)}`);
      for (const bl of b.backlinks || []) { addNode(bl.path, bl.name, 'note'); edges.push([bl.path, s]); }
    } catch { /* skip seed */ }
  }

  snapshot = {
    available: nodes.size > 0 || gaps.length > 0,
    polledAt: new Date().toISOString(),
    nodes: [...nodes.values()].slice(0, 220),
    edges: edges.filter(([a, b]) => nodes.has(a) && nodes.has(b)).slice(0, 440),
    gaps,
  };
  return snapshot;
}

let timer = null;
function start() {
  if (timer) return true;
  const cfg = config();
  // Idle rather than poll a host we were never told about. It also keeps the log
  // honest: a line saying we are polling NEURO when nothing is configured is how the
  // implicit dependency stayed invisible.
  if (!neuroConfig.readiness().ready) {
    console.log('[SARA NEURO] vault cognition-graph idle — NEURO connection is not configured.');
    return false;
  }
  refresh().catch(() => {});
  timer = setInterval(() => refresh().catch(() => {}), cfg.pollMs);
  if (timer.unref) timer.unref();
  console.log(`[SARA NEURO] vault cognition-graph polling every ${cfg.pollMs}ms against ${cfg.baseUrl}`);
  return true;
}
function stop() { if (timer) clearInterval(timer); timer = null; }

module.exports = { getGraph, refresh, start, stop, config };
