import { useEffect, useMemo, useRef, useState } from 'react';
import { useSaraState } from '../../state/saraState';
import './CognitionEnvironment.css';

// Cognition Environment — SARA's primary surface. See MANIFESTATION.md (canonical spec).
//
// The centre is a dense vault SUBSTRATE (Nick's second brain + operational state + memory):
// hundreds–thousands of mostly-unlabelled nodes, near-static, extending beyond the canvas.
// SARA is NOT nodes — she is an INFERENCE FIELD acting on that substrate: pulses, edge
// illumination, transient bridges, local distortion that sweep through the graph. The feeling
// is "SARA is thinking through the graph," not "the graph is moving."

const IDLE_MS = 45000;
const TEXT_DELAY = 1200;

function canArmIntervention() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

const FALLBACK = {
  mode: 'Focused', cognitiveLoad: 'Moderate', pressureTrend: 'Building',
  focus: { title: 'Prepare for Willem probation review', why: 'High impact. Time sensitive. Shapes team momentum.', urgency: 4, confidence: 82, nextStep: 'Review notes and open points' },
  signals: [{ label: '2 SLA breaches', risk: 'High' }, { label: 'Kim waiting on reply', risk: 'Medium' }, { label: '3 commits due today', risk: 'Low' }],
};

function deriveCognition(model, focusAssist) {
  const queue = model?.domains?.queue;
  const focus = model?.domains?.focus?.current;
  const nova = model?.nova?.eyesOn;
  const nextAction = focusAssist?.nextAction;
  const breaching = queue?.breaching || 0;
  const open = queue?.open || 0;
  const novaItems = nova?.items?.length || 0;
  const overdue = nova?.stats?.customersOverdue || 0;
  const pending = nova?.stats?.approvalsPending || 0;
  const urgentEmails = model?.presentation?.email?.urgentCount || 0;
  const replyEmails = model?.presentation?.email?.replyCount || 0;

  let mode = 'Focused';
  if (breaching > 0 || overdue > 0) mode = 'Firefighting';
  else if (open > 8 || novaItems > 3) mode = 'Reactive';
  const loadScore = breaching * 2 + novaItems + (open > 6 ? 1 : 0);
  const cognitiveLoad = loadScore >= 5 ? 'High' : loadScore >= 2 ? 'Moderate' : 'Low';
  let pressureTrend = 'Stable';
  if (breaching >= 3 || overdue >= 20) pressureTrend = 'Critical';
  else if (breaching > 0 || overdue > 0 || novaItems > 0) pressureTrend = 'Building';
  const confidence = Math.round(((model?.confidence?.score ?? 0.82)) * 100);
  const urgency = breaching >= 3 ? 5 : breaching > 0 ? 4 : novaItems > 2 ? 3 : 2;

  const signals = [];
  if (breaching > 0) signals.push({ label: `${breaching} SLA ${breaching === 1 ? 'breach' : 'breaches'}`, risk: 'High' });
  if (pending > 0) signals.push({ label: `${pending} approval${pending === 1 ? '' : 's'} waiting`, risk: 'Medium' });
  if (urgentEmails > 0 && signals.length < 3) signals.push({ label: `${urgentEmails} urgent email${urgentEmails === 1 ? '' : 's'}`, risk: 'High' });
  if (overdue > 0 && signals.length < 3) signals.push({ label: `${overdue} overdue customer${overdue === 1 ? '' : 's'}`, risk: overdue >= 20 ? 'High' : 'Medium' });
  const slip = model?.domains?.people?.members?.find((m) => m.status === 'slipping');
  if (slip && signals.length < 3) signals.push({ label: `${slip.name} is slipping`, risk: 'Medium' });
  const todos = model?.presentation?.todos?.items?.length || 0;
  if (todos > 0 && signals.length < 3) signals.push({ label: `${todos} commitment${todos === 1 ? '' : 's'} due today`, risk: 'Low' });
  if (replyEmails > 0 && signals.length < 3) signals.push({ label: `${replyEmails} email${replyEmails === 1 ? '' : 's'} need reply`, risk: 'Low' });

  return {
    mode, cognitiveLoad, pressureTrend,
    focus: {
      title: focus?.title || 'Pick the highest-leverage thing and start',
      why: focus?.reason || 'SARA is using fallback focus context.',
      urgency, confidence,
      nextStep: nextAction?.label || (focus?.reason ? 'Review notes and open points' : 'Name the first concrete step'),
    },
    signals: signals.length ? signals : FALLBACK.signals,
  };
}

const ICON = {
  focus: 'M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0 M12 3v3 M12 18v3 M3 12h3 M18 12h3',
  context: 'M4 7l8-4 8 4-8 4-8-4z M4 7v10l8 4 8-4V7 M4 12l8 4 8-4',
  calendar: 'M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z M4 9h16 M8 3v4 M16 3v4',
  systems: 'M6 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M18 6m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M12 18m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M7.5 7.5l3 3 M16.5 7.5l-3 3 M12 13v3',
  memory: 'M12 3a4 4 0 0 1 4 4 3 3 0 0 1 1 5.8 3 3 0 0 1-5 2.2 3 3 0 0 1-5-2.2A3 3 0 0 1 8 7a4 4 0 0 1 4-4z M12 3v15',
  you: 'M12 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M5 20a7 7 0 0 1 14 0',
  capture: 'M12 5v14 M5 12h14',
  ask: 'M12 4a8 8 0 0 1 0 16h-6l-2 2v-6a8 8 0 0 1 8-12z M9 11h6 M9 8h6',
  plan: 'M5 4h14v16H5z M8 9h8 M8 13h8 M8 17h5',
  review: 'M12 6c-5 0-8 6-8 6s3 6 8 6 8-6 8-6-3-6-8-6z M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0',
};
function Icon({ name, size = 20 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[name]} />
    </svg>
  );
}

const NAV = [
  { id: 'cognition', target: 'cognition', icon: 'focus', label: 'Focus', sub: 'One thing that matters' },
  { id: 'context', target: 'mission-control', icon: 'context', label: 'Context', sub: "What's shaping this" },
  { id: 'calendar', target: 'standup', icon: 'calendar', label: 'Calendar', sub: "What's coming" },
  { id: 'systems', target: 'at-work', icon: 'systems', label: 'Systems', sub: 'Everything in sync' },
  { id: 'memory', target: 'vault', icon: 'memory', label: 'Memory', sub: 'What we know' },
  { id: 'you', target: 'settings', icon: 'you', label: 'You', sub: 'Your state' },
];

