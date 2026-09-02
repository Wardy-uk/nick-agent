import { useContext, useEffect, useRef } from 'react';
import { FieldCoverContext } from './FieldCover';
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

// ⚠ NODE_MAX BOUNDS THE WRONG THING ON ITS OWN. Edges are quadratic in LOCAL
// density and nothing capped them, so the "perf floor and ceiling" above was
// measuring nodes while the cost lived in the mesh. Measured: a 340x700 phone
// builds ~265 nodes and ~1,100 edges; the 720x1280 kiosk panel hits the 900-node
// ceiling and builds ~10,000 — the clustering concentrates 50 nodes into each
// seed blob, so the edge count runs about 3x what an even scatter of the same
// nodes would give. On a Pi 4 that was a renderer pegged at 100% indefinitely.
//
// The thin is UNIFORM (a shuffle, then a truncate), so the mesh gets sparser
// without changing its shape — dense here and open there survives, which is the
// whole point of the seeds. Well above what a phone ever builds, so nothing
// about the reference look changes.
const MAX_EDGES = 3000;

// ⚠ ONE PATH PER ALPHA BUCKET, NOT ONE PER EDGE. Every `stroke()` and `fill()`
// is a separate rasterisation, and this loop was issuing ~11,000 of them per
// frame at 12fps — ~130,000 draw calls a second, for ever, on a display that is
// often not even lit. Quantising alpha into buckets and stroking each bucket as
// a single path makes that ~24, and is visually indistinguishable: the steps are
// finer than the difference between adjacent edges at these opacities.
const ALPHA_BUCKETS = 17;

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

// ── The slow pulse ──────────────────────────────────────────────────────────
//
// Nick, 31 Aug 2026: "change anything pressing to a slow pulse."
//
// ⚠ IT SURVIVES THE "NO DECORATIVE OSCILLATION" RULE ONLY BECAUSE IT IS
// STATE-DRIVEN. It happens when something is pressing and it stops when nothing
// is, so the breathing itself carries information — if the pool is calm the
// field does not breathe at all. A pulse that ran always would be exactly the
// screensaver this component was written to avoid.
//
// It BRIGHTENS and never darkens (the multiplier runs 1 → 1+amp, never below
// 1). Dipping below the resting level would make her LESS visible at the moment
// something needs him, which is backwards.
//
// Slow on purpose: ~6.5s is a breath, and a breath at the edge of vision reads
// as "something is waiting" where a faster flicker reads as agitation. It also
// stays legible at IDLE_FPS.
const PULSE_PERIOD = 6.5;
const PULSE_AMP = 0.45;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Which alpha bucket a computed opacity falls in, and the value drawn for that
// bucket. `rest` is the floor and `span` the amount coherence can add, so the
// input always sits in [rest, rest + span].
//
// ⚠ THE ENDPOINTS ARE EXACT, and that is not a detail. Bucketing to midpoints
// is the obvious way to do this and it lifts the RESTING alpha by 25% — and at
// rest is where nearly every edge sits, so it would have quietly brightened the
// whole substrate. Those rest values are hand-tuned (`EDGE_REST_ALPHA` went
// 0.012 -> 0.03 on 31 Aug to make her more visible); a perf change is not
// allowed to re-tune them by a side effect nobody would trace back to here.
// Dividing into `ALPHA_BUCKETS - 1` steps and rounding to the nearest makes
// both ends land on the real number and bounds the error between them.
const bucketOf = (alpha, rest, span) =>
  clamp(Math.round(((alpha - rest) / span) * (ALPHA_BUCKETS - 1)), 0, ALPHA_BUCKETS - 1);
const bucketAlpha = (b, rest, span) => rest + (b / (ALPHA_BUCKETS - 1)) * span;

