// NEURO — Attention widget for Scriptable (iOS)
//
// The third renderer of GET /api/attention, after sara/app's Surface and the
// kiosk. It renders what the brain decided; it decides nothing itself.
//
// ── The three silences must stay distinguishable ────────────────────────────
// A blank card is not one state, it is four, and conflating them is how a
// broken feed comes to look like a good day:
//   • unreachable    — "I couldn't ask" (Pi down, no Tailscale, bad token)
//   • pool unavailable — "I can't see your work; this is NOT an all-clear"
//   • quiet          — in a meeting, off, away: nothing SHOULD be said
//   • nothing pending — we looked, and there genuinely is nothing
// Each gets its own words. None of them renders as an empty box.
//
// ── What this file deliberately does not do ─────────────────────────────────
// No re-ranking, no rephrasing, no working out where a card should go. `say`,
// `speech` and `tab` are all composed server-side so the widget, the app and
// the notification for one thing cannot say it three ways or route it two.
//
// ── Setup ───────────────────────────────────────────────────────────────────
// 1. Install Scriptable, paste this in as a script named "NEURO".
// 2. Run it once inside the app — it prompts for the base URL and API token
//    and stores both in the iOS Keychain.
// 3. Long-press the home screen → add a Scriptable widget → pick "NEURO".
//    Medium or large. Small shows the primary card only.
//
// ⚠ THIS FILE MUST CONTAIN NO BACKSLASHES — none, anywhere, including inside
// regex literals and string escapes. It reaches the phone by being COPIED and
// PASTED through Safari, and a backslash does not reliably survive that trip:
// an escaped forward slash inside a regex literal arrived as a syntax error on
// Nick's phone and the whole widget refused to parse. That rule covers COMMENTS
// too — this one used to quote the offending pattern, and tripped its own test.
// Use String.fromCharCode() for control characters,
// split/join instead of regex replace, and endsWith/slice instead of anchors.
// A test pins this so it cannot creep back in.
//
// The token is NEVER written into this file: the repo is public, and a
// credential in a tracked file is exactly how the PIN leaked in July.
// To change it later: run the script in-app and hold the Cancel-free prompt,
// or delete the keys via Scriptable's own console.

const KEY_URL = 'neuro_base_url';
const KEY_TOKEN = 'neuro_api_token';
const DEFAULT_URL = 'https://pi5.tailecb90f.ts.net';
const APP_URL = 'https://sara.nickward.co.uk';
const TIMEOUT_SECONDS = 12;

// Bumped by hand on every change. It is rendered on the widget so "did my edit
// actually land?" is answerable at a glance instead of by guessing — the whole
// reason this and the self-update below exist.
const VERSION = 'v18';
const SOURCE_URL = 'https://raw.githubusercontent.com/Wardy-uk/nuero/main/sara/widget/neuro-attention.js';

// A marker that must appear in any download before it is allowed to overwrite
// this file. A 404 page, a captive-portal splash or a truncated body are all
// "structurally valid" strings, and none of them is a script.
const SOURCE_MARKER = 'NEURO — Attention widget for Scriptable';

/**
 * Pull the latest version of this script over itself.
 *
 * ⚠ Runs ONLY on a manual in-app run, never from the widget. This executes code
 * fetched from the internet on a device holding a NEURO API token, so it must
 * be something Nick chose to do, not something that happens on a timer while
 * the phone is in his pocket. The repo is public, so the trust here is in
 * GitHub's account security — that is the whole of the threat model, and it is
 * the reason this is not wired into the widget path.
 *
 * Returns 'updated' | 'current' | 'failed: <reason>'.
 */
async function selfUpdate() {
  try {
    const path = module.filename;
    let fm;
    try { fm = FileManager.iCloud(); } catch (e) { fm = FileManager.local(); }
    if (!fm.fileExists(path)) fm = FileManager.local();

    const req = new Request(SOURCE_URL);
    req.timeoutInterval = TIMEOUT_SECONDS;
    const latest = await req.loadString();

    if (!latest || latest.indexOf(SOURCE_MARKER) === -1) return 'failed: not a script';

    const current = fm.readString(path);
    // Compare ignoring line endings — the repo is checked out CRLF on Windows
    // and served LF, so a byte comparison would report an update every run.
    // Built from char codes rather than escapes: see the no-backslash rule above.
    const CR = String.fromCharCode(13);
    const LF = String.fromCharCode(10);
    const norm = (s) => String(s).split(CR + LF).join(LF);
    if (norm(latest) === norm(current)) return 'current';

    fm.writeString(path, latest);
    return 'updated';
  } catch (e) {
    return `failed: ${(e && e.message) || 'unknown'}`;
  }
}

// ── Config ──────────────────────────────────────────────────────────────────

async function prompt(title, message, value, secure) {
  const a = new Alert();
  a.title = title;
  a.message = message;
  const field = secure ? a.addSecureTextField('', value || '') : a.addTextField('', value || '');
  a.addAction('Save');
  await a.present();
  return a.textFieldValue(0);
}

// NB: not named `config` — that is Scriptable's own global (config.runsInWidget,
// config.widgetFamily) and shadowing it breaks the entry point below.
async function loadConfig() {
  let base = Keychain.contains(KEY_URL) ? Keychain.get(KEY_URL) : null;
  let token = Keychain.contains(KEY_TOKEN) ? Keychain.get(KEY_TOKEN) : null;

  // Only ever prompts when run by hand. A widget refresh with no config renders
  // the "unreachable" card instead — a widget cannot show an alert, and silently
  // rendering nothing is the failure mode this whole file guards against.
  if (config.runsInApp) {
    if (!base) {
      base = await prompt('NEURO base URL', 'Tailscale host serving the API.', DEFAULT_URL);
      if (base) {
        // Trailing slashes stripped by hand rather than by regex — an escaped
        // forward slash is precisely what a paste pipeline eats.
        let clean = base.trim();
        while (clean.length && clean.charAt(clean.length - 1) === '/') {
          clean = clean.slice(0, -1);
        }
        Keychain.set(KEY_URL, clean);
      }
    }
    if (!token) {
      token = await prompt('NEURO API token', 'NEURO_API_TOKEN from backend/.env. Stored in the iOS Keychain, not in the script.', '', true);
      if (token) Keychain.set(KEY_TOKEN, token.trim());
    }
  }
  return { base: base || DEFAULT_URL, token };
}

// ── Data ────────────────────────────────────────────────────────────────────

