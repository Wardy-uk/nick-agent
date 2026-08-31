import { useEffect, useRef } from 'react';
import './Field.css';

// Field — SARA's presence on the phone.
//
// She is not an object. There is no orb, no avatar, no face, no glyph, no
// single bright point you could call "where SARA is" — `MANIFESTATION.md`
// deprecates every one of those permanently, and it is right to. What you see
// is Nick's vault as a PINNED, noisy substrate, and SARA visible only as
// ENTROPY FALLING: a region's jitter collapsing, its latent edges firming up,
// then relaxing back to noise. Nothing moves. Nothing is drawn that was not
// already there.
//
// ── The thing that stops this being a screensaver ───────────────────────────
// THE COHERENCE ON SCREEN IS THE COHERENCE OF THE READ. The field is driven by
// the brain's own state, so it is informative before a word is read:
//
//   * can't see your work  → no coherence at all. Pure noise. If NEURO's queue
//                            is unreachable the screen LOOKS unresolved, which
//                            is the honest thing for it to look like.
//   * low confidence       → it barely settles. She is genuinely unsure and the
//                            picture says so.
//   * high confidence      → a clean, complete settle.
//   * quiet (in a meeting) → near-still, but STILL THERE. Staying out of the
//                            way is a visual fact, not a disappearance — she
//                            settles rarely rather than fading out.
//   * firefighting         → settles more often. Something is actually going on.
//
// That mapping is why this survives the "no decorative oscillation" rule: it
// never animates for the look of it. If the state is flat, so is the field.
//
// ── Battery ─────────────────────────────────────────────────────────────────
// This is a PWA that may sit open. It renders at ~12fps while idle and ~30fps
// only during a settle, and stops dead when the page is hidden. Reduced-motion
// gets one static, coherent frame and no loop at all.

const IDLE_FPS = 12;
const ACTIVE_FPS = 30;

// ⚠ Density is per AREA, not a fixed count. The first cut hardcoded 230 nodes,
// which is right for a 340x700 phone and vanishes on anything wider: the same
// nodes spread over five times the area, the mesh stopped forming, and the
// cloud disappeared entirely. One node per ~900px² is the density that read
// well in the mockup; the clamp is a perf floor and ceiling, not a look.
const PX2_PER_NODE = 900;
const NODE_MIN = 150;
const NODE_MAX = 900;
const PX2_PER_SEED = 26000;    // clusters — a vault is lumpy; an even scatter reads as a starfield
const SEED_MIN = 5;
const SEED_MAX = 18;
const EDGE_DIST_SQ = 2100;     // ~46px. Latent edges only; never created while thinking
const FOCUS_RADIUS = 150;

// ── Presence ────────────────────────────────────────────────────────────────
//
// Nick, 31 Aug 2026: "crank up the visibility of SARA's presence — I always
// want to see her." These are the numbers that decide that, gathered here
// rather than buried in the paint loop, because they are the one part of this
// file anyone will ever want to tune.
//
// ⚠ THE SPLIT THAT MAKES THIS HONEST: `dim` is PRESENCE, `depth`/`period` are
// THE READ. Before this, `quiet` dropped dim to 0.45 and so conflated the two —
// being in a meeting made her nearly invisible rather than merely calm. She is
// still there in a meeting; she is just not resolving anything. Raising the
// FLOOR (she is always visible) while leaving the SETTLE to carry the state
// keeps "the coherence on screen is the coherence of the read" exactly as true
// as it was, and is the only way to crank visibility without the field starting
// to claim things it has not read.
const NODE_REST_ALPHA = 0.14;  // the substrate at rest. Was 0.07 — a node at
                               // 0.07 x 0.45 dim is 0.031 on a #0b0f14 ground,
                               // which is black.
const NODE_COHERENT = 0.32;    // added at full coherence
const EDGE_REST_ALPHA = 0.03;  // was 0.012, i.e. below the cull once dimmed
const EDGE_COHERENT = 0.18;