// How the read becomes a picture. `depth` is how much order arrives (0 = none),
// `period` how many seconds between settles.
function drive({ degraded, confidenceLevel, quiet, activity, pressing }) {
  // Blind: pure noise, and BRIGHT. Being unable to see is not a reason to
  // disappear — an unresolved field is the honest picture of an unreadable
  // read, and it has to be visible enough to read as unresolved rather than as
  // an empty screen.
  // Blind never pulses. She cannot know whether anything is pressing, and a
  // field that breathes over an unreadable pool is asserting exactly the thing
  // it cannot see.
  if (degraded) return { depth: 0, period: 0, dim: 0.9, pulse: 0 };
  // Quiet: she settles rarely (nothing is being worked out) but stays PRESENT.
  // ⚠ dim was 0.45 here, which made "staying out of the way" mean "gone".
  // ⚠ Quiet still pulses when something is pressing. `quiet` means SARA will
  // not SPEAK — it has never meant she may hide a breaching escalation, and the
  // gate already refuses to drop a critical item off duty. Silent is not the
  // same as invisible.
  if (quiet) return { depth: 0.35, period: 16, dim: 0.78, pulse: pressing ? PULSE_AMP : 0 };
  // ⚠ The low-confidence floor is 0.45, not 0.34: below about 0.4 the settle
  // stops being legible as a settle at all, so "she is unsure" and "she is not
  // working" became the same picture. It is still clearly short of moderate.
  const depth = confidenceLevel === 'high' ? 1 : confidenceLevel === 'moderate' ? 0.7 : 0.45;
  // ⚠ `firefighting` no longer SHORTENS the settle. It used to drop to 5.5s, so
  // once the pulse arrived the same fact was being told twice — a faster settle
  // AND a breath — which reads as agitation rather than as one clear signal.
  // The pulse carries "something needs you" now; the settle is left to mean
  // what it always meant, which is how much she is resolving.
  //
  // `pre-meeting` keeps its 7s: imminent is not the same as pressing, and that
  // one is about a clock rather than about a queue.
  const period = activity === 'pre-meeting' ? 7 : 9.5;
  return { depth, period, dim: 1, pulse: pressing ? PULSE_AMP : 0 };
}