async function fetchAttention({ base, token }) {
  if (!token) return { error: 'Not set up yet — open the NEURO script once.' };
  try {
    const req = new Request(`${base}/api/attention`);
    req.headers = { 'X-NEURO-API-TOKEN': token };
    req.timeoutInterval = TIMEOUT_SECONDS;
    const json = await req.loadJSON();
    // A 500 from the route answers {ok:false}. That is "the brain broke", which
    // is not the same as an empty feed, so it must not fall through as one.
    if (json && json.ok === false) return { error: json.error || 'NEURO returned an error' };
    if (!json || typeof json !== 'object') return { error: 'Unexpected response' };
    return { data: json };
  } catch (e) {
    return { error: (e && e.message) || 'Could not reach NEURO' };
  }
}

/**
 * Momentum, for the off-duty view. Fetched ONLY when the brain has said Nick is
 * off duty, so a working day never pays for it.
 *
 * The DECISION (is he working) is the brain's and arrives on the attention
 * payload as `context.duty`. This is only the CONTENT that decision calls for.
 */
async function fetchWins({ base, token }) {
  try {
    const req = new Request(`${base}/api/wins`);
    req.headers = { 'X-NEURO-API-TOKEN': token };
    req.timeoutInterval = TIMEOUT_SECONDS;
    const json = await req.loadJSON();
    if (!json || typeof json !== 'object' || json.ok === false) return null;
    return json;
  } catch (e) {
    // A missing ledger is not worth failing the widget over — the off-duty view
    // degrades to "you're off" with no numbers, which is still true.
    return null;
  }
}

// ── Weather ─────────────────────────────────────────────────────────────────
//
// Scriptable has no Weather class (checked, rather than assumed), so this uses
// Open-Meteo: free, no key, no signup, no account to expire quietly in six
// months. WMO codes → an SF Symbol and a plain-English phrase.
//
// Location is resolved on a manual run and CACHED, because Location.current()
// in a widget refresh is slow and often simply denied. A widget that waits on
// the GPS is a widget that renders blank.

const KEY_LAT = 'neuro_lat';
const KEY_LON = 'neuro_lon';

const WMO = {
  0: ['sun.max', 'Clear'], 1: ['sun.min', 'Mostly clear'], 2: ['cloud.sun', 'Partly cloudy'],
  3: ['cloud', 'Overcast'], 45: ['cloud.fog', 'Fog'], 48: ['cloud.fog', 'Freezing fog'],
  51: ['cloud.drizzle', 'Light drizzle'], 53: ['cloud.drizzle', 'Drizzle'], 55: ['cloud.drizzle', 'Heavy drizzle'],
  61: ['cloud.rain', 'Light rain'], 63: ['cloud.rain', 'Rain'], 65: ['cloud.heavyrain', 'Heavy rain'],
  66: ['cloud.sleet', 'Freezing rain'], 67: ['cloud.sleet', 'Freezing rain'],
  71: ['cloud.snow', 'Light snow'], 73: ['cloud.snow', 'Snow'], 75: ['cloud.snow', 'Heavy snow'],
  80: ['cloud.rain', 'Showers'], 81: ['cloud.rain', 'Showers'], 82: ['cloud.heavyrain', 'Heavy showers'],
  95: ['cloud.bolt', 'Thunderstorms'], 96: ['cloud.bolt.rain', 'Storms'], 99: ['cloud.bolt.rain', 'Storms'],
};

function wmo(code) {
  return WMO[Number(code)] || ['cloud', 'Unsettled'];
}

async function resolveLocation() {
  const cached = Keychain.contains(KEY_LAT) && Keychain.contains(KEY_LON)
    ? { lat: Number(Keychain.get(KEY_LAT)), lon: Number(Keychain.get(KEY_LON)) }
    : null;

  // Only ever ask the GPS on a manual run; the widget uses whatever was cached.
  if (config.runsInApp) {
    try {
      Location.setAccuracyToHundredMeters();
      const loc = await Location.current();
      if (loc && Number.isFinite(loc.latitude)) {
        Keychain.set(KEY_LAT, String(loc.latitude));
        Keychain.set(KEY_LON, String(loc.longitude));
        return { lat: loc.latitude, lon: loc.longitude };
      }
    } catch (e) { /* fall back to the cache */ }
  }
  return cached;
}

/**
 * Now, and the next thing that changes.
 *
 * "Next" is deliberately not "the temperature in three hours" — that is rarely
 * the useful fact. It is the next hour in the working evening with a real
 * chance of rain, and only if there is one; otherwise it falls back to the
 * trend. Nothing is invented when the forecast cannot be read.
 */