// ⚠ THE CULL IS A PERF GUARD AND MUST BE TESTED BEFORE `dim` IS APPLIED. It was
// applied after, so dimming did not dim the connections, it DELETED them: at
// `quiet` an edge computed 0.012 x 0.45 = 0.0054, under the 0.013 floor, so NO
// EDGE DREW AT ALL. The nebulous connected nodes lost their connections in
// precisely the state a desk screen sits in most of the day, and it read as a
// sparse dot field rather than a mesh.
const EDGE_CULL_ALPHA = 0.006;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// How the read becomes a picture. `depth` is how much order arrives (0 = none),
// `period` how many seconds between settles.
function drive({ degraded, confidenceLevel, quiet, activity }) {
  // Blind: pure noise, and BRIGHT. Being unable to see is not a reason to
  // disappear — an unresolved field is the honest picture of an unreadable
  // read, and it has to be visible enough to read as unresolved rather than as
  // an empty screen.
  if (degraded) return { depth: 0, period: 0, dim: 0.9 };
  // Quiet: she settles rarely (nothing is being worked out) but stays PRESENT.
  // ⚠ dim was 0.45 here, which made "staying out of the way" mean "gone".
  if (quiet) return { depth: 0.35, period: 16, dim: 0.78 };
  // ⚠ The low-confidence floor is 0.45, not 0.34: below about 0.4 the settle
  // stops being legible as a settle at all, so "she is unsure" and "she is not
  // working" became the same picture. It is still clearly short of moderate.
  const depth = confidenceLevel === 'high' ? 1 : confidenceLevel === 'moderate' ? 0.7 : 0.45;
  const period = activity === 'firefighting' ? 5.5 : activity === 'pre-meeting' ? 7 : 9.5;
  return { depth, period, dim: 1 };
}