// ⚠ `still` — one frame, no loop, for a screen that is not lit.
//
// The lock state takes the backlight to 0, and nothing in a browser can see
// that: a kiosk page is never `document.visibilityState === 'hidden'`, so the
// battery guard below has been protecting against a condition that cannot occur
// on a wall display. The Pi 4 was found painting two full-screen fields at 12fps
// into a dark panel in an empty house, for a day and a half, at 100% of a core.
//
// It paints ONE coherent frame rather than nothing, which is the same choice the
// reduced-motion path makes and for the same reason: if the display agent dies,
// or the light comes back a moment before the verdict does, she is still there.
// "Whenever I see SARA" is satisfied by a static field; it is not satisfied by a
// blank canvas, and it costs nothing to honour.
export default function Field({ activity, confidenceLevel, quiet = false, degraded = false, pressing = false, still = false }) {
  const canvasRef = useRef(null);
  // See FieldCover. An overlay covering this subtree means nobody can see the
  // field, whatever the tab's visibility state says.
  const covered = useContext(FieldCoverContext);
  const coveredRef = useRef(covered);
  // The running loop's handles, so covering can stop and start it WITHOUT
  // re-running the effect below — that would rebuild the substrate and flicker.
  const loopRef = useRef(null);
  // Live state the loop reads without being torn down and rebuilt — regenerating
  // the substrate on every poll would make the whole field flicker once a minute.
  const driveRef = useRef(drive({ degraded, confidenceLevel, quiet, activity, pressing }));

  useEffect(() => {
    driveRef.current = drive({ degraded, confidenceLevel, quiet, activity, pressing });
  }, [degraded, confidenceLevel, quiet, activity, pressing]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let nodes = [];
    let edges = [];
    // Reused across frames — allocating 24 arrays per frame at 12fps is exactly
    // the kind of churn this component is now trying not to do.
    let edgeBuckets = [];
    let nodeBuckets = [];
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
      // See MAX_EDGES. Shuffle then truncate — a uniform thin, so a big panel
      // gets a sparser mesh of the same shape rather than a differently shaped
      // one. Dropping the longest instead would strip the inter-cluster links,
      // which are the connections that make it read as a graph at all.
      if (edges.length > MAX_EDGES) {
        for (let i = edges.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const tmp = edges[i]; edges[i] = edges[j]; edges[j] = tmp;
        }
        edges.length = MAX_EDGES;
      }
      edgeBuckets = [];
      nodeBuckets = [];
      for (let i = 0; i < ALPHA_BUCKETS; i++) { edgeBuckets.push([]); nodeBuckets.push([]); }
      return true;
    }

    function paint(t, k, focus, dim) {
      ctx.clearRect(0, 0, w, h);

      // Edges first — cognition is relationship-first, nodes secondary.
      for (let i = 0; i < ALPHA_BUCKETS; i++) { edgeBuckets[i].length = 0; nodeBuckets[i].length = 0; }

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
        edgeBuckets[bucketOf(base, EDGE_REST_ALPHA, EDGE_COHERENT)].push(e);
      }

      ctx.lineWidth = 0.7;
      for (let b = 0; b < ALPHA_BUCKETS; b++) {
        const list = edgeBuckets[b];
        if (!list.length) continue;
        ctx.strokeStyle = `rgba(120,170,235,${(bucketAlpha(b, EDGE_REST_ALPHA, EDGE_COHERENT) * dim).toFixed(3)})`;
        ctx.beginPath();
        for (let i = 0; i < list.length; i++) {
          const n1 = nodes[edges[list[i]][0]];
          const n2 = nodes[edges[list[i]][1]];
          ctx.moveTo(n1.x, n1.y);
          ctx.lineTo(n2.x, n2.y);
        }
        ctx.stroke();
      }

      // Nodes stay PINNED. Jitter is the noise floor, and coherence removes it —
      // the dot does not brighten so much as stop trembling.
      for (let n = 0; n < nodes.length; n++) {
        const nd = nodes[n];
        const near = Math.max(0, 1 - Math.hypot(nd.x - focus.x, nd.y - focus.y) / FOCUS_RADIUS) * k;
        const jitter = (1 - near) * 0.9;
        nd.dx = Math.sin(t * nd.sp + nd.ph) * jitter;
        nd.dy = Math.cos(t * nd.sp * 1.3 + nd.ph) * jitter;
        nd.r = 0.95 + near * 0.55;
        nodeBuckets[bucketOf(NODE_REST_ALPHA + near * NODE_COHERENT, NODE_REST_ALPHA, NODE_COHERENT)].push(n);
      }

      for (let b = 0; b < ALPHA_BUCKETS; b++) {
        const list = nodeBuckets[b];
        if (!list.length) continue;
        ctx.fillStyle = `rgba(150,190,240,${(bucketAlpha(b, NODE_REST_ALPHA, NODE_COHERENT) * dim).toFixed(3)})`;
        ctx.beginPath();
        for (let i = 0; i < list.length; i++) {
          const nd = nodes[list[i]];
          const x = nd.x + nd.dx;
          const y = nd.y + nd.dy;
          // ⚠ `moveTo` before each arc, or every dot is joined to the last by a
          // stray line — an arc continues the current subpath rather than
          // starting one.
          ctx.moveTo(x + nd.r, y);
          ctx.arc(x, y, nd.r, 0, 6.2832);
        }
        ctx.fill();
      }
    }

    if (!build()) return undefined;

    if (reduced || still) {
      // One still, half-coherent frame. No loop, no motion, no battery.
      //
      // ⚠ The pulse becomes a STEADY LIFT here rather than vanishing. Reduced
      // motion is a request for less movement, not for less information — a
      // reader who has asked for stillness must not silently lose the one
      // signal that says something needs them.
      const paintStill = () => {
        const d = driveRef.current;
        paint(0, 0.45 * d.depth, { x: w * 0.7, y: h * 0.25 }, d.dim * (1 + d.pulse));
      };
      paintStill();
      const ro = new ResizeObserver(() => {
        if (build()) paintStill();
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

      // A slow global breath over the whole field, independent of the LOCAL
      // settle above — they are two different facts (something needs you /
      // she is resolving something) and must not be the same gesture.
      // Raised cosine so it runs 1 → 1+amp and never dips below the floor.
      const breath = d.pulse
        ? 1 + d.pulse * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / PULSE_PERIOD))
        : 1;

      paint(t, k, focus, d.dim * breath);
    }

    function start() {
      if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    }
    function stop() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    }
    function onVisibility() {
      // ⚠ Returning to the tab must not resume a field that is still covered —
      // the two reasons to be stopped are independent and either one holds.
      if (document.visibilityState === 'hidden' || coveredRef.current) stop();
      else start();
    }

    const ro = new ResizeObserver(() => { build(); });
    ro.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);
    loopRef.current = { start, stop };
    // ⚠ Do not start under an overlay. Mounting while already covered is the
    // normal case on a kiosk that has been locked for hours.
    if (!coveredRef.current) start();

    return () => {
      stop();
      loopRef.current = null;
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
    // ⚠ `still` is structural, not driven — it decides whether there is a loop
    // at all, so it belongs here, unlike the drive props, which are read through
    // `driveRef` precisely so a poll cannot rebuild the substrate and make the
    // whole field flicker once a minute.
  }, [still]);

  useEffect(() => {
    coveredRef.current = covered;
    const loop = loopRef.current;
    if (!loop) return;          // `still` and reduced-motion have no loop to stop
    if (covered) loop.stop(); else loop.start();
  }, [covered]);

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