const STATES = [
  { id: 'dormant', label: 'Dormant', glyph: '·' },
  { id: 'withyou', label: 'With you', glyph: '~' },
  { id: 'listening', label: 'Listening', glyph: '◎' },
  { id: 'thinking', label: 'Thinking', glyph: '◌' },
  { id: 'challenging', label: 'Challenging', glyph: '◈' },
  { id: 'reassuring', label: 'Reassuring', glyph: '◍' },
];

function toneFor(kind, value) {
  const v = String(value).toLowerCase();
  if (kind === 'mode') return v === 'focused' ? 'calm' : v === 'firefighting' ? 'alert' : 'warn';
  if (kind === 'load') return v === 'low' ? 'calm' : v === 'moderate' ? 'warn' : 'alert';
  if (kind === 'pressure') return v === 'stable' ? 'calm' : v === 'building' ? 'warn' : 'alert';
  if (kind === 'risk') return v === 'high' ? 'alert' : v === 'medium' ? 'warn' : 'dim';
  return 'dim';
}

// --- Graph data ---------------------------------------------------------------
const shorten = (s, n = 22) => { const v = String(s || '').replace(/\s+/g, ' ').trim(); return v.length > n ? `${v.slice(0, n - 1)}…` : v; };
function hashPos(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  const a = ((h >>> 0) % 1000) / 1000, b = ((h >>> 10) % 1000) / 1000;
  return { ax: (a - 0.5) * 1.5, ay: (b - 0.5) * 1.4 };
}
function withAnchors(g) { [...g.mem, ...g.reason, ...(g.voids || [])].forEach((o) => { const p = hashPos(o.id); o.ax = p.ax; o.ay = p.ay; }); return g; }

const FALLBACK_GRAPH = withAnchors({
  mem: [
    { id: 'nova', label: 'NOVA', k: 'project' }, { id: 'nurtur', label: 'Nurtur', k: 'project' },
    { id: 'kpi', label: 'KPI engine', k: 'project' }, { id: 'lead', label: 'Leadership', k: 'theme' },
    { id: 'ember', label: 'Ember', k: 'truth' }, { id: 'shub', label: 'Service Hub', k: 'project' },
  ],
  reason: [
    { id: 'r1', label: 'avoidance ↔ overload', k: 'hot' },
    { id: 'r2', label: 'hidden blocker in KPI trust', k: 'ghost' },
    { id: 'r3', label: 'Damon: perception vs execution', k: 'ghost' },
    { id: 'r4', label: 'probation call = today’s lever', k: 'hot' },
  ],
  voids: [{ id: 'void1', label: 'missing — Willem 1:1' }],
});

function buildGraph(model) {
  if (!model) return FALLBACK_GRAPH;
  const mem = [], reason = [], voids = [], byId = {};
  const addMem = (id, label, k) => { const l = shorten(label, 16); if (!l || byId[id]) return; const o = { id, label: l, k }; mem.push(o); byId[id] = o; };

  const people = model.domains?.people?.members || [];
  people.slice(0, 5).forEach((p) => addMem(`p:${p.name}`, p.name, 'person'));
  if (model.domains?.queue) addMem('queue', 'Queue', 'project');
  const fc = model.domains?.focus?.current;
  if (fc) addMem('focus', fc.title, 'project');
  (model.domains?.vault?.picks || []).slice(0, 3).forEach((v, i) => addMem(`vp:${i}`, v.title || 'note', 'note'));
  if (mem.length < 3) { addMem('nova', 'NOVA', 'project'); addMem('nurtur', 'Nurtur', 'project'); addMem('lead', 'Leadership', 'theme'); }

  (model.inference?.reasons || []).slice(0, 3).forEach((r, i) => reason.push({ id: `ir:${i}`, label: shorten(r, 30), k: 'ghost' }));
  (model.nova?.eyesOn?.items || []).slice(0, 2).forEach((it, i) => reason.push({ id: `nv:${i}`, label: shorten(it.title, 28), k: 'hot' }));
  people.filter((p) => p.status && p.status !== 'solid').slice(0, 2).forEach((p) => reason.push({ id: `pf:${p.name}`, label: shorten(p.flag, 28), k: 'ghost' }));
  if (fc?.reason) reason.push({ id: 'fr', label: shorten(fc.reason, 30), k: 'hot' });
  if (!reason.length) FALLBACK_GRAPH.reason.forEach((x) => reason.push({ ...x }));

  if (model.confidence?.level === 'low') voids.push({ id: 'void:conf', label: `uncertain — ${shorten(model.confidence.rationale || 'low confidence', 18)}` });
  else if (!fc && model.inference?.recommendedView === null) voids.push({ id: 'void:focus', label: 'unclear focus' });

  return withAnchors({ mem, reason, voids });
}

// Merge model anchors with the live vault backbone (real related/backlinks + gaps). The
// reasoning artefacts become INFERENCE THOUGHTS (not nodes) acting on the substrate.
function buildMergedGraph(model, real) {
  const base = buildGraph(model);
  const substrate = base.mem.map((m) => ({ ...m, anchor: true })); // model anchors = active region
  const byId = {}; substrate.forEach((s) => { byId[s.id] = true; });
  const edges = [];
  const r = real && real.available ? real : null;
  if (r) {
    for (const n of (r.nodes || []).slice(0, 200)) { const id = `n:${n.id}`; if (!byId[id]) { substrate.push({ id, label: n.label, k: 'note' }); byId[id] = true; } }
    for (const e of r.edges || []) { const a = `n:${e[0]}`, b = `n:${e[1]}`; if (byId[a] && byId[b]) edges.push([a, b]); }
  }
  const voids = r && r.gaps && r.gaps.length ? r.gaps.map((g) => ({ id: g.id, label: g.label })) : base.voids;
  withAnchors({ mem: substrate, reason: base.reason, voids });
  return { substrate, edges, reason: base.reason, voids, real: !!r };
}

// MIDGROUND — the stable, always-labelled domain hubs: the recognizable skeleton of Nick's
// second brain that is always present between the latent background substrate and the hot
// foreground. These are the major Maps-of-Content / life-and-work domains. Edit to match the
// real vault top-level structure (kept here as the canonical scaffold; ~20–100 labels target).
const MIDGROUND_HUBS = [
  'Leadership', 'NOVA', 'Service Hub', 'AI', 'Ember', 'Peaks', 'Nurtur', 'Jira',
  'Team', 'Knowledge', 'Automation', 'Health', 'Family', 'Finance', 'Strava', 'Calendar',
  'Standups', 'People', 'Projects', 'Vault',
];