export default function Field({ activity, confidenceLevel, quiet = false, degraded = false }) {
  const canvasRef = useRef(null);
  // Live state the loop reads without being torn down and rebuilt — regenerating
  // the substrate on every poll would make the whole field flicker once a minute.
  const driveRef = useRef(drive({ degraded, confidenceLevel, quiet, activity }));

  useEffect(() => {
    driveRef.current = drive({ degraded, confidenceLevel, quiet, activity });
  }, [degraded, confidenceLevel, quiet, activity]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let nodes = [];
    let edges = [];
    let w = 0;
    let h = 0;
    let ctx = null;

    function build() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      if (w < 2 || h < 2) return false;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Both counts scale with the area, so the substrate has the same density
      // on a 390px phone and a 1700px desktop.
      const area = w * h;
      const nodeCount = Math.round(clamp(area / PX2_PER_NODE, NODE_MIN, NODE_MAX));
      const seedCount = Math.round(clamp(area / PX2_PER_SEED, SEED_MIN, SEED_MAX));

      // Seeds land freely rather than on a grid. An even distribution reads as
      // wallpaper; the uneven one — dense here, open there — is what makes it
      // look like a mind instead of a texture.
      const seeds = [];
      for (let s = 0; s < seedCount; s++) {
        seeds.push({ x: Math.random() * w, y: Math.random() * h });
      }
      nodes = [];
      for (let i = 0; i < nodeCount; i++) {
        const seed = seeds[i % seeds.length];
        const spread = 34 + Math.random() * 62;
        nodes.push({
          x: seed.x + (Math.random() - 0.5) * spread * 2,
          y: seed.y + (Math.random() - 0.5) * spread * 2,
          ph: Math.random() * Math.PI * 2,
          sp: 0.4 + Math.random() * 0.9,
        });
      }
      edges = [];
      for (let a = 0; a < nodes.length; a++) {
        for (let b = a + 1; b < nodes.length; b++) {
          const dx = nodes[a].x - nodes[b].x;
          const dy = nodes[a].y - nodes[b].y;
          if (dx * dx + dy * dy < EDGE_DIST_SQ) edges.push([a, b]);
        }
      }
      return true;
    }

    function paint(t, k, focus, dim) {
      ctx.clearRect(0, 0, w, h);

      // Edges first — cognition is relationship-first, nodes secondary.
      for (let e = 0; e < edges.length; e++) {
        const n1 = nodes[edges[e][0]];
        const n2 = nodes[edges[e][1]];
        const mx = (n1.x + n2.x) / 2;
        const my = (n1.y + n2.y) / 2;
        const near = Math.max(0, 1 - Math.hypot(mx - focus.x, my - focus.y) / FOCUS_RADIUS) * k;
        // ⚠ Culled on the UNDIMMED value — see EDGE_CULL_ALPHA. Testing the
        // dimmed one made `dim` delete edges rather than dim them.
        const base = EDGE_REST_ALPHA + near * EDGE_COHERENT;
        if (base < EDGE_CULL_ALPHA) continue;
        ctx.strokeStyle = `rgba(120,170,235,${(base * dim).toFixed(3)})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(n1.x, n1.y);
        ctx.lineTo(n2.x, n2.y);
        ctx.stroke();
      }

      // Nodes stay PINNED. Jitter is the noise floor, and coherence removes it —
      // the dot does not brighten so much as stop trembling.
      for (let n = 0; n < nodes.length; n++) {
        const nd = nodes[n];
        const near = Math.max(0, 1 - Math.hypot(nd.x - focus.x, nd.y - focus.y) / FOCUS_RADIUS) * k;
        const jitter = (1 - near) * 0.9;
        const jx = Math.sin(t * nd.sp + nd.ph) * jitter;
        const jy = Math.cos(t * nd.sp * 1.3 + nd.ph) * jitter;
        ctx.fillStyle = `rgba(150,190,240,${((NODE_REST_ALPHA + near * NODE_COHERENT) * dim).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(nd.x + jx, nd.y + jy, 0.95 + near * 0.55, 0, 6.2832);
        ctx.fill();
      }
    }

    if (!build()) return undefined;

    if (reduced) {
      // One still, half-coherent frame. No loop, no motion, no battery.
      paint(0, 0.45 * driveRef.current.depth, { x: w * 0.7, y: h * 0.25 }, driveRef.current.dim);
      const ro = new ResizeObserver(() => {
        if (build()) paint(0, 0.45 * driveRef.current.depth, { x: w * 0.7, y: h * 0.25 }, driveRef.current.dim);
      });
      ro.observe(canvas);
      return () => ro.disconnect();
    }

    let t = 0;
    let phase = 0;
    let focus = { x: w * 0.7, y: h * 0.3 };
    let last = 0;

    function frame(ms) {
      raf = requestAnimationFrame(frame);
      const d = driveRef.current;

      // A settle runs 6s of the cycle; outside it we are idling in noise, so
      // there is nothing worth 30fps.
      const settling = d.period > 0 && phase < 6;
      const interval = 1000 / (settling ? ACTIVE_FPS : IDLE_FPS);
      if (ms - last < interval) return;
      const dt = Math.min((ms - last) / 1000, 0.1);
      last = ms;

      t += dt;
      if (d.period > 0) {
        phase += dt;
        if (phase > d.period) {
          phase = 0;
          focus = { x: 30 + Math.random() * (w - 60), y: 60 + Math.random() * (h - 120) };
        }
      } else {
        phase = 999; // degraded: never settles. Pure, unresolved noise.
      }

      // Ease in 1.6s, hold, ease out — order arriving and relaxing, never a sweep.
      const raw = phase < 1.6 ? phase / 1.6
        : phase < 4.2 ? 1
        : phase < 6 ? 1 - (phase - 4.2) / 1.8
        : 0;
      const k = raw * raw * (3 - 2 * raw) * d.depth;

      paint(t, k, focus, d.dim);
    }

    function start() {
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }
    function stop() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
    function onVisibility() {
      if (document.visibilityState === 'hidden') stop(); else start();
    }

    const ro = new ResizeObserver(() => { build(); });
    ro.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);
    start();

    return () => {
      stop();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);

  return (
    <div className="field" aria-hidden="true">
      <canvas ref={canvasRef} className="field__canvas" />
      {/* The scrim is what keeps her behind the words rather than fighting them.
          Open at the top right, closing down toward the text — so the field has
          somewhere to be dramatic without ever costing a sentence its contrast. */}
      <div className="field__scrim" />
    </div>
  );
}