async function fetchWeather() {
  try {
    const here = await resolveLocation();
    if (!here) return null;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${here.lat}&longitude=${here.lon}`
      + '&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code,precipitation_probability'
      + '&forecast_days=2&timezone=auto';
    const req = new Request(url);
    req.timeoutInterval = TIMEOUT_SECONDS;
    const j = await req.loadJSON();
    if (!j || !j.current || !j.hourly) return null;

    const now = {
      temp: Math.round(Number(j.current.temperature_2m)),
      code: Number(j.current.weather_code),
    };

    const times = j.hourly.time || [];
    const pops = j.hourly.precipitation_probability || [];
    const temps = j.hourly.temperature_2m || [];
    const codes = j.hourly.weather_code || [];

    const nowMs = Date.now();
    const idxs = times
      .map((t, i) => ({ i, ms: new Date(t).getTime() }))
      .filter((x) => x.ms > nowMs && x.ms <= nowMs + 8 * 3600 * 1000)
      .map((x) => x.i);

    let next = null;
    const wet = idxs.find((i) => Number(pops[i]) >= 40);
    if (wet !== undefined) {
      const at = new Date(times[wet]);
      next = `${wmo(codes[wet])[1]} ${String(at.getHours()).padStart(2, '0')}:00 · ${Math.round(Number(pops[wet]))}%`;
    } else if (idxs.length) {
      const later = idxs[Math.min(3, idxs.length - 1)];
      const t = Math.round(Number(temps[later]));
      const at = new Date(times[later]);
      next = `${t}° at ${String(at.getHours()).padStart(2, '0')}:00`;
    }

    return { now, next, label: wmo(now.code)[1], symbol: wmo(now.code)[0] };
  } catch (e) {
    return null;
  }
}

/** The week's task target and progress against it. */
async function fetchTarget({ base, token }) {
  try {
    const req = new Request(`${base}/api/wins/target`);
    req.headers = { 'X-NEURO-API-TOKEN': token };
    req.timeoutInterval = TIMEOUT_SECONDS;
    const json = await req.loadJSON();
    if (!json || typeof json !== 'object' || json.ok === false) return null;
    return json;
  } catch (e) {
    return null;
  }
}

// ── Look ────────────────────────────────────────────────────────────────────
//
// Design rules, so this stays legible rather than merely decorated:
//  • ONE accent per card, taken from the brain's own `urgency` — colour is
//    information here, not styling. Nothing is coloured for the sake of it.
//  • The icon says the TYPE, the accent says the URGENCY. Two channels, two
//    facts; if they said the same thing one of them would be noise.
//  • Everything degrades: an unknown type falls back to a dot, a missing SF
//    Symbol falls back to a glyph, and both still render a readable row.

/**
 * Where a tap goes.
 *
 * ⚠ iOS gives no way to deep-link an installed PWA. An https:// URL opens
 * Safari, NOT the SARA Mobile icon on the home screen — that is an iOS
 * limitation, not something this script can route around.
 *
 * The route is a Shortcut named by OPEN_SHORTCUT. `shortcuts://` DOES hand
 * control away from the widget, so whatever that Shortcut can reach, this can.
 *
 * ⚠ The Shortcut MUST be "Show Web Page" with its URL set to Shortcut Input.
 * Two dead ends were tried first and are written down so they are not retried:
 *  1. "Open App" lists REAL APPS ONLY. An installed PWA is a web clip and never
 *     appears in that picker, so it cannot target SARA Mobile at all.
 *  2. "Open URLs" hands off to Safari — the same place the plain https route
 *     reaches, one hop later, so it buys nothing.
 * "Show Web Page" renders full-screen inside Shortcuts, which is close enough
 * to the app, AND takes a URL — so unlike Open App it keeps the destination.
 *
 * Set OPEN_SHORTCUT to '' to go back to the direct https route (Safari, correct
 * tab). The Shortcut name must match EXACTLY, or every tap throws "the file
 * doesn't exist".
 */
const OPEN_SHORTCUT = 'Open SARA';

function tabUrl(tab) {
  const web = `${APP_URL}/?tab=${encodeURIComponent(tab || 'surface')}`;
  if (!OPEN_SHORTCUT) return web;
  // The destination rides along as the Shortcut's INPUT, so a full-screen web
  // view keeps per-card routing. This is the whole reason a "Show Web Page"
  // shortcut beats an "Open App" one: Open App carries no URL, so every tap
  // would land wherever the app happened to be last.
  return `shortcuts://run-shortcut?name=${encodeURIComponent(OPEN_SHORTCUT)}`
    + `&input=text&text=${encodeURIComponent(web)}`;
}

const INK = Color.dynamic(new Color('#111114'), new Color('#f5f5f7'));
const MUTED = Color.dynamic(new Color('#8a8a8e'), new Color('#98989d'));
const HAIRLINE = Color.dynamic(new Color('#e6e6ea'), new Color('#3a3a3c'));
const CARD = Color.dynamic(new Color('#ffffff'), new Color('#2c2c2e'));
const TILE_BG = Color.dynamic(new Color('#f4f4f6'), new Color('#3a3a3c'));

// Urgency → accent, held as [light, dark] hex so the same pair can produce both
// a solid ink and a low-alpha wash. `critical` is the only red in the widget, so
// red always means the same thing wherever it appears.
const HEX = {
  critical: ['#d92d20', '#ff6b5e'],
  high: ['#b54708', '#ffa94d'],
  medium: ['#0064d2', '#5ea9ff'],
  normal: ['#0064d2', '#5ea9ff'],
  low: ['#6a6a70', '#98989d'],
  positive: ['#1a7f4b', '#4ad07d'],
};

function dyn(pair, alpha) {
  const a = alpha === undefined ? 1 : alpha;
  // Dark mode carries a slightly stronger wash: the same alpha over a dark
  // ground reads as nearly nothing.
  const da = alpha === undefined ? 1 : Math.min(1, alpha * 1.8);
  return Color.dynamic(new Color(pair[0], a), new Color(pair[1], da));
}

const ACCENTS = {
  critical: dyn(HEX.critical), high: dyn(HEX.high),
  normal: dyn(HEX.normal), low: dyn(HEX.low),
};
const POSITIVE = dyn(HEX.positive);

function pairFor(card) {
  return HEX[String(card && card.urgency)] || HEX.normal;
}
function accentFor(card) {
  return ACCENTS[String(card && card.urgency)] || ACCENTS.normal;
}

/** Whichever half of a [light, dark] pair suits the current appearance. */
function forTheme(pair) {
  try { return Device.isUsingDarkAppearance() ? pair[1] : pair[0]; } catch (e) { return pair[0]; }
}

/**
 * SF Rounded where it exists. It is what makes an iOS widget read as designed
 * rather than typed — but the constructors are version-dependent, so every one
 * falls back rather than taking the widget down over a font.
 */
function font(size, weight) {
  const rounded = {
    regular: 'regularRoundedSystemFont',
    bold: 'semiboldRoundedSystemFont',
    heavy: 'boldRoundedSystemFont',
  }[weight] || 'regularRoundedSystemFont';
  try {
    if (typeof Font[rounded] === 'function') return Font[rounded](size);
  } catch (e) { /* fall through */ }
  return weight === 'heavy' ? Font.boldSystemFont(size)
    : weight === 'bold' ? Font.semiboldSystemFont(size)
      : Font.systemFont(size);
}

/**
 * A tiny bar chart of the week. Drawn rather than described, because "40 this
 * week" is a number and the SHAPE of the week is the thing worth seeing — the
 * 32-commit Thursday next to two quiet days says something the total cannot.
 *
 * Baked into an image, so it cannot be theme-dynamic; the colour is resolved
 * once against the current appearance.
 */
/**
 * A progress ring, drawn as segments around a circle.
 *
 * ⚠ It must read in MONOCHROME. iOS renders lock-screen accessory widgets with
 * a vibrancy tint, so hue is stripped — a green-vs-red ring would be one flat
 * colour there and say nothing. So the signal is FILL: a done segment is solid,
 * an outstanding one is faint. Colour is applied on top for the home screen,
 * where it survives, but nothing depends on it.
 *
 * Segments rather than an arc path deliberately: filled ellipses are the most
 * boring, best-supported thing DrawContext does, and a countable ring reads
 * better at 58pt than a smooth sweep anyway.
 *
 * `over` draws an INNER ring of the surplus — a second lap, which is the
 * honest picture of exceeding a target and needs no colour to be understood.
 */
function progressRing(size, done, target, pair) {
  try {
    const dc = new DrawContext();
    dc.size = new Size(size, size);
    dc.opaque = false;
    dc.respectScreenScale = true;

    const SEGMENTS = 24;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - size * 0.09;
    const dot = Math.max(2.5, size * 0.075);
    const ink = forTheme(pair);

    const capped = Math.max(0, Math.min(done, target));
    const filled = target > 0 ? Math.round((capped / target) * SEGMENTS) : 0;

    for (let i = 0; i < SEGMENTS; i++) {
      // Start at twelve o'clock and go clockwise, because that is how every
      // other progress ring on the phone behaves.
      const a = (i / SEGMENTS) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * r - dot / 2;
      const y = cy + Math.sin(a) * r - dot / 2;
      const isDone = i < filled;
      dc.setFillColor(new Color(ink, isDone ? 1 : 0.22));
      dc.fillEllipse(new Rect(x, y, dot, dot));
    }

    // The surplus, as a second lap on a tighter radius. Only ever drawn when
    // the target is genuinely beaten, so its presence IS the celebration.
    const over = Math.max(0, done - target);
    if (over > 0 && target > 0) {
      const overSegs = Math.min(SEGMENTS, Math.max(1, Math.round((over / target) * SEGMENTS)));
      const r2 = r - dot * 1.25;
      const dot2 = dot * 0.6;
      for (let i = 0; i < overSegs; i++) {
        const a = (i / SEGMENTS) * Math.PI * 2 - Math.PI / 2;
        const x = cx + Math.cos(a) * r2 - dot2 / 2;
        const y = cy + Math.sin(a) * r2 - dot2 / 2;
        dc.setFillColor(new Color(ink, 1));
        dc.fillEllipse(new Rect(x, y, dot2, dot2));
      }
    }
    return dc.getImage();
  } catch (e) {
    return null;
  }
}

/**
 * The same idea, laid flat: a segmented bar for the wide lock-screen widget,
 * where a ring would waste the width. Identical semantics — solid means done,
 * faint means outstanding, and a second row underneath means over target.
 */
function progressBar(width, height, done, target, pair) {
  try {
    const dc = new DrawContext();
    dc.size = new Size(width, height);
    dc.opaque = false;
    dc.respectScreenScale = true;

    const SEGMENTS = 20;
    const ink = forTheme(pair);
    const over = Math.max(0, done - target);
    const barH = over > 0 ? Math.max(2, height * 0.45) : height;
    const gap = 2;
    const segW = (width - gap * (SEGMENTS - 1)) / SEGMENTS;

    const capped = Math.max(0, Math.min(done, target));
    const filled = target > 0 ? Math.round((capped / target) * SEGMENTS) : 0;

    for (let i = 0; i < SEGMENTS; i++) {
      dc.setFillColor(new Color(ink, i < filled ? 1 : 0.22));
      dc.fillRect(new Rect(i * (segW + gap), 0, segW, barH));
    }

    if (over > 0 && target > 0) {
      const overSegs = Math.min(SEGMENTS, Math.max(1, Math.round((over / target) * SEGMENTS)));
      const y2 = barH + gap;
      for (let i = 0; i < overSegs; i++) {
        dc.setFillColor(new Color(ink, 1));
        dc.fillRect(new Rect(i * (segW + gap), y2, segW, Math.max(2, height - y2)));
      }
    }
    return dc.getImage();
  } catch (e) {
    return null;
  }
}

/** Which accent a target state earns. Fill carries the meaning; this is a bonus. */
function targetPair(t) {
  if (!t || !t.known) return HEX.low;
  if (t.state === 'exceeded') return HEX.positive;
  if (t.state === 'met') return HEX.positive;
  if (t.state === 'behind') return HEX.high;
  return HEX.normal;
}

function sparkline(values, width, height, pair) {
  try {
    const dc = new DrawContext();
    dc.size = new Size(width, height);
    dc.opaque = false;
    dc.respectScreenScale = true;

    const nums = values.map((v) => Math.max(0, Number(v) || 0));
    const max = Math.max(1, ...nums);
    const slot = width / Math.max(1, nums.length);
    const barW = Math.max(2, slot - 3);

    for (let i = 0; i < nums.length; i++) {
      // Every day gets a visible stub, so a zero day reads as "nothing that
      // day" rather than as a gap in the chart.
      const h = nums[i] === 0 ? 2 : Math.max(3, (nums[i] / max) * height);
      dc.setFillColor(new Color(forTheme(pair), nums[i] === 0 ? 0.25 : 1));
      dc.fillRect(new Rect(i * slot, height - h, barW, h));
    }
    return dc.getImage();
  } catch (e) {
    return null; // No chart is fine. A broken widget is not.
  }
}

// Type → SF Symbol. The fallback glyph matters: SFSymbol.named returns null for
// an unknown name and reading .image off null throws, which would take the whole
// widget down over an icon.
const ICONS = {
  meeting: ['calendar', '▣'],
  todo: ['checkmark.circle', '✓'],
  email: ['envelope', '✉'],
  escalation: ['exclamationmark.triangle.fill', '!'],
  'nova-flag': ['flag.fill', '⚑'],
  novaFlag: ['flag.fill', '⚑'],
  journal: ['book.closed', '❏'],
  standup: ['sun.max', '☀'],
  eod: ['moon.stars', '☾'],
  capture: ['tray', '▽'],
  waiting: ['hourglass', '⧗'],
  context: ['circle.dashed', '○'],
};

function bg(w) {
  const g = new LinearGradient();
  g.colors = [
    Color.dynamic(new Color('#ffffff'), new Color('#232325')),
    Color.dynamic(new Color('#f1f1f5'), new Color('#151517')),
  ];
  g.locations = [0, 1];
  w.backgroundGradient = g;
}

function text(stack, value, { size = 12, color = INK, weight = 'regular', max = 1 } = {}) {
  const t = stack.addText(String(value));
  t.font = font(size, weight);
  t.textColor = color;
  t.lineLimit = max;
  t.minimumScaleFactor = 0.9;
  return t;
}

/**
 * A rounded tile carrying the type icon, washed with the urgency accent.
 *
 * The wash is what makes colour legible at a glance: a coloured glyph on grey
 * is a detail, a coloured tile is a signal you read before the words.
 */
function tile(stack, type, pair, box) {
  const accent = dyn(pair);
  const t = stack.addStack();
  t.size = new Size(box, box);
  t.cornerRadius = box * 0.3;
  t.backgroundColor = dyn(pair, 0.12);
  t.centerAlignContent();

  const spec = ICONS[String(type)] || ['circle.fill', '•'];
  let sym = null;
  try { sym = SFSymbol.named(spec[0]); } catch (e) { sym = null; }

  if (sym) {
    const img = t.addImage(sym.image);
    img.imageSize = new Size(box * 0.55, box * 0.55);
    img.tintColor = accent;
    img.resizable = true;
  } else {
    text(t, spec[1], { size: box * 0.5, color: accent, weight: 'bold' });
  }
  return t;
}

/** A hairline, drawn as a 1px stack because Scriptable has no divider. */
function rule(stack, pad) {
  stack.addSpacer(pad);
  const r = stack.addStack();
  r.size = new Size(0, 1);
  r.backgroundColor = HAIRLINE;
  r.addSpacer();
  stack.addSpacer(pad);
}

/**
 * The header block: time and date on the left, weather on the right.
 *
 * The clock is a WidgetDate rather than a rendered string, so it stays right
 * between refreshes — a widget showing a stale time is worse than one showing
 * none, and iOS refreshes this on its own schedule, not ours.
 */
function header(w, ctxLabel, weather, alertPair) {
  const row = w.addStack();
  row.centerAlignContent();

  // Left: the clock, with the date beneath it.
  const left = row.addStack();
  left.layoutVertically();
  const clock = left.addDate(new Date());
  clock.applyTimeStyle();
  clock.font = font(26, 'heavy');
  clock.textColor = INK;
  left.addSpacer(1);
  const dateRow = left.addStack();
  dateRow.centerAlignContent();
  text(dateRow, new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long',
  }), { size: 11, color: MUTED });
  if (ctxLabel) {
    dateRow.addSpacer(7);
    // The context reads as a pill so it is obviously a STATE, not another item.
    const pill = dateRow.addStack();
    pill.cornerRadius = 7;
    pill.backgroundColor = alertPair ? dyn(alertPair, 0.16) : TILE_BG;
    pill.setPadding(2, 7, 2, 7);
    text(pill, ctxLabel, { size: 10, color: alertPair ? dyn(alertPair) : MUTED });
  }
  // ⚠ Restored after being dropped with the old SARA row. Without it, "is my
  // edit actually running?" is unanswerable — which cost a diagnostic round
  // trip once already, and cost another the day the row was removed.
  dateRow.addSpacer(7);
  text(dateRow, VERSION, { size: 9, color: MUTED });

  row.addSpacer();

  // Right: now, and the next thing that changes. Absent entirely rather than
  // guessed when the forecast could not be read.
  if (weather) {
    const right = row.addStack();
    right.layoutVertically();

    const nowRow = right.addStack();
    nowRow.centerAlignContent();
    nowRow.addSpacer();
    let sym = null;
    try { sym = SFSymbol.named(weather.symbol); } catch (e) { sym = null; }
    if (sym) {
      const img = nowRow.addImage(sym.image);
      img.imageSize = new Size(15, 15);
      img.tintColor = MUTED;
      img.resizable = true;
      nowRow.addSpacer(5);
    }
    text(nowRow, `${weather.now.temp}°`, { size: 19, weight: 'bold' });

    if (weather.next) {
      right.addSpacer(1);
      const nextRow = right.addStack();
      nextRow.addSpacer();
      text(nextRow, weather.next, { size: 10, color: MUTED });
    }
  } else {
    // Absent weather is indistinguishable from a design hole, and the cause is
    // almost always a denied Location permission — which is fixable, but only
    // if the widget says so.
    const right = row.addStack();
    right.layoutVertically();
    const r1 = right.addStack();
    r1.addSpacer();
    text(r1, 'No forecast', { size: 11, color: MUTED });
    const r2 = right.addStack();
    r2.addSpacer();
    text(r2, 'run the script, allow Location', { size: 9, color: MUTED });
  }

  w.addSpacer(12);
}