// Inference-field behaviour per state. active=concurrent thoughts, gap=ms between them,
// litR=illumination radius (×spread), pulse=intensity, tempo=attention speed, bridges=max
// transient bridges, distort=local pull(+)/push(−) on illuminated nodes.
// `sub` = substrate visibility (compression of the irrelevant; lower = more dimmed when she
// reasons). `region` = sustained active-region glow strength.
const INFER = {
  dormant:     { active: 0, gap: 99999, litR: 0.0, pulse: 0.0, tempo: 0.03, bridges: 0, distort: 0, sub: 1.0, region: 0.15 },
  withyou:     { active: 1, gap: 3600, litR: 0.20, pulse: 0.5, tempo: 0.05, bridges: 2, distort: 0.2, sub: 0.9, region: 0.5 },
  listening:   { active: 1, gap: 2800, litR: 0.22, pulse: 0.6, tempo: 0.06, bridges: 3, distort: 0.25, sub: 0.82, region: 0.6 },
  thinking:    { active: 3, gap: 1400, litR: 0.26, pulse: 0.95, tempo: 0.09, bridges: 4, distort: 0.4, sub: 0.6, region: 0.9 },
  challenging: { active: 3, gap: 850, litR: 0.22, pulse: 1.0, tempo: 0.14, bridges: 3, distort: -0.5, sub: 0.6, region: 0.85 },
  reassuring:  { active: 2, gap: 2600, litR: 0.24, pulse: 0.6, tempo: 0.045, bridges: 3, distort: 0.25, sub: 0.82, region: 0.7 },
};

// ANIMATION GRAMMAR — five cognitive modes, each with a distinct motion behaviour so the user can
// answer "what is SARA doing?" from motion alone. Pipeline: signals → classifyMode → MODE → behaviour.
//   regions  = how many active concept regions
//   dof      = how hard the rest of the graph is suppressed (focus-pull)
//   agitate  = active region jitters MORE (pressure conflict) instead of stilling
//   flicker  = signals rapidly reactivate (competing hotspots)
//   converge = activation region contracts inward over its life (searching → gathering)
//   bridge   = light the existing-substrate corridor between two regions (relationship found)
//   restJit  = multiplier on the ambient background jitter
const MODE = {
  idle:         { regions: 0, dof: 0.0,  agitate: false, flicker: 0, converge: 0, bridge: false, restJit: 1.0 },
  recall:       { regions: 1, dof: 0.45, agitate: false, flicker: 0, converge: 1, bridge: false, restJit: 1.0 },
  correlation:  { regions: 2, dof: 0.5,  agitate: false, flicker: 0, converge: 0, bridge: true,  restJit: 1.0 },
  firefighting: { regions: 3, dof: 0.28, agitate: true,  flicker: 1, converge: 0, bridge: false, restJit: 1.3 },
  focus:        { regions: 1, dof: 0.88, agitate: false, flicker: 0, converge: 0, bridge: false, restJit: 0.85 },
};

// Cognitive event classifier: real model/state → animation mode.
function classifyMode(cog, dataCog) {
  if (!cog) return 'idle';
  if (cog.mode === 'Firefighting' || cog.pressureTrend === 'Critical') return 'firefighting'; // multiple urgent signals
  if (dataCog === 'challenging') return 'firefighting';
  if (dataCog === 'dormant') return 'idle';
  if (dataCog === 'listening') return 'recall';      // taking in / retrieving
  if (dataCog === 'thinking') return 'correlation';  // relating concepts
  if (dataCog === 'reassuring') return 'focus';
  if (cog.focus && cog.focus.title && cog.pressureTrend !== 'Stable') return 'focus';
  return 'idle';
}

// Live cognitive signatures derived from the real model + state — SARA legible without an object.
function cognitiveSignature(cog, state, model) {
  const conf = model?.confidence?.level;
  const pressure = cog.pressureTrend;
  if (state === 'dormant') return 'Substrate at rest';
  if (state === 'challenging') return pressure === 'Critical' ? 'Escalation risk increasing' : 'Conflict in evidence';
  if (state === 'thinking') return conf === 'high' ? 'Converging' : 'Resolving ambiguity';
  if (state === 'reassuring') return 'Pressure redistribution';
  if (state === 'listening') return conf === 'low' ? 'Awaiting stronger evidence' : 'Weak signal detected';
  if (conf === 'low') return 'Awaiting stronger evidence';
  if (pressure === 'Critical') return 'Pressure redistribution';
  if (pressure === 'Building') return 'Confidence rising';
  return 'Holding context';
}

