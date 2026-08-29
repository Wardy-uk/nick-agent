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
const VERSION = 'v25';
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

/**
 * Open PERSONAL tasks. Fetched only when off duty: on a working day they are
 * deliberately not what the widget is for.
 */
async function fetchPersonal({ base, token }) {
  try {
    const req = new Request(`${base}/api/tasks?domain=personal&status=open`);
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
  if (!t || t.state === 'unknown' || t.state === 'unset') return HEX.low;
  if (t.state === 'exceeded') return HEX.positive;
  if (t.state === 'met') return HEX.positive;
  if (t.state === 'behind') return HEX.high;
  return HEX.normal;
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

/**
 * SARA, saying one thing.
 *
 * ── Why this replaced a dashboard ────────────────────────────────────────────
 * The widget had become a board: rings, bars, counts, rows of icons. All of it
 * true, none of it HER. Nick's correction was one line — "the main widget
 * should BE SARA" — and it is the same thing CLAUDE.md already says: she is the
 * J.A.R.V.I.S. layer, voice and eyes, and should NOT be a menu.
 *
 * So the tile is a sentence. `speech` is composed on the SERVER and is
 * literally what she would say aloud; rendering it is how the widget, the
 * notification and the spoken briefing stay one voice instead of three.
 *
 * ⚠ It NEVER writes her lines. When `speech` is null — she is quiet, which is
 * a correct answer and most of a calm day — it falls back to the context
 * summary she already composed, and failing that says nothing at all rather
 * than inventing something for her to say. A widget that puts words in SARA's
 * mouth is worse than a blank one.
 *
 * Everything the old layout shouted is demoted to ONE quiet footer line: it is
 * ambient, and she is not.
 */
function saraSays(w, d, res, target, weather, family, personal) {
  const ctx = d.context || {};
  const big = family === 'large';

  // Who is talking, and when. Small, because the sentence is the point.
  const head = w.addStack();
  head.centerAlignContent();
  const dotPair = res.error ? HEX.critical
    : d.poolAvailable === false ? HEX.high
      : d.primary && d.primary.urgency === 'critical' ? HEX.critical
        : HEX.normal;
  tile(head, 'context', dotPair, 15);
  head.addSpacer(7);
  text(head, 'SARA', { size: 11, weight: 'bold', color: MUTED });
  head.addSpacer();
  const clock = head.addDate(new Date());
  clock.applyTimeStyle();
  clock.font = font(12, 'bold');
  clock.textColor = MUTED;
  head.addSpacer(6);
  text(head, VERSION, { size: 9, color: MUTED });

  // Worked out BEFORE anything is drawn, because both the body and the footer
  // depend on it.
  const duty = ctx.duty;
  const offDuty = !res.error && duty && duty.known && duty.onDuty === false;

  w.addSpacer(big ? 16 : 10);

  // What she says. Her words, never ours.
  let line = null;
  if (res.error) line = "I can't reach the brain right now.";
  else if (d.poolAvailable === false) line = "I can't see your work at the moment — don't take that as an all-clear.";
  else line = d.speech || ctx.summary || (d.primary ? (d.primary.say || d.primary.title) : null);

  if (line) {
    text(w, line, { size: big ? 20 : 15, weight: 'bold', max: big ? 6 : 4 });
  } else {
    // Genuinely nothing, and she says so plainly rather than going blank.
    text(w, 'Nothing needs you.', { size: big ? 20 : 15, weight: 'bold', color: MUTED, max: 2 });
  }

  // The next thing. ⚠ The AGENDA ITSELF is domain-switched on the server — off
  // duty it carries only his own diary — so this renders whichever is his right
  // now. That is why it no longer has to be suppressed off duty: what used to
  // leak was "Next: Weekly reporting, Monday 10:00" on a Saturday, and the fix
  // was the source of the list, not hiding the line.
  if (big) {
    const ag = d.agenda;
    const next = ag && ag.known && Array.isArray(ag.events) && ag.events.length ? ag.events[0] : null;
    if (next) {
      const start = new Date(next.start);
      const hhmm = Number.isNaN(start.getTime()) ? ''
        : `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
      const day = !ag.scope || ag.scope === 'today'
        ? 'today'
        : `${String(ag.scope).charAt(0).toUpperCase()}${String(ag.scope).slice(1)}`;
      // An all-day event is named by its DAY, never by a clock reading it does
      // not have — "hiking at 00:00" is a placeholder presented as a fact.
      const when = next.allDay
        ? (day === 'today' ? 'all day' : `${day}, all day`)
        : (day === 'today' ? `at ${hhmm}` : `${day} ${hhmm}`);
      w.addSpacer(10);
      text(w, `Next: ${next.subject || 'something'} — ${when}.`, { size: 13, color: MUTED, max: 2 });
    }
  }

  w.addSpacer();

  // ── The quiet footer ──────────────────────────────────────────────────────
  // Everything the dashboard version shouted, said once and small. Ambient
  // context belongs under her, not around her.
  const foot = w.addStack();
  foot.centerAlignContent();

  // ⚠ The footer follows the CONTEXT, which is Nick's ask: work data while he is
  // working, personal while he is not. Off duty his week's work target is not
  // what he wants read back at him.
  const bits = [];
  if (offDuty) {
    const open = personal && Array.isArray(personal.tasks) ? personal.tasks.length : null;
    // Only when there ARE some — every task in the store is still `work`, so a
    // permanent "0 personal" would be an empty box wearing a number.
    if (open) bits.push(open === 1 ? '1 personal task' : `${open} personal tasks`);
  } else if (target && target.state !== 'unknown' && target.target) {
    bits.push(`${target.done} of ${target.target} this week`);
  } else if (target && target.state === 'unset' && Number.isFinite(target.done)) {
    bits.push(`${target.done} done this week`);
  }
  if (weather) bits.push(`${weather.now.temp}°`);
  if (bits.length) text(foot, bits.join('  ·  '), { size: 11, color: MUTED, max: 1 });
  foot.addSpacer();

  // Held and unreadable still get said — quietly, but never swallowed.
  // ⚠ Except off duty, where they are work too. "3 held" on a Saturday is the
  // same intrusion as naming Monday's first meeting, just in smaller type.
  const dropped = !offDuty && Array.isArray(d.dropped) ? d.dropped.length : 0;
  const gaps = !offDuty && Array.isArray(d.gaps) ? d.gaps.length : 0;
  if (dropped || gaps) {
    const notes = [];
    if (dropped) notes.push(`${dropped} held`);
    if (gaps) notes.push(`${gaps} unread`);
    text(foot, notes.join(' · '), { size: 10, color: gaps ? dyn(HEX.high) : MUTED, max: 1 });
  }

  w.url = tabUrl(d.primary ? d.primary.tab : 'surface');
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
    if (t && t.state !== 'unknown' && t.target) {
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
    const blind = t && t.state === 'unknown';
    const n = !blind && t && Number.isFinite(t.done)
      ? t.done
      : (d.primary ? 1 : 0) + ((d.secondary || []).length);
    const label = !blind && t && Number.isFinite(t.done) ? 'done' : 'now';
    const stack = w.addStack();
    stack.layoutVertically();
    stack.centerAlignContent();
    text(stack, blind ? '?' : String(n), { size: 19, weight: 'heavy', max: 1 });
    text(stack, blind ? 'no data' : label, { size: 8, max: 1 });
    w.url = tabUrl(offDuty ? 'today' : 'surface');
    return w;
  }

  // accessoryRectangular — three short lines, and the third is what makes it
  // worth a lock-screen slot: what is actually COMING. A line repeating what
  // the home-screen widget already says is a wasted row.
  text(w, head, { size: 11, weight: 'bold', max: 1 });
  text(w, body, { size: 13, max: 1 });

  const t = target;
  if (t && t.state !== 'unknown' && t.target) {
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

function build(res, family, wins, weather, target, personal) {
  const d0 = res.data || {};
  if (String(family).startsWith('accessory')) {
    return accessoryView(family, res, d0, wins, target);
  }

  const w = new ListWidget();
  bg(w);
  w.setPadding(15, 15, 15, 15);
  // A hint, not a promise — iOS budgets widget refreshes and ignores this when
  // it wants to.
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  // One thing, in her voice. saraSays draws its own header and footer; there is
  // no second layout to fall through to, because a dashboard IS the thing this
  // replaced.
  saraSays(w, d0, res, target, weather, family, personal);
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
const [wins, personal] = await Promise.all([
  needWins ? fetchWins(cfg) : Promise.resolve(null),
  // Personal tasks matter only off duty, and only where there is room to show them.
  (offDuty && !isAccessory) ? fetchPersonal(cfg) : Promise.resolve(null),
]);

// The target rides on the attention payload already — composed server-side with
// its own words, like `say` and `speech`. A second request would be a second
// opinion about the same week.
const target = res.data ? res.data.weeklyTarget : null;

const widget = build(res, family, wins, weather, target, personal);

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