/**
 * One item. `primary` gets its own card surface and room for the full sentence;
 * the rest are compact rows, because the Surface's whole claim is that there is
 * ONE thing and then some context for it.
 */
function itemRow(container, card, { primary = false } = {}) {
  const pair = pairFor(card);
  const row = container.addStack();
  row.url = tabUrl(card.tab);
  row.centerAlignContent();

  if (primary) {
    row.backgroundColor = CARD;
    row.cornerRadius = 14;
    row.setPadding(11, 11, 11, 11);
    // A spine of the accent down the leading edge. It is what carries urgency
    // when the card is glanced at rather than read — and on `critical` it is the
    // only thing on screen that is fully saturated.
    const spine = row.addStack();
    spine.size = new Size(3, primary ? 34 : 20);
    spine.cornerRadius = 1.5;
    spine.backgroundColor = dyn(pair);
    row.addSpacer(10);
  }

  tile(row, card.type || card.kind, pair, primary ? 30 : 20);
  row.addSpacer(primary ? 11 : 9);

  const col = row.addStack();
  col.layoutVertically();
  text(col, card.title, {
    size: primary ? 15 : 12,
    weight: primary ? 'heavy' : 'bold',
    max: primary ? 2 : 1,
  });
  const detail = card.say || card.reason;
  if (detail) {
    col.addSpacer(primary ? 3 : 1);
    text(col, detail, { size: primary ? 12 : 10.5, color: MUTED, max: primary ? 2 : 1 });
  }
  row.addSpacer();
  return row;
}