export default function CognitionEnvironment() {
  const { model, focusAssist, currentView, setCurrentView, runQuickAction } = useSaraState();
  const cog = useMemo(() => (model ? deriveCognition(model, focusAssist) : FALLBACK), [focusAssist, model]);

  const [cogState, setCogState] = useState('withyou');
  const [intervening, setIntervening] = useState(false);
  const [ivTextReady, setIvTextReady] = useState(false);
  const [realGraph, setRealGraph] = useState(null);

  const canvasRef = useRef(null);
  const cogRef = useRef('withyou');
  const graphRef = useRef(null);
  const confRef = useRef(0.6); // model confidence (0..1) → drives instability in the field
  confRef.current = model?.confidence?.score ?? 0.6;
  const modeRef = useRef('idle'); // current animation mode (set below once dataCog is known)
  const graph = useMemo(() => buildMergedGraph(model, realGraph), [model, realGraph]);
  graphRef.current = graph;

  useEffect(() => {
    let timer;
    const clear = () => {
      clearTimeout(timer);
      timer = null;
    };
    const arm = () => {
      clear();
      if (!intervening && canArmIntervention()) {
        timer = setTimeout(() => {
          if (canArmIntervention()) setIntervening(true);
        }, IDLE_MS);
      }
    };
    const onActivity = () => {
      if (intervening) return;
      arm();
    };
    const onVisibility = () => {
      if (!canArmIntervention()) {
        clear();
        setIntervening(false);
        setIvTextReady(false);
        return;
      }
      arm();
    };
    const events = ['pointerdown', 'touchstart', 'keydown', 'mousemove', 'wheel', 'click', 'focus'];
    events.forEach((eventName) => window.addEventListener(eventName, onActivity, { passive: true }));
    window.addEventListener('blur', onVisibility);
    window.addEventListener('focus', onVisibility);
    document.addEventListener('visibilitychange', onVisibility);
    arm();
    return () => {
      clear();
      events.forEach((eventName) => window.removeEventListener(eventName, onActivity));
      window.removeEventListener('blur', onVisibility);
      window.removeEventListener('focus', onVisibility);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervening]);

  useEffect(() => {
    if (!intervening) { setIvTextReady(false); return undefined; }
    const id = setTimeout(() => setIvTextReady(true), TEXT_DELAY);
    return () => clearTimeout(id);
  }, [intervening]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/cognition/graph');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setRealGraph(data);
      } catch { /* keep fallback */ }
    };
    load();
    const id = setInterval(load, 60000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Inference field over a dense, near-static substrate. The substrate (nodes + dim edges) is
  // drawn ONCE to an offscreen layer and blitted each frame; only SARA's inference (pulses,
  // illumination, bridges, distortion) animates on top — so motion reads as thought.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let W = 0, H = 0, cx = 0, cy = 0, spread = 0;
    let lastW = -1, lastH = -1; // last built dimensions — rebuild only when these actually change
    let massR = 0;     // radius of the memory mass (Layer 1) — fills the viewport, clamped inside
    let clusterR = 0;  // radius of the active cluster (Layer 2) — compact, ~32% of min dimension
    let maxEdge2 = 0;  // (max edge length)² — no edge longer than 15% of the viewport diagonal
    const CLOUD_N = 9500; // ONE continuous substrate, density-field sampled — dense local topology so
    // relationships emerge from density shifts, not explicit edges. Rendered per-frame (carries entropy).
    const clampX = (x) => Math.max(8, Math.min(W - 8, x));
    const clampY = (y) => Math.max(8, Math.min(H - 8, y));

    const off = document.createElement('canvas');
    const offctx = off.getContext('2d');
    let cloud = [];     // {x,y,r} synthetic vault mass (stable)
    let cloudSE = [];   // cloud kNN edges (indices into cloud)
    let S = [];         // full substrate: cloud + real backbone
    let SE = [];        // all edges (indices into S)
    let anchorIdx = []; // S indices of the active-region anchors (focus, people, projects)
    let hubIdx = [];    // S indices of MIDGROUND domain hubs (always-labelled stable scaffold)
    let labelIdx = [];  // S indices that carry a persistent label (hubs + real anchors)
    let backboneKey = '';

    // DETERMINISTIC seeded RNG (mulberry32). Reset before each build so the graph is IDENTICAL every
    // time it is generated — no per-frame regeneration / flicker even if buildCloud is re-invoked.
    let rngState = 0x9e3779b9 >>> 0;
    const seedRng = (s) => { rngState = s >>> 0; };
    const rnd = (a, b) => {
      rngState = (rngState + 0x6D2B79F5) | 0;
      let tt = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
      tt = (tt + Math.imul(tt ^ (tt >>> 7), 61 | tt)) ^ tt;
      const r = ((tt ^ (tt >>> 14)) >>> 0) / 4294967296;
      return a + r * (b - a);
    };
    // cheap smooth directional noise → curl-like warp that turns blobs into filaments
    const warp = (x, y) => ({
      x: Math.sin(y * 3.3 + 1.7) * 0.05 + Math.sin(y * 7.1 - 0.4) * 0.022,
      y: Math.cos(x * 2.9 - 0.9) * 0.05 + Math.cos(x * 6.3 + 1.1) * 0.022,
    });
    let act = new Float32Array(0); // per-node activation this frame (0 = dim, >0 = lit)

    function buildCloud() {
      cloud = [];
      seedRng(0x5A4A); // deterministic → identical graph every build (no flicker on re-generate)
      // ONE CONTINUOUS SUBSTRATE. Nodes are sampled from a smooth CLUSTERED PROBABILITY FIELD —
      // density varies organically (dense regions + sparse connective tissue + a base everywhere so
      // it is never islands). Semantic labels do NOT spawn nodes; they later attach to dense regions
      // of THIS graph. No per-concept blobs.
      // density field = broad overlapping anisotropic gaussians + a base level.
      const cn = 9 + Math.floor(rnd(0, 5));
      const dc = [];
      for (let k = 0; k < cn; k++) dc.push({ x: cx + rnd(-0.85, 0.85) * massR, y: cy + rnd(-0.8, 0.8) * massR, sx: rnd(0.16, 0.42) * massR, sy: rnd(0.10, 0.34) * massR, rot: rnd(0, Math.PI), amp: rnd(0.5, 1.5) });
      const BASE = 0.10; // density everywhere → continuous field, never empty islands
      const density = (x, y) => {
        let f = BASE;
        for (const c of dc) { const dx = x - c.x, dy = y - c.y, ca = Math.cos(c.rot), sa = Math.sin(c.rot); const u = (dx * ca + dy * sa) / c.sx, v = (-dx * sa + dy * ca) / c.sy; f += c.amp * Math.exp(-(u * u + v * v) * 0.5); }
        return f;
      };
      // sample via a coarse density grid + CDF (guarantees N nodes, no rejection waste)
      const GW = 80, GH = 50;
      const x0 = cx - massR * 1.05, x1 = cx + massR * 1.05, y0 = cy - massR, y1 = cy + massR;
      const dw = (x1 - x0) / GW, dh = (y1 - y0) / GH;
      const cdf = new Float64Array(GW * GH); let acc = 0;
      for (let gyi = 0; gyi < GH; gyi++) for (let gxi = 0; gxi < GW; gxi++) { acc += density(x0 + (gxi + 0.5) * dw, y0 + (gyi + 0.5) * dh); cdf[gyi * GW + gxi] = acc; }
      for (let i = 0; i < CLOUD_N; i++) {
        const r = rnd(0, acc);
        let lo = 0, hi = GW * GH - 1; while (lo < hi) { const mid = (lo + hi) >> 1; if (cdf[mid] < r) lo = mid + 1; else hi = mid; }
        const gxi = lo % GW, gyi = (lo / GW) | 0;
        let x = x0 + (gxi + rnd(0, 1)) * dw, y = y0 + (gyi + rnd(0, 1)) * dh;
        const wp = warp((x - cx) / massR, (y - cy) / massR); x += wp.x * massR * 0.08; y += wp.y * massR * 0.08; // organic warp
        cloud.push({ x: clampX(x), y: clampY(y), d: 0 });
      }

      // ---- grid-based 5-NN, intra-cluster dense; HARD length cap (no long edges) ----
      const N = cloud.length;
      const cs = Math.max(6, (2 * massR) / Math.sqrt(N) * 2.0);
      const cols = Math.max(1, Math.ceil(W / cs)), rows = Math.max(1, Math.ceil(H / cs));
      const gx = (p) => Math.min(cols - 1, Math.max(0, Math.floor(p.x / cs)));
      const gy = (p) => Math.min(rows - 1, Math.max(0, Math.floor(p.y / cs)));
      const cells = new Array(cols * rows);
      for (let i = 0; i < N; i++) { const c = gy(cloud[i]) * cols + gx(cloud[i]); (cells[c] || (cells[c] = [])).push(i); }
      // per-node local density (3×3 cell occupancy) — semantic labels later attach to the densest nodes
      for (let i = 0; i < N; i++) {
        const cgx = gx(cloud[i]), cgy = gy(cloud[i]); let cnt = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) { const nx = cgx + ox, ny = cgy + oy; if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue; const b = cells[ny * cols + nx]; if (b) cnt += b.length; }
        cloud[i].d = cnt;
      }
      const cap = Math.min(maxEdge2, (cs * 2.6) * (cs * 2.6)); // never longer than 15% diagonal
      cloudSE = [];
      // streaming top-5 NN (no per-node allocation / sort → scales to dense clusters at 18k+)
      const nn = new Int32Array(5), dd = new Float64Array(5);
      for (let i = 0; i < N; i++) {
        const a = cloud[i], cgx = gx(a), cgy = gy(a);
        nn[0] = nn[1] = nn[2] = nn[3] = nn[4] = -1;
        dd[0] = dd[1] = dd[2] = dd[3] = dd[4] = Infinity;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const nx = cgx + ox, ny = cgy + oy; if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const bucket = cells[ny * cols + nx]; if (!bucket) continue;
          for (let bi = 0; bi < bucket.length; bi++) {
            const j = bucket[bi]; if (j === i) continue;
            const b = cloud[j]; const dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
            if (d >= cap || d >= dd[4]) continue;
            let p = 4; while (p > 0 && dd[p - 1] > d) { dd[p] = dd[p - 1]; nn[p] = nn[p - 1]; p--; }
            dd[p] = d; nn[p] = j;
          }
        }
        for (let k = 0; k < 5; k++) { const j = nn[k]; if (j > i) cloudSE.push([i, j]); } // j>i dedups
      }
    }

    function buildSubstrate() {
      const g = graphRef.current || { substrate: [], edges: [] };
      // ONE substrate: the cloud IS the graph. No extra nodes are spawned for labels.
      S = cloud.map((c) => ({ x: c.x, y: c.y, k: 'cloud', label: null }));
      SE = cloudSE.slice();
      anchorIdx = []; hubIdx = [];

      // Semantic labels ATTACH to existing dense nodes (emerge from density, don't generate it).
      // Pick the densest nodes, spatially spread, and decorate them — midground hubs first, then
      // the real model anchors (people / projects / focus). These do NOT add particles.
      const realAnchors = (g.substrate || []).filter((n) => n.anchor && n.label).map((n) => n.label);
      const order = cloud.map((c, i) => i).sort((a, b) => cloud[b].d - cloud[a].d);
      const minSpace2 = (massR * 0.12) * (massR * 0.12);
      const chosen = [];
      const pickSpread = (count, assign) => {
        let got = 0;
        for (let oi = 0; oi < order.length && got < count; oi++) {
          const i = order[oi]; if (S[i].label) continue;
          const n = S[i]; let ok = true;
          for (let ci = 0; ci < chosen.length; ci++) { const m = S[chosen[ci]]; const dx = m.x - n.x, dy = m.y - n.y; if (dx * dx + dy * dy < minSpace2) { ok = false; break; } }
          if (!ok) continue;
          chosen.push(i); assign(i, got); got++;
        }
      };
      pickSpread(MIDGROUND_HUBS.length, (i, k) => { S[i].label = MIDGROUND_HUBS[k]; S[i].hub = true; hubIdx.push(i); });
      pickSpread(realAnchors.length, (i, k) => { S[i].label = realAnchors[k]; S[i].anchor = true; anchorIdx.push(i); });
      labelIdx = hubIdx.concat(anchorIdx);

      act = new Float32Array(S.length);
      renderOffscreen();
      backboneKey = `${g.substrate.length}:${(g.edges || []).length}`;
    }

    // Layer 1 = MEMORY SUBSTRATE — rendered ONCE to an offscreen layer that is blitted each frame.
    // The whole resting graph (edges + nodes) is STATIC → zero flicker. Activation is drawn per-frame
    // ON TOP, only in the small active region. (Per-frame jitter of the whole field caused the boil.)
    function renderOffscreen() {
      off.width = canvas.width; off.height = canvas.height;
      offctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      offctx.clearRect(0, 0, W, H);
      offctx.globalCompositeOperation = 'source-over';
      // faint latent edge lattice
      offctx.lineWidth = 0.4; offctx.strokeStyle = 'rgba(120,152,198,0.015)';
      offctx.beginPath();
      for (const e of SE) { const a = S[e[0]], b = S[e[1]]; offctx.moveTo(a.x, a.y); offctx.lineTo(b.x, b.y); }
      offctx.stroke();
      // background nodes — tiny, dim (the diffuse noisy-looking memory; static, no motion)
      offctx.fillStyle = 'rgba(150,180,216,0.16)';
      for (const n of S) { if (!n.hub && !n.anchor) offctx.fillRect(n.x - 0.5, n.y - 0.5, 1, 1); }
      // midground hubs + anchors — slightly larger/brighter
      for (const n of S) {
        if (!n.hub && !n.anchor) continue;
        offctx.fillStyle = n.hub ? 'rgba(198,222,238,0.5)' : 'rgba(184,212,234,0.42)';
        offctx.beginPath(); offctx.arc(n.x, n.y, n.hub ? 2.0 : 1.5, 0, 6.28); offctx.fill();
      }
    }

    function size() {
      const r = canvas.parentElement.getBoundingClientRect();
      const nw = Math.round(r.width), nh = Math.round(r.height);
      // guard: a 0-size / collapsed canvas would make massR=0 → grid degenerates; skip until real dims.
      if (!(nw > 40 && nh > 40)) return;
      // build ONCE per actual dimension change — a spurious ResizeObserver tick must NOT regenerate
      // the graph every frame (that was the strobe). Same size → no rebuild.
      if (nw === lastW && nh === lastH) return;
      lastW = nw; lastH = nh;
      W = r.width; H = r.height;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const gapL = 294, gapR = W - 402;
      // centre the field in the clear space between the panels, but stay near the visual middle
      const mid = (gapL + gapR) / 2;
      cx = (gapR - gapL > 120) ? Math.min(Math.max(mid, W * 0.36), W * 0.6) : W * 0.5;
      cy = H * 0.46;
      const minDim = Math.min(W, H);
      massR = minDim * 0.42;     // memory mass fills the viewport (clamped to stay inside)
      clusterR = minDim * 0.16;  // active cluster ≈ 32% of the min dimension — compact, central
      const diag = Math.hypot(W, H); maxEdge2 = (diag * 0.15) * (diag * 0.15); // 15%-diagonal edge cap
      spread = massR;            // legacy alias retained for any remaining references
      buildCloud();
      buildSubstrate();
    }

    // Inference: thoughts (from real reasoning) sweep the substrate, each anchored to a focal
    // node, illuminating its neighbourhood, bridging surfaced concepts, and emitting a pulse.
    const focalCache = {};
    function focalFor(reason) {
      if (focalCache[reason.id] != null) return focalCache[reason.id];
      const words = String(reason.label || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
      let best = -1;
      for (let i = 0; i < S.length; i++) {
        if (!S[i].label) continue;
        const ll = S[i].label.toLowerCase();
        if (words.some((w) => ll.includes(w))) { best = i; break; }
      }
      if (best < 0) { const p = hashPos(reason.id); best = Math.floor(((p.ax + 0.75) / 1.5) * S.length) % S.length; }
      focalCache[reason.id] = best;
      return best;
    }


    let active = [];
    let nextIdx = 0;
    let lastSpawn = 0;
    let subVeil = 1;     // current substrate compression (eased toward inf.sub)
    let focus = 0;       // eased depth-of-field 0→1 (mode-driven; smooth, never per-thought)
    let touched = [];    // node indices activated this frame (so we can clear act[] cheaply)
    let raf = 0, last = performance.now(), t = 0;

    function frame(now) {
      let dt = (now - last) / 16.667; last = now; if (dt > 3) dt = 3; if (dt < 0.2) dt = 0.2;
      t += dt * 0.016;
      const inf = INFER[cogRef.current] || INFER.withyou;
      const g = graphRef.current || { substrate: [], edges: [], reason: [], voids: [] };
      if (`${g.substrate.length}:${(g.edges || []).length}` !== backboneKey) {
        buildSubstrate();
        // node indices changed — drop in-flight thoughts/paths + the focal cache to avoid stale refs
        active.length = 0; touched.length = 0; for (const k in focalCache) delete focalCache[k];
      }

      const reasons = g.reason || [];
      // spawn thoughts up to the state's concurrency
      if (reasons.length && active.length < inf.active && now - lastSpawn > inf.gap) {
        for (let k = 0; k < reasons.length; k++) {
          const idx = (nextIdx + k) % reasons.length;
          const r = reasons[idx];
          if (active.some((a) => a.rid === r.id)) continue;
          const focal = focalFor(r);
          active.push({ rid: r.id, label: r.label, hot: r.k === 'hot', focal, ix: cx, iy: cy, start: now, dur: 4200 + Math.random() * 2200 });
          nextIdx = idx + 1; lastSpawn = now; break;
        }
      }
      active = active.filter((a) => now - a.start < a.dur);

      // ---- draw ----
      // ANIMATION MODE drives behaviour (signals → classifier → mode → motion). Depth-of-field is the
      // mode's `dof`; the rest of the grammar is applied in the activation field below.
      const md = MODE[modeRef.current] || MODE.idle;
      // Mode params interpolate (~600–1000ms) so mode CHANGES are smooth and the global dim does NOT
      // pulse with individual thoughts spawning/expiring (that was a strobe source).
      focus += (md.dof - focus) * 0.025 * dt;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const subTarget = inf.sub == null ? 1 : inf.sub;
      subVeil += (subTarget - subVeil) * 0.04 * dt;
      ctx.globalAlpha = Math.max(0.45, subVeil * (1 - 0.45 * focus)); // out-of-focus substrate recedes
      ctx.drawImage(off, 0, 0);
      ctx.globalAlpha = 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // confidence instability: low confidence → the field is unsettled (0 = stable, 1 = unsure)
      const instab = Math.min(1, Math.max(0, 1 - confRef.current));

      // centroid of what SARA is reasoning about right now (active focals) — used to gate void labels
      let fcx = 0, fcy = 0, fcn = 0;
      for (const a of active) { const f = S[a.focal]; if (f) { fcx += f.x; fcy += f.y; fcn++; } }
      const hasFocus = fcn > 0; if (hasFocus) { fcx /= fcn; fcy /= fcn; }

      // void wells — negative space over the substrate (soft dark thinning, no hard ring).
      // Low confidence makes the voids "pressure" — they breathe slightly.
      const voids = g.voids || [];
      for (let vi = 0; vi < voids.length; vi++) {
        const v = voids[vi];
        const press = 1 + instab * 0.22 * Math.sin(t * 1.7 + vi * 1.3); // void pressure pulse
        const vx = clampX(cx + (v.ax / 0.78) * massR * 0.85), vy = clampY(cy + (v.ay / 0.73) * massR * 0.85), R = clusterR * 0.42 * press;
        // a void is an ABSENCE — a soft dark thinning of the substrate, no hard ring / radius line
        const dg = ctx.createRadialGradient(vx, vy, 0, vx, vy, R * 1.7);
        dg.addColorStop(0, `rgba(7,10,15,${(0.44 + instab * 0.14).toFixed(3)})`);   // softened (−~25%)
        dg.addColorStop(0.7, `rgba(7,10,15,${(0.18 + instab * 0.08).toFixed(3)})`);
        dg.addColorStop(1, 'rgba(7,10,15,0)');
        ctx.fillStyle = dg; ctx.beginPath(); ctx.arc(vx, vy, R * 1.7, 0, 6.28); ctx.fill();
        ctx.save();
        // label a void only when it's near what SARA is reasoning about (else it's felt, not read)
        if (hasFocus) {
          const ddx = vx - fcx, ddy = vy - fcy;
          if (ddx * ddx + ddy * ddy < (clusterR * 1.8) * (clusterR * 1.8)) {
            ctx.font = '10px Inter, system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(224,180,110,0.5)';
            ctx.fillText(v.label, vx, vy + R + 13);
          }
        }
        ctx.restore();
      }

      ctx.textAlign = 'center';
      const labels = []; // {x,y,text,a,hot}

      // ====================================================================================
      // ENTROPY REDUCTION. SARA does NOT move, draw lines, or add objects. The resting substrate is
      // noisy (every node has ambient jitter). When she attends a concept she imposes ORDER on the
      // surrounding region: jitter falls, the cluster condenses slightly, structure clarifies. Chaos
      // becomes ordered; meaning crystallises from noise. No paths, no edges, no travelling anything.
      // ====================================================================================
      for (let k = 0; k < touched.length; k++) act[touched[k]] = 0;
      touched.length = 0;

      // ACTIVATION FIELD — shaped by the animation MODE. Each signal is a soft metabolic region that
      // AMPLIFIES the existing substrate (fMRI / phosphor). The mode controls how many regions, their
      // radius behaviour (recall = converge inward), reactivation (firefighting = flicker), and whether
      // a corridor of existing substrate lights between two regions (correlation = bridge).
      const signals = [];
      for (const a of active) {
        if (signals.length >= md.regions) break;
        const f = S[a.focal]; if (!f) continue;
        const p = Math.min(1, Math.max(0, (now - a.start) / a.dur));
        let env = Math.sin(p * 3.14159265);
        if (md.flicker) env *= 0.78 + 0.22 * Math.sin(now * 0.005 + a.start * 0.5); // gentle unrest (not a strobe)
        const sigR = md.converge ? clusterR * (1.75 - 0.95 * p) : clusterR * 1.25;          // recall contracts inward
        signals.push({ x: f.x, y: f.y, env, R: sigR });
        labels.push({ x: f.x, y: f.y - 11, text: a.label, a: env * 0.9, hot: a.hot });
      }
      // CORRELATION bridge — sample the corridor between two regions; the EXISTING substrate along it
      // activates (no drawn line). The relationship is revealed through real tissue lighting up.
      const allSig = signals.slice();
      if (md.bridge && signals.length >= 2) {
        const A = signals[0], B = signals[1], be = Math.min(A.env, B.env) * 0.75;
        for (let s = 1; s < 10; s++) { const tt = s / 10; allSig.push({ x: A.x + (B.x - A.x) * tt, y: A.y + (B.y - A.y) * tt, env: be, R: clusterR * 0.5 }); }
      }
      for (let i = 0; i < S.length; i++) {
        let aMax = 0;
        for (const sig of allSig) { const dx = S[i].x - sig.x, dy = S[i].y - sig.y, d2 = dx * dx + dy * dy; const R2 = sig.R * sig.R; if (d2 < R2) { const g = sig.env * Math.exp(-d2 / (2 * (sig.R * 0.5) * (sig.R * 0.5))); if (g > aMax) aMax = g; } }
        if (aMax > 0.01) { act[i] = aMax; touched.push(i); }
      }

      // 1) SIGNAL BLOOM — subtle additive Gaussian per region (metabolic glow, not a disc).
      ctx.globalCompositeOperation = 'lighter';
      for (const sig of allSig) {
        const bg = ctx.createRadialGradient(sig.x, sig.y, 0, sig.x, sig.y, sig.R);
        bg.addColorStop(0, `rgba(120,180,205,${(0.07 * sig.env).toFixed(3)})`);
        bg.addColorStop(0.5, `rgba(110,168,196,${(0.025 * sig.env).toFixed(3)})`);
        bg.addColorStop(1, 'rgba(110,168,196,0)');
        ctx.fillStyle = bg; ctx.beginPath(); ctx.arc(sig.x, sig.y, sig.R, 0, 6.28); ctx.fill();
      }
      // 2) EDGE DENSITY GLOW — only EXISTING substrate edges between activated nodes; soft, additive.
      ctx.lineWidth = 1.1;
      for (const e of SE) {
        const ea = act[e[0]], eb = act[e[1]]; if (ea <= 0 || eb <= 0) continue;
        const m = Math.min(ea, eb); const al = Math.min(0.08, 0.1 * m); if (al < 0.012) continue;
        const A = S[e[0]], B = S[e[1]];
        ctx.strokeStyle = `rgba(150,202,216,${al.toFixed(3)})`;
        ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';

      // 3) ACTIVE-REGION OVERLAY — amplify ONLY the activated nodes, drawn OVER the static substrate.
      // The background never moves (it is the offscreen blit) → no boil / no flicker. In calm modes
      // active nodes are still (just brighter); FIREFIGHTING adds localised agitation to them only.
      const reson = 0.88 + 0.12 * Math.sin(t * 2.4); // gentle synchronised resonance on active nodes
      for (let k = 0; k < touched.length; k++) {
        const i = touched[k], n = S[i];
        const c = Math.min(1, act[i] * 1.5); if (c < 0.05) continue;
        let px = n.x, py = n.y;
        if (md.agitate) { const j = 1.2 * c; px += Math.sin(t * 2.3 + i) * j; py += Math.cos(t * 2.0 + i) * j; } // firefighting only (unsettled, not strobe)
        const labeled = n.hub || n.anchor;
        const al = Math.min(0.85, (0.5 * c + (labeled ? 0.18 : 0)) * reson);
        ctx.fillStyle = labeled ? 'rgba(206,230,242,' + al.toFixed(3) + ')' : 'rgba(188,216,232,' + al.toFixed(3) + ')';
        if (labeled) { const r = (n.hub ? 2.2 : 1.6) + c * 0.8; ctx.beginPath(); ctx.arc(px, py, r, 0, 6.28); ctx.fill(); }
        else { const r = 1.2 + c * 0.9; ctx.fillRect(px - r / 2, py - r / 2, r, r); }
      }

      // LAYER 1/2 LABELS — depth-of-field: resting (out-of-focus) labels RECEDE as SARA attends, while
      // labels she is attending brighten STRONGLY and become fully readable.
      ctx.globalCompositeOperation = 'source-over';
      ctx.textAlign = 'center';
      for (const i of labelIdx) {
        const n = S[i]; if (!n.label) continue;
        const lit = act[i] || 0;
        const base = (n.hub ? 0.42 : 0.26) * (1 - 0.55 * focus);                    // defocus the periphery
        const a = Math.min(0.98, base + lit * 0.85);                                // in-cone labels pop
        if (a < 0.04) continue;
        ctx.font = `${(n.hub ? 11 : 9.5) + (lit > 0.4 ? 1 : 0)}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = `rgba(${lit > 0.3 ? '214,236,242' : n.hub ? '206,222,236' : '178,202,222'},${a.toFixed(3)})`;
        ctx.fillText(n.label, n.x, n.y - (n.hub ? 9 : 7));
      }

      // FOREGROUND labels — active hot concepts (crisp, few)
      for (const l of labels) {
        if (l.a < 0.06) continue;
        ctx.font = `${l.hot ? 12 : 10.5}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = `rgba(${l.hot ? '198,238,240' : '170,210,214'},${Math.min(0.95, l.a).toFixed(3)})`;
        ctx.fillText(l.text, l.x, l.y);
      }

      canvas.__ceRaf = raf = requestAnimationFrame(frame);
    }

    // single rAF: cancel any loop left over from a previous (uncleaned) mount before starting a new one
    if (canvas.__ceRaf) cancelAnimationFrame(canvas.__ceRaf);
    const ro = new ResizeObserver(size); ro.observe(canvas.parentElement);
    const onVis = () => { if (!document.hidden) last = performance.now(); };
    document.addEventListener('visibilitychange', onVis);
    size();
    canvas.__ceRaf = raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); canvas.__ceRaf = 0; ro.disconnect(); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const dataCog = intervening ? 'challenging' : cogState;
  cogRef.current = dataCog;
  modeRef.current = classifyMode(cog, dataCog); // signals → classifier → animation mode
  const active = STATES.find((s) => s.id === dataCog) || STATES[1];
  const signature = cognitiveSignature(cog, dataCog, model); // live cognitive signature

  const pick = (id) => { setIntervening(false); setCogState(id); };
  const closeIntervention = () => { setIntervening(false); setCogState('withyou'); };

  return (
    <div className="ce" data-cog={dataCog} data-intervening={intervening ? 'true' : 'false'}>
      <div className="ce-atmos" aria-hidden="true" />
      <div className="ce-wash" aria-hidden="true" />
      <canvas ref={canvasRef} className="ce-field" aria-hidden="true" />

      <div className="ce-shell">
        <div className="ce-body">
          <aside className="ce-sidebar">
            <div className="ce-brand">
              <div className="ce-brand__name">SARA</div>
              <div className="ce-brand__sub">Cognition Environment</div>
            </div>
            <nav className="ce-nav">
              {NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`ce-nav__item${currentView === item.target ? ' ce-nav__item--active' : ''}`}
                  onClick={() => setCurrentView(item.target)}
                >
                  <span className="ce-nav__icon"><Icon name={item.icon} /></span>
                  <span className="ce-nav__text">
                    <span className="ce-nav__label">{item.label}</span>
                    <span className="ce-nav__sub">{item.sub}</span>
                  </span>
                </button>
              ))}
            </nav>
            <div className="ce-sidebar__foot">
              <span className="ce-glyph" aria-hidden="true">{active.glyph}</span>
              <span>SARA — {signature.toLowerCase()}</span>
            </div>
          </aside>

          <section className="ce-center" aria-hidden="true" />

          <aside className="ce-rail">
            <div className="ce-card ce-ambient">
              <header className="ce-card__head"><span className="ce-card__eyebrow">Ambient state</span></header>
              <div className="ce-stat"><span className="ce-stat__key">Mode</span><b className={`ce-stat__val ce-tone--${toneFor('mode', cog.mode)}`}>{cog.mode}</b></div>
              <div className="ce-stat"><span className="ce-stat__key">Cognitive load</span><b className={`ce-stat__val ce-tone--${toneFor('load', cog.cognitiveLoad)}`}>{cog.cognitiveLoad}</b></div>
              <div className="ce-stat"><span className="ce-stat__key">Pressure trend</span><b className={`ce-stat__val ce-tone--${toneFor('pressure', cog.pressureTrend)}`}>{cog.pressureTrend}</b></div>
            </div>

            <div className="ce-card ce-focus">
              <header className="ce-card__head"><span className="ce-card__eyebrow">Active focus</span><Icon name="focus" size={18} /></header>
              <h2 className="ce-focus__title">{cog.focus.title}</h2>
              <div className="ce-focus__why">
                <span className="ce-card__eyebrow ce-card__eyebrow--soft">Why it matters</span>
                <p>{cog.focus.why}</p>
              </div>
              <div className="ce-meter">
                <span className="ce-meter__key">Urgency</span>
                <span className="ce-meter__dots">{[1, 2, 3, 4, 5].map((n) => (<i key={n} className={`ce-dot${n <= cog.focus.urgency ? ' ce-dot--on' : ''}`} />))}</span>
              </div>
              <div className="ce-meter"><span className="ce-meter__key">Confidence</span><b className="ce-meter__val">{cog.focus.confidence}%</b></div>
              <button type="button" className="ce-next" onClick={() => runQuickAction('start-focus', { action: focusAssist?.nextAction })}>
                <span className="ce-card__eyebrow ce-card__eyebrow--soft">Next step</span>
                <span className="ce-next__row"><span>{cog.focus.nextStep}</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14 M13 6l6 6-6 6" /></svg></span>
              </button>
            </div>

            <div className="ce-card ce-signals">
              <header className="ce-card__head"><span className="ce-card__eyebrow">Signals</span><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12h14 M13 6l6 6-6 6" /></svg></header>
              <ul className="ce-signal-list">
                {cog.signals.map((s) => (
                  <li key={s.label} className="ce-signal">
                    <span className={`ce-signal__label ce-tone--${toneFor('risk', s.risk)}`}>{s.label}</span>
                    <span className="ce-signal__risk">{s.risk === 'High' ? 'High risk' : s.risk}</span>
                  </li>
                ))}
              </ul>
            </div>
          </aside>
        </div>

        <div className="ce-bottom">
          <div className="ce-anchor">
            <span className="ce-glyph ce-glyph--lg" aria-hidden="true">{active.glyph}</span>
            <span className="ce-anchor__name">SARA</span>
            <span className="ce-anchor__dash">—</span>
            <span className="ce-anchor__state">{signature}</span>
          </div>
          <div className="ce-states" role="group" aria-label="SARA cognitive state">
            {STATES.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`ce-state-btn${dataCog === s.id ? ' ce-state-btn--on' : ''}`}
                title={s.label}
                aria-label={s.label}
                aria-pressed={dataCog === s.id}
                onClick={() => pick(s.id)}
              >
                <span aria-hidden="true">{s.glyph}</span>
              </button>
            ))}
          </div>
          <div className="ce-actions">
            {[
              { icon: 'capture', label: 'Capture', sub: 'Quick thought', fn: () => runQuickAction('capture') },
              { icon: 'ask', label: 'Ask', sub: 'Get clarity', fn: () => setCurrentView('companion') },
              { icon: 'plan', label: 'Plan', sub: 'Map it out', fn: () => runQuickAction('daily-brief') },
              { icon: 'review', label: 'Review', sub: 'Reflect', fn: () => runQuickAction('open-queue') },
            ].map((a) => (
              <button key={a.label} type="button" className="ce-action" onClick={a.fn}>
                <Icon name={a.icon} size={20} />
                <span className="ce-action__text">
                  <span className="ce-action__label">{a.label}</span>
                  <span className="ce-action__sub">{a.sub}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {intervening && ivTextReady && (
        <div className="ce-intervene" role="dialog" aria-live="polite">
          <p className="ce-intervene__line">
            Nick. You’ve been still a while.
            <br />It all resolves to one thing — <span className="ce-intervene__accent">this</span>.
          </p>
          <div className="ce-intervene__acts">
            <button type="button" className="ce-iv-btn ce-iv-btn--primary" onClick={() => { closeIntervention(); runQuickAction('start-focus', { action: focusAssist?.nextAction }); }}>Start now</button>
            <button type="button" className="ce-iv-btn" onClick={closeIntervention}>Give me ten</button>
          </div>
        </div>
      )}
    </div>
  );
}
