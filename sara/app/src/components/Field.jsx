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
//   * quiet (in a meeting) → dim and near-still. Staying out of the way is a
//                            visual fact, not just a suppressed notification.
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
const NODE_COUNT = 230;
const SEEDS = 11;              // clusters — a vault is lumpy; an even scatter reads as a starfield
const EDGE_DIST_SQ = 1500;     // ~39px. Latent edges only; never created while thinking
const FOCUS_RADIUS = 150;

// How the read becomes a picture. `depth` is how much order arrives (0 = none),
// `period` how many seconds between settles.
function drive({ degraded, confidenceLevel, quiet, activity }) {
  if (degraded) return { depth: 0, period: 0, dim: 0.85 };
  if (quiet) return { depth: 0.35, period: 16, dim: 0.45 };
  const depth = confidenceLevel === 'high' ? 1 : confidenceLevel === 'moderate' ? 0.7 : 0.34;
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

      // Seeds spread across the WHOLE canvas with a margin. The first cut let
      // them fall anywhere and they piled into one corner — the field read as a
      // lopsided blob rather than a mind.
      const seeds = [];
      for (let s = 0; s < SEEDS; s++) {
        seeds.push({
          x: w * (0.08 + 0.84 * ((s % 3) / 2 + (Math.random() - 0.5) * 0.22)),
          y: h * (0.06 + 0.88 * (Math.floor(s / 3) / 3 + (Math.random() - 0.5) * 0.16)),
        });
      }
      nodes = [];
      for (let i = 0; i < NODE_COUNT; i++) {
        const seed = seeds[i % seeds.length];
        const spread = 26 + Math.random() * 46;
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
        const alpha = (0.01 + near * 0.115) * dim;
        if (alpha < 0.012) continue;
        ctx.strokeStyle = `rgba(120,170,235,${alpha.toFixed(3)})`;
        ctx.lineWidth = 0.6;
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
        ctx.fillStyle = `rgba(150,190,240,${((0.055 + near * 0.24) * dim).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(nd.x + jx, nd.y + jy, 0.8 + near * 0.45, 0, 6.2832);
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