/**
 * The four ways there is nothing to show, each said differently and each with
 * its own colour, so a glance tells them apart before the words are read.
 */
function silence(w, d, error) {
  const show = (symbol, pair, title, body) => {
    const row = w.addStack();
    row.backgroundColor = CARD;
    row.cornerRadius = 14;
    row.setPadding(12, 12, 12, 12);
    row.centerAlignContent();
    tile(row, symbol, pair, 30);
    row.addSpacer(11);
    const col = row.addStack();
    col.layoutVertically();
    text(col, title, { size: 15, weight: 'heavy', max: 1 });
    col.addSpacer(3);
    text(col, body, { size: 12, color: MUTED, max: 3 });
    row.addSpacer();
    w.url = tabUrl('surface');
  };

  if (error) {
    show('escalation', HEX.critical, "Can't reach NEURO", error);
    return true;
  }
  if (d.poolAvailable === false) {
    show('escalation', HEX.high, "Can't see your work",
      'This is not an all-clear — the queue could not be read.');
    return true;
  }
  if (!d.primary) {
    const ctx = d.context || {};
    if (d.quiet === true) {
      show('context', HEX.low, ctx.label || 'Quiet',
        ctx.summary || d.rationale || 'Nothing to raise right now.');
    } else {
      show('todo', HEX.positive, 'All clear', 'Nothing needs you at the moment.');
    }
    return true;
  }
  return false;
}

/**
 * The rest of the day.
 *
 * This is the half the attention feed deliberately does not carry: the pool is
 * things needing a DECISION, and a meeting you have already accepted is not one
 * of those. But "what is left today" is the single most glanceable fact a home
 * screen can hold, and without it the widget was three admin tasks and a lot of
 * black.
 *
 * ⚠ `known:false` is not an empty day — an unreadable diary says so rather than
 * rendering as a clear afternoon.
 */
function agenda(w, block, limit) {
  if (!block) return;

  if (block.known === false) {
    w.addSpacer(9);
    text(w, "Couldn't read the diary", { size: 10, color: dyn(HEX.high) });
    return;
  }

  const events = (block.events || []).slice(0, limit);
  if (!events.length) return;

  rule(w, 9);
  // The scope is named by the server, so the heading is never a second opinion
  // about which day these belong to.
  const heading = !block.scope || block.scope === 'today'
    ? 'REST OF TODAY'
    : String(block.scope).toUpperCase();
  text(w, heading, { size: 9, color: MUTED, weight: 'bold' });
  w.addSpacer(6);

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const row = w.addStack();
    row.centerAlignContent();

    const start = new Date(e.start);
    const hhmm = Number.isNaN(start.getTime()) ? '--:--'
      : `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;

    // A meeting in progress is a different fact from one coming up, and it is
    // the one worth colouring — it is happening to Nick right now.
    const live = e.running === true;
    text(row, hhmm, { size: 11, color: live ? dyn(HEX.high) : MUTED, weight: live ? 'bold' : 'regular' });
    row.addSpacer(9);
    text(row, e.subject || 'Untitled', { size: 12, weight: live ? 'bold' : 'regular', max: 1 });
    row.addSpacer();

    // The countdown, right-aligned. Recomputed from the start time by the
    // server on every build, so it cannot go stale the way a stored relative
    // time does.
    // ⚠ Test for null BEFORE coercing. Number(null) is 0 and Number.isFinite(0)
    // is true, so coercing first turns "no countdown, this is another day" into
    // a confident "0m" — which is precisely the wrong thing to say about a
    // meeting on Monday.
    const raw = e.minutesAway;
    const mins = raw === null || raw === undefined ? null : Number(raw);
    let chip = null;
    if (live) chip = 'now';
    else if (mins !== null && Number.isFinite(mins)) {
      chip = mins < 60 ? `${mins}m` : `${Math.round(mins / 60)}h`;
    }
    if (chip) {
      const pill = row.addStack();
      pill.cornerRadius = 6;
      pill.backgroundColor = live ? dyn(HEX.high, 0.16) : TILE_BG;
      pill.setPadding(1, 6, 1, 6);
      text(pill, chip, { size: 10, color: live ? dyn(HEX.high) : MUTED, weight: 'bold' });
    }
    if (i < events.length - 1) w.addSpacer(6);
  }
}

/**
 * What got done today. The bottom of a large widget was empty by early evening
 * — the agenda runs out, the pool is small — and this is the one fact that is
 * always available and always worth seeing.
 *
 * Deliberately the wins LEDGER rather than a count of ticked boxes: it was
 * built because self-report starves, and a home screen is where it finally gets
 * seen. Zero is rendered honestly; there is no encouraging version of an empty
 * day, and inventing one is the register sara-voice rejects.
 */
function winsStrip(w, wins) {
  if (!wins) return;
  const done = Number(wins.doneToday);
  if (!Number.isFinite(done)) return;

  w.addSpacer(9);
  const row = w.addStack();
  row.centerAlignContent();
  tile(row, 'todo', done > 0 ? HEX.positive : HEX.low, 15);
  row.addSpacer(6);
  text(row, done === 0 ? 'Nothing logged today'
    : done === 1 ? '1 done today' : `${done} done today`,
    { size: 11, color: done > 0 ? dyn(HEX.positive) : MUTED, weight: 'bold' });

  const week = Number(wins.doneThisWeek);
  if (Number.isFinite(week) && week > done) {
    row.addSpacer(7);
    text(row, `${week} this week`, { size: 10, color: MUTED });
  }
  row.addSpacer();

  // A ledger that could not be read is NOT a day with nothing in it.
  const gaps = Array.isArray(wins.gaps) ? wins.gaps.length : 0;
  if (gaps) text(row, `${gaps} unread`, { size: 9, color: dyn(HEX.high) });
}

/** Held-back and unreadable counts. Never a bare number, never swallowed. */
function footer(w, d) {
  const dropped = Array.isArray(d.dropped) ? d.dropped.length : 0;
  const gaps = Array.isArray(d.gaps) ? d.gaps.length : 0;
  if (!dropped && !gaps) return;

  w.addSpacer(7);
  const row = w.addStack();
  row.centerAlignContent();
  if (dropped) {
    tile(row, 'waiting', HEX.low, 13);
    row.addSpacer(5);
    text(row, `${dropped} held back`, { size: 10, color: MUTED });
  }
  if (dropped && gaps) {
    row.addSpacer(8);
  }
  if (gaps) {
    // A gap is not a held item — it is something NEURO could not read at all,
    // and it is the one number on this widget that should look slightly wrong.
    tile(row, 'escalation', HEX.high, 13);
    row.addSpacer(5);
    text(row, `${gaps} unreadable`, { size: 10, color: ACCENTS.high });
  }
  row.addSpacer();
}

/**
 * The off-duty view: what you DID, not what you owe.
 *
 * A task list on a Saturday is the thing this whole feature exists to avoid —
 * and the wins ledger was built precisely because the reward surface was
 * starved while the nagging surfaces were not.
 */
function offDutyView(w, duty, wins) {
  const row = w.addStack();
  row.backgroundColor = CARD;
  row.cornerRadius = 14;
  row.setPadding(12, 12, 12, 12);
  row.centerAlignContent();

  // Prefer the week on a day off: `headline` describes TODAY and correctly
  // returns null on zero, which a Saturday usually is. A week's total is the
  // honest number to lead with, and there is no cheerful version of an empty one.
  const week = wins && Number.isFinite(Number(wins.doneThisWeek)) ? Number(wins.doneThisWeek) : null;
  const today = wins && Number.isFinite(Number(wins.doneToday)) ? Number(wins.doneToday) : null;

  const title = week ? `${week} finished this week`
    : today ? wins.headline
      : 'Off duty';

  tile(row, 'todo', week || today ? HEX.positive : HEX.low, 30);
  row.addSpacer(11);
  const col = row.addStack();
  col.layoutVertically();
  text(col, title, { size: 15, weight: 'heavy', max: 2 });
  col.addSpacer(3);
  text(col, duty.reason || 'Not a working day.', { size: 12, color: MUTED, max: 2 });
  row.addSpacer();

  // The week, drawn. "40 this week" is a number; the SHAPE is the thing worth
  // seeing — a 32-commit Thursday beside two quiet days says something a total
  // cannot. Falls back to nothing at all rather than to a fake chart.
  const last7 = Array.isArray(wins && wins.last7) ? wins.last7 : [];
  if (last7.length) {
    w.addSpacer(9);
    const chart = sparkline(last7.map((d) => d.done), 130, 24, HEX.positive);
    if (chart) {
      const strip = w.addStack();
      strip.centerAlignContent();
      const img = strip.addImage(chart);
      img.imageSize = new Size(130, 24);
      strip.addSpacer(9);
      const col = strip.addStack();
      col.layoutVertically();
      text(col, 'last 7 days', { size: 9, color: MUTED });
      const best = Math.max(0, ...last7.map((x) => Number(x.done) || 0));
      if (best) text(col, `best ${best}`, { size: 9, color: MUTED });
      strip.addSpacer();
    }
  }

  // The week's shape, by where the evidence came from. Only what the ledger
  // actually holds — no invented categories, and nothing at all if it is empty.
  const sources = wins && wins.bySource && typeof wins.bySource === 'object'
    ? Object.entries(wins.bySource).filter(([, n]) => Number(n) > 0).slice(0, 4)
    : [];
  if (sources.length) {
    w.addSpacer(9);
    const strip = w.addStack();
    strip.centerAlignContent();
    for (let i = 0; i < sources.length; i++) {
      if (i) strip.addSpacer(10);
      text(strip, String(sources[i][1]), { size: 12, weight: 'bold', color: POSITIVE });
      strip.addSpacer(3);
      text(strip, sources[i][0], { size: 10, color: MUTED });
    }
    strip.addSpacer();
  }

  if (!wins) {
    w.addSpacer(7);
    // "We couldn't read the ledger" is not "you did nothing" — the distinction
    // this whole codebase keeps insisting on, and never more worth keeping than
    // on the one screen meant to be encouraging.
    text(w, "Couldn't read the wins ledger.", { size: 10, color: MUTED });
  }

  w.url = tabUrl('today');
}

/**
 * Lock screen. A different medium, not a smaller version of the same one.
 *
 * The system renders these MONOCHROME and tints them itself, so the whole
 * accent scheme is meaningless here — urgency has to survive in the words. It
 * also paints its own background, so anything we draw behind is wrong.
 *
 * The budget is roughly two short lines, which suits the Surface exactly: one
 * thing, said in a sentence. Secondary items are dropped rather than crammed —
 * an unreadable lock screen is worse than a blank one.
 */
function accessoryView(family, res, d, wins, target) {
  const w = new ListWidget();
  // Fully transparent — the system paints the lock screen's own material behind
  // this, so any ground of ours would sit on top of it as a grey slab.
  w.backgroundColor = new Color('#000000', 0);
  w.setPadding(2, 2, 2, 2);

  const ctx = d.context || {};
  const duty = ctx.duty;
  const offDuty = !res.error && duty && duty.known && duty.onDuty === false;
  const onFire = d.primary && d.primary.urgency === 'critical';

  // ⚠ The head line names the SITUATION, never "SARA · <state>".
  // It read "SARA · off" on a Saturday and Nick had to ask what it meant — the
  // label described HIM but was attached to HER name, so the natural reading is
  // "SARA is switched off", i.e. broken. On a lock screen there is no room to
  // recover from a misread, so the state says itself.
  let head = 'SARA';
  let body;
  if (res.error) { head = "CAN'T REACH NEURO"; body = res.error; }
  else if (d.poolAvailable === false) { head = "CAN'T SEE YOUR WORK"; body = 'This is not an all-clear.'; }
  else if (offDuty && !onFire) {
    const week = wins && Number(wins.doneThisWeek);
    // The reason IS the headline on a day off: "weekend" and "annual leave"
    // license the same behaviour but are not the same fact, and both are more
    // use than the word "off".
    head = String(duty.reason || 'off duty').replace('.', '').toUpperCase();
    body = week ? `${week} finished this week.` : 'Nothing needs you.';
  } else if (!d.primary) {
    head = ctx.label ? String(ctx.label).toUpperCase() : 'NOTHING PENDING';
    body = d.quiet ? (ctx.summary || 'Nothing to raise.') : 'Nothing needs you.';
  } else {
    head = ctx.label ? String(ctx.label).toUpperCase() : 'SARA';
    // `say` is a full sentence written for a human; the title is a fragment.
    // On two lines the sentence wins.
    body = d.primary.say || d.primary.title;
  }

  if (family === 'accessoryInline') {
    // One line, beside the clock. No room for a label.
    text(w, body, { size: 12, max: 1 });
    w.url = tabUrl(d.primary ? d.primary.tab : 'surface');
    return w;
  }

  if (family === 'accessoryCircular') {
    // The week's task target as a ring, with the count inside it. A bare number
    // has no denominator — 28 is only good or bad against something.
    const t = target;
    if (t && t.known && t.target) {
      const img = progressRing(58, t.done, t.target, targetPair(t));
      if (img) w.backgroundImage = img;
      const stack = w.addStack();
      stack.layoutVertically();
      stack.centerAlignContent();
      text(stack, String(t.done), { size: 17, weight: 'heavy', max: 1 });
      text(stack, `of ${t.target}`, { size: 8, max: 1 });
      w.url = tabUrl('tasks');
      return w;
    }

    // No target set, or the ledger could not be read. Both render the honest
    // thing rather than an empty ring, which would read as "you have done none".
    const n = t && t.known && Number.isFinite(t.done)
      ? t.done
      : (d.primary ? 1 : 0) + ((d.secondary || []).length);
    const label = t && t.known && Number.isFinite(t.done) ? 'done' : 'now';
    const stack = w.addStack();
    stack.layoutVertically();
    stack.centerAlignContent();
    text(stack, t && !t.known ? '?' : String(n), { size: 19, weight: 'heavy', max: 1 });
    text(stack, t && !t.known ? 'no data' : label, { size: 8, max: 1 });
    w.url = tabUrl(offDuty ? 'today' : 'surface');
    return w;
  }

  // accessoryRectangular — three short lines, and the third is what makes it
  // worth a lock-screen slot: what is actually COMING. A line repeating what
  // the home-screen widget already says is a wasted row.
  text(w, head, { size: 11, weight: 'bold', max: 1 });
  text(w, body, { size: 13, max: 1 });

  const t = target;
  if (t && t.known && t.target) {
    const bar = progressBar(120, 9, t.done, t.target, targetPair(t));
    const row = w.addStack();
    row.centerAlignContent();
    if (bar) {
      const img = row.addImage(bar);
      img.imageSize = new Size(120, 9);
      row.addSpacer(7);
    }
    // The words carry the state, because the bar cannot: a lock screen strips
    // colour, so "behind" and "on track" look identical without them.
    const tail = t.state === 'exceeded' ? `${t.done}/${t.target} +${t.over}`
      : t.state === 'met' ? `${t.done}/${t.target} done`
      : t.state === 'behind' ? `${t.done}/${t.target} behind`
      : `${t.done}/${t.target}`;
    text(row, tail, { size: 10, weight: 'bold', max: 1 });
    row.addSpacer();
    w.url = tabUrl('tasks');
    return w;
  }

  const ag = d.agenda;
  if (ag && ag.known && Array.isArray(ag.events) && ag.events.length) {
    const e = ag.events[0];
    const start = new Date(e.start);
    const hhmm = Number.isNaN(start.getTime()) ? ''
      : `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
    // Name the day unless it is today, or a Monday meeting reads as imminent.
    const when = !ag.scope || ag.scope === 'today'
      ? hhmm
      : `${String(ag.scope).slice(0, 3)} ${hhmm}`;
    text(w, `${when} ${e.subject || ''}`.trim(), { size: 11, max: 1 });
  }

  w.url = tabUrl(d.primary && !offDuty ? d.primary.tab : offDuty ? 'today' : 'surface');
  return w;
}

function build(res, family, wins, weather, target) {
  const d0 = res.data || {};
  if (String(family).startsWith('accessory')) {
    return accessoryView(family, res, d0, wins, target);
  }

  const w = new ListWidget();
  bg(w);
  w.setPadding(14, 14, 14, 14);
  // Tell iOS when this is worth refreshing. It is a hint, not a promise — the
  // system budgets widget refreshes and will ignore this when it wants to.
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  const d = res.data || {};
  const ctx = d.context || {};
  const bad = res.error ? HEX.critical : d.poolAvailable === false ? HEX.high : null;

  // When the context IS the answer — a context card, a silence, or a failure —
  // the headline already says it, and repeating it in the pill puts the same
  // words on screen twice ("In a meeting" above "In a meeting"). The pill only
  // earns its place when it is framing something else.
  const contextIsTheAnswer = !!res.error
    || d.poolAvailable === false
    || !d.primary
    || d.primary.kind === 'context';
  header(w, contextIsTheAnswer ? null : ctx.label, weather, bad);

  // Off duty: show what he did, not what he owes. ⚠ Except when something is
  // genuinely on fire — hiding a breaching escalation because it is Saturday is
  // the wrong failure, and `context-state` already treats a live work signal on
  // a non-working day as a contradiction rather than an all-clear.
  const duty = ctx.duty;
  const onFire = d.primary && d.primary.urgency === 'critical';
  if (!res.error && duty && duty.known && duty.onDuty === false && !onFire) {
    offDutyView(w, duty, wins);
    // The next working day still belongs here. On a Friday evening or a weekend
    // "what is coming" is the most useful thing on the screen, and without it
    // the off-duty view is one line and a chart in a large black rectangle.
    if (family === 'large' || family === 'medium') agenda(w, d.agenda, family === 'large' ? 4 : 2);
    w.addSpacer();
    return w;
  }

  // Trailing spacer on EVERY path, or a short render floats in the vertical
  // middle of a large widget with dead space above and below it.
  if (silence(w, d, res.error)) { w.addSpacer(); return w; }

  itemRow(w, d.primary, { primary: true });

  const room = family === 'large' ? 4 : family === 'medium' ? 2 : 0;
  const rest = (d.secondary || []).slice(0, room);
  if (rest.length) {
    rule(w, 9);
    for (let i = 0; i < rest.length; i++) {
      itemRow(w, rest[i]);
      if (i < rest.length - 1) w.addSpacer(7);
    }
  }

  // Only the large family has the height for the day's shape; on medium the
  // three attention rows already fill it, and a cramped agenda is worse than none.
  if (family === 'large') {
    agenda(w, d.agenda, 4);
    winsStrip(w, wins);
  }

  footer(w, d);
  w.addSpacer();
  w.url = tabUrl(d.primary.tab);
  return w;
}

// ── Entry ───────────────────────────────────────────────────────────────────

// Manual run: update first, so the next widget refresh renders the new code.
// The widget path never does this — see selfUpdate's warning.
let updateNote = null;
if (config.runsInApp) updateNote = await selfUpdate();

const cfg = await loadConfig();
const family = config.runsInWidget ? config.widgetFamily : 'large';
const isAccessory = String(family).startsWith('accessory');

// Attention and weather are independent, so they go out together rather than
// one after the other — a widget refresh is on a budget.
const [res, weather] = await Promise.all([
  fetchAttention(cfg),
  isAccessory ? Promise.resolve(null) : fetchWeather(),
]);

// Only spend a second request when the brain has actually said he is off duty.
const duty = res.data && res.data.context && res.data.context.duty;
const offDuty = !res.error && duty && duty.known && duty.onDuty === false;
// Off duty the wins ARE the view; on large they fill the strip at the bottom.
// Anywhere else it would be a request bought for nothing.
const needWins = !res.error && (offDuty || family === 'large');
// The ring belongs to the lock screen and the large tile. Anywhere else it
// would be a request bought for nothing.
const needTarget = !res.error && (isAccessory || family === 'large');
const [wins, target] = await Promise.all([
  needWins ? fetchWins(cfg) : Promise.resolve(null),
  needTarget ? fetchTarget(cfg) : Promise.resolve(null),
]);

const widget = build(res, family, wins, weather, target);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  // Say out loud what the update did. "Nothing changed" is the one outcome that
  // must not be silent, because it is indistinguishable from a broken edit.
  if (updateNote === 'updated') {
    const a = new Alert();
    a.title = 'Script updated';
    a.message = `Pulled the latest from GitHub. Running ${VERSION} — close and reopen this script to run the new code, then the widget will pick it up on its next refresh.`;
    a.addAction('OK');
    await a.present();
  } else if (updateNote && updateNote.startsWith('failed')) {
    const a = new Alert();
    a.title = 'Update check failed';
    a.message = `${updateNote}. Running the copy already on the phone (${VERSION}).`;
    a.addAction('OK');
    await a.present();
  }
  await widget.presentLarge();
}
Script.complete();
