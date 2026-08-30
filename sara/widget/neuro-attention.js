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
// 4. To SWIPE between work and personal: add a SECOND NEURO widget, drag it on
//    top of the first to make a stack, and set the second one's Parameter to
//    `flip` (long-press, Edit Widget, Parameter). Leave the first blank.
//    The top card then follows the context and one swipe shows the other side.
//    iOS provides the swipe — a widget cannot detect a gesture itself.
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

/**
 * Which view this instance shows.
 *
 * ⚠ iOS widgets cannot be swiped internally — WidgetKit renders a still, and
 * there is no gesture inside it. What CAN be swiped is a SMART STACK: several
 * widgets in one slot, swiped between by the system. So "swipeable" is two
 * instances of this script in a stack, each pinned to a side of the split, and
 * Scriptable tells them apart by the per-instance widget parameter.
 *
 *   (empty)   follow the brain — work in hours, personal outside them
 *   flip      always the OTHER side of whatever the brain just decided
 *   work      always the working view
 *   personal  always his own
 *
 * `flip` is what makes a stack behave the way Nick asked for: the top card
 * follows the context, the one beneath is always the other half. iOS provides
 * the swipe — a widget cannot detect a gesture itself, in any app.
 *
 * Set it by long-pressing the widget, Edit Widget, Parameter.
 *
 * Anything unrecognised falls back to `auto` rather than erroring: a typo in a
 * text field should cost the pin, not the widget.
 */
function widgetView() {
  try {
    const raw = String(args.widgetParameter || '').trim().toLowerCase();
    return ['work', 'personal', 'flip'].indexOf(raw) !== -1 ? raw : 'auto';
  } catch (e) {
    return 'auto';
  }
}

const KEY_URL = 'neuro_base_url';
const KEY_TOKEN = 'neuro_api_token';
const DEFAULT_URL = 'https://pi5.tailecb90f.ts.net';
const APP_URL = 'https://sara.nickward.co.uk';
const TIMEOUT_SECONDS = 12;

// Bumped by hand on every change. It is rendered on the widget so "did my edit
// actually land?" is answerable at a glance instead of by guessing — the whole
// reason this and the self-update below exist.
const VERSION = 'v32';
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

async function fetchAttention({ base, token }, view) {
  if (!token) return { error: 'Not set up yet — open the NEURO script once.' };
  try {
    // The view is sent so the SERVER picks the matching diary. Without it a
    // pinned personal card would show work meetings under a personal heading,
    // which is the thing the domain split exists to prevent.
    const q = view && view !== 'auto' ? `?view=${encodeURIComponent(view)}` : '';
    const req = new Request(`${base}/api/attention${q}`);
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

/**
 * Is today one to be outside for?
 *
 * Deterministic, and deliberately modest about what it claims: it reads the
 * next eight hours of the forecast and nothing else. It does not know whether
 * Nick has a coat, and it never tells him what to do — it says what the sky is
 * doing and leaves the decision where it belongs.
 *
 * The wet-hour threshold matches `fetchWeather`'s own "next" rule (40%), so the
 * strip and the sentence above it cannot disagree about whether it is going to
 * rain.
 */
function judgeDay(now, hours) {
  if (!hours || !hours.length) return null;

  const wet = hours.filter((h) => h.pop >= 40);
  const temps = hours.map((h) => h.temp).filter((t) => Number.isFinite(t));
  const high = temps.length ? Math.max(...temps) : now.temp;
  const cold = high <= 8;
  const firstWet = wet.length ? wet[0] : null;

  // `outdoor` is the verdict; `why` is the evidence for it, said plainly.
  if (!wet.length && !cold) {
    return { outdoor: true, verdict: 'A day to be out', why: `dry, up to ${high}°` };
  }
  if (!wet.length && cold) {
    return { outdoor: true, verdict: 'Dry but cold', why: `${high}° at best` };
  }
  if (wet.length >= Math.ceil(hours.length * 0.6)) {
    return { outdoor: false, verdict: 'An indoor day', why: `rain most of it, ${high}°` };
  }
  const hh = `${String(firstWet.at.getHours()).padStart(2, '0')}:00`;
  return {
    outdoor: true,
    verdict: 'Get out before the rain',
    why: `dry until about ${hh}, ${high}°`,
  };
}

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

    // The hours themselves, for the day strip. Kept from the same response
    // rather than fetched twice.
    const hours = idxs.slice(0, 8).map((i) => ({
      at: new Date(times[i]),
      temp: Math.round(Number(temps[i])),
      pop: Math.round(Number(pops[i])) || 0,
      code: Number(codes[i]),
    }));

    return {
      now,
      next,
      hours,
      day: judgeDay(now, hours),
      label: wmo(now.code)[1],
      symbol: wmo(now.code)[0],
    };
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

/**
 * The Field — SARA's presence, as a still.
 *
 * ⚠ NOT an orb. `sara/app/src/components/Field.jsx` and MANIFESTATION.md
 * deprecate every avatar, glyph and single bright point permanently: she is not
 * an object, and there is no "where SARA is". What you see is Nick's vault as a
 * noisy substrate with SARA visible only as ENTROPY FALLING — jitter collapsing
 * toward a seed, latent edges firming up.
 *
 * A widget cannot animate, so it renders ONE FRAME — and that is not a
 * compromise, because the app's own rule is that THE COHERENCE ON SCREEN IS THE
 * COHERENCE OF THE READ. A still frame carries that perfectly:
 *
 *   pool unreadable → no coherence at all; pure noise, no edges
 *   low confidence  → barely settled, edges faint
 *   high confidence → a clean, connected mesh
 *   quiet           → the same picture, dimmed right back
 *
 * So the background is informative before a word of it is read, and it is never
 * decoration: with nothing to say, there is nothing to see.
 *
 * Density, edge distance, clustering and colours are taken from Field.jsx
 * deliberately, so the widget and the phone are visibly the same entity.
 */
function field(width, height, drive) {
  try {
    const dc = new DrawContext();
    dc.size = new Size(width, height);
    dc.opaque = false;
    dc.respectScreenScale = true;

    const area = width * height;
    // Per AREA, not a fixed count — Field.jsx's own lesson, where 230 hardcoded
    // nodes vanished on anything wider than a phone.
    const nodeCount = Math.max(40, Math.min(260, Math.round(area / 900)));
    const seedCount = Math.max(4, Math.min(14, Math.round(area / 9000)));
    const EDGE_DIST_SQ = 2100;

    const depth = Math.max(0, Math.min(1, drive.depth));
    const dim = Math.max(0, Math.min(1, drive.dim));

    // Seeds land freely rather than on a grid: an even scatter reads as
    // wallpaper, the lumpy one reads as a mind.
    const seeds = [];
    for (let s = 0; s < seedCount; s++) {
      seeds.push({ x: Math.random() * width, y: Math.random() * height });
    }

    const nodes = [];
    for (let i = 0; i < nodeCount; i++) {
      const seed = seeds[i % seeds.length];
      const spread = 30 + Math.random() * 56;
      // `depth` IS the settle: the more the brain has resolved, the closer each
      // node sits to its cluster. At depth 0 nothing has collapsed at all.
      const pull = 1 - depth * 0.55;
      nodes.push({
        x: seed.x + (Math.random() - 0.5) * spread * 2 * pull,
        y: seed.y + (Math.random() - 0.5) * spread * 2 * pull,
      });
    }

    // Latent edges, drawn only as far as the read has actually settled.
    if (depth > 0.02) {
      dc.setLineWidth(0.6);
      for (let a = 0; a < nodes.length; a++) {
        for (let b = a + 1; b < nodes.length; b++) {
          const dx = nodes[a].x - nodes[b].x;
          const dy = nodes[a].y - nodes[b].y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= EDGE_DIST_SQ) continue;
          const near = 1 - d2 / EDGE_DIST_SQ;
          dc.setStrokeColor(new Color('#78aaeb', 0.30 * near * depth * dim));
          const p = new Path();
          p.move(new Point(nodes[a].x, nodes[a].y));
          p.addLine(new Point(nodes[b].x, nodes[b].y));
          dc.addPath(p);
          dc.strokePath();
        }
      }
    }

    for (const n of nodes) {
      dc.setFillColor(new Color('#96bef0', (0.10 + 0.26 * depth) * dim));
      dc.fillEllipse(new Rect(n.x - 1, n.y - 1, 2, 2));
    }
    return dc.getImage();
  } catch (e) {
    return null; // No field is fine. A broken widget is not.
  }
}

/**
 * How the read becomes a picture. Lifted from Field.jsx's `drive()` rather than
 * re-invented, so the phone and the widget cannot disagree about what a given
 * state looks like.
 */
function fieldDrive(d, res) {
  if (res.error || d.poolAvailable === false) return { depth: 0, dim: 0.85 };
  const ctx = d.context || {};
  if (d.quiet === true) return { depth: 0.35, dim: 0.45 };
  const level = ctx.confidence ? ctx.confidence.level : null;
  const depth = level === 'high' ? 1 : level === 'moderate' ? 0.7 : 0.34;
  return { depth, dim: 1 };
}

/**
 * A readiness dial: an arc of segments with the number inside it.
 *
 * Segments rather than a stroked arc for the same reason progressRing uses
 * them — filled ellipses are the best-supported thing DrawContext does — and a
 * countable dial reads better small than a smooth sweep.
 */
function dial(size, fraction, pair) {
  try {
    const dc = new DrawContext();
    dc.size = new Size(size, size);
    dc.opaque = false;
    dc.respectScreenScale = true;

    const SEG = 28;
    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - size * 0.10;
    const dot = Math.max(2.2, size * 0.072);
    const ink = forTheme(pair);
    const f = Math.max(0, Math.min(1, fraction));
    const filled = Math.round(f * SEG);

    for (let i = 0; i < SEG; i++) {
      const a = (i / SEG) * Math.PI * 2 - Math.PI / 2;
      const x = cx + Math.cos(a) * r - dot / 2;
      const y = cy + Math.sin(a) * r - dot / 2;
      dc.setFillColor(new Color(ink, i < filled ? 1 : 0.18));
      dc.fillEllipse(new Rect(x, y, dot, dot));
    }
    return dc.getImage();
  } catch (e) {
    return null;
  }
}

/** A week of bars. Zero days keep a visible stub so a quiet day is not a gap. */
function spark(values, width, height, pair) {
  try {
    const dc = new DrawContext();
    dc.size = new Size(width, height);
    dc.opaque = false;
    dc.respectScreenScale = true;

    const nums = values.map((v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0));
    const max = Math.max(1, ...nums);
    const slot = width / Math.max(1, nums.length);
    const barW = Math.max(2, slot - 3);
    const ink = forTheme(pair);

    for (let i = 0; i < nums.length; i++) {
      const last = i === nums.length - 1;
      const h = nums[i] === 0 ? 2 : Math.max(3, (nums[i] / max) * height);
      dc.setFillColor(new Color(ink, nums[i] === 0 ? 0.22 : (last ? 1 : 0.45)));
      dc.fillRect(new Rect(i * slot, height - h, barW, h));
    }
    return dc.getImage();
  } catch (e) {
    return null;
  }
}

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
/**
 * SARA, saying one thing - over her own field.
 *
 * `speech` is composed on the SERVER and is literally what she would say aloud,
 * so rendering it is what keeps the widget, the notification and the spoken
 * briefing one voice rather than three.
 *
 * It NEVER writes her lines. When `speech` is null she is quiet - a correct
 * answer, and most of a calm day - so it falls back to the summary she already
 * composed, then to "Nothing needs you."
 *
 * -- One instrument, measuring whatever matters now ---------------------------
 * The dial and the week of bars are the same shape in both contexts, and what
 * they MEASURE follows the duty read:
 *
 *   on duty  -> the week's task target, and tasks closed per day
 *   off duty -> readiness, and a week of HRV
 *
 * Neither is drawn when its source could not be read: an empty dial is a
 * picture of a bad week, and pictures are believed faster than numbers.
 */
function saraSays(w, d, res, target, weather, family, personal, health, view) {
  const ctx = d.context || {};
  const big = family === 'large';

  // Her presence, behind everything. Not decoration - the coherence of the
  // picture IS the coherence of the read.
  const fieldImg = field(big ? 330 : 340, big ? 350 : 160, fieldDrive(d, res));
  if (fieldImg) w.backgroundImage = fieldImg;

  // A pinned instance shows its own side whatever kind of day it is; an
  // unpinned one follows the brain. `pinned` is kept separate from the result
  // so the header can say which card this is — in a stack of two, "personal"
  // and "the weekend" look identical without it.
  // ⚠ The SERVER resolves which side this card is, including for `flip` — the
  // duty read is the brain's, and a client inverting its own guess would be a
  // second opinion about what kind of day it is. The widget only renders the
  // answer, so its agenda and its gauge cannot disagree.
  const duty = ctx.duty;
  const resolved = d.viewResolved || null;
  const pinned = view !== 'auto';
  const offDuty = resolved
    ? resolved === 'personal'
    : (!res.error && duty && duty.known && duty.onDuty === false);

  const head = w.addStack();
  head.centerAlignContent();
  text(head, 'SARA', { size: 11, weight: 'bold', color: MUTED });
  if (pinned) {
    // The side it LANDED on, never the word "flip" — that means nothing to
    // someone glancing at a stack.
    head.addSpacer(5);
    text(head, resolved || view, { size: 10, color: MUTED });
  }
  head.addSpacer();
  const clock = head.addDate(new Date());
  clock.applyTimeStyle();
  clock.font = font(12, 'bold');
  clock.textColor = MUTED;
  head.addSpacer(6);
  text(head, VERSION, { size: 9, color: MUTED });

  w.addSpacer(big ? 14 : 9);

  let line = null;
  if (res.error) line = "I can't reach the brain right now.";
  else if (d.poolAvailable === false) line = "I can't see your work at the moment - don't take that as an all-clear.";
  else line = d.speech || ctx.summary || (d.primary ? (d.primary.say || d.primary.title) : null);

  text(w, line || 'Nothing needs you.', {
    size: big ? 19 : 15,
    weight: 'bold',
    color: line ? INK : MUTED,
    max: big ? 4 : 3,
  });

  // The next thing in whichever diary is his right now - the agenda is
  // domain-switched on the server, so this is personal off duty.
  const ag = d.agenda;
  const next = ag && ag.known && Array.isArray(ag.events) && ag.events.length ? ag.events[0] : null;
  if (next) {
    const st = new Date(next.start);
    const hhmm = Number.isNaN(st.getTime()) ? ''
      : `${String(st.getHours()).padStart(2, '0')}:${String(st.getMinutes()).padStart(2, '0')}`;
    const day = !ag.scope || ag.scope === 'today'
      ? 'today'
      : `${String(ag.scope).charAt(0).toUpperCase()}${String(ag.scope).slice(1)}`;
    const when = next.allDay
      ? (day === 'today' ? 'all day' : `${day}, all day`)
      : (day === 'today' ? `at ${hhmm}` : `${day} ${hhmm}`);
    w.addSpacer(7);
    text(w, `Next: ${next.subject || 'something'} - ${when}.`, { size: 12.5, color: MUTED, max: 2 });
  }

  w.addSpacer();

  if (big) {
    // Off duty the day comes first — it decides what the readiness is FOR.
    if (offDuty) { if (dayStrip(w, weather)) w.addSpacer(11); }

    const outdoor = weather && weather.day ? weather.day.outdoor : null;
    // Same instrument both sides now: recovery off duty, strain on it. The
    // week's target keeps its home on the lock screen ring.
    const gauge = offDuty ? readinessGauge(health, outdoor) : stressGauge(health);
    if (gauge) {
      const row = w.addStack();
      row.centerAlignContent();

      const img = dial(66, gauge.fraction, gauge.pair);
      if (img) {
        const dstack = row.addStack();
        dstack.size = new Size(66, 66);
        dstack.centerAlignContent();
        dstack.backgroundImage = img;
        const inner = dstack.addStack();
        inner.layoutVertically();
        inner.centerAlignContent();
        text(inner, gauge.value, { size: 18, weight: 'heavy', color: dyn(gauge.pair) });
        text(inner, gauge.unit, { size: 8, color: MUTED });
        row.addSpacer(12);
      }

      const col = row.addStack();
      col.layoutVertically();
      text(col, gauge.label, { size: 13.5, weight: 'bold' });
      col.addSpacer(2);
      text(col, gauge.detail, { size: 10.5, color: MUTED, max: 2 });

      if (gauge.series && gauge.series.length) {
        col.addSpacer(6);
        const bars = spark(gauge.series, 118, 26, gauge.pair);
        if (bars) {
          const bs = col.addStack();
          const bimg = bs.addImage(bars);
          bimg.imageSize = new Size(118, 26);
          bs.addSpacer();
        }
        col.addSpacer(3);
        text(col, gauge.seriesLabel, { size: 9, color: MUTED });
      }
      row.addSpacer();
      w.addSpacer(9);
    }
  }

  const foot = w.addStack();
  foot.centerAlignContent();
  const bits = [];
  if (offDuty) {
    const open = personal && Array.isArray(personal.tasks) ? personal.tasks.length : null;
    if (open) bits.push(open === 1 ? '1 personal task' : `${open} personal tasks`);
  }
  if (weather) bits.push(`${weather.now.temp}°`);
  if (bits.length) text(foot, bits.join('  ·  '), { size: 11, color: MUTED, max: 1 });
  foot.addSpacer();

  // Held and unread are WORK, so they stay off the weekend - the same intrusion
  // as naming Monday's first meeting, in smaller type.
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

/**
 * Readiness, off duty.
 *
 * `/api/health/stress` scores HRV against Nick's OWN 14-day rolling baseline -
 * 45ms is good for one person and poor for another - and returns `calibrating`
 * or `stale` rather than inventing a number. Both render as NO GAUGE, which is
 * the honest picture; it has been computed since August and shown by nothing.
 */
function readinessGauge(health, outdoor) {
  // The block comes off the attention payload: the stress fields at the top
  // level, `hrvWeek` beside them. `calibrating` and `stale` are real answers
  // and render as NO GAUGE rather than a number nobody should act on.
  const s = health && health.known ? health : null;
  if (!s || s.status !== 'ok' || !Number.isFinite(Number(s.score))) return null;

  const score = Math.round(Number(s.score));
  const pair = score >= 66 ? HEX.positive : score >= 40 ? HEX.high : HEX.critical;

  const hrv = Number.isFinite(Number(s.hrv)) ? Number(s.hrv).toFixed(1) : null;
  const base = Number.isFinite(Number(s.baselineMs)) ? Math.round(Number(s.baselineMs)) : null;

  // Oldest to newest, so the emphasised last bar is today.
  const series = Array.isArray(health.hrvWeek) ? health.hrvWeek : [];

  return {
    value: String(score),
    unit: 'ready',
    fraction: score / 100,
    // "Ready for WHAT" — the score alone is a number without a question.
    label: suitability(score, outdoor),
    detail: hrv && base ? `${s.label || 'Balanced'} · HRV ${hrv}ms vs ${base}` : (s.label || 'Balanced'),
    pair,
    series: series.length > 2 ? series : null,
    seriesLabel: 'HRV, last 7 days',
  };
}

/**
 * What the score is readiness FOR.
 *
 * ⚠ Deterministic bands, never a model call, and deliberately about CAPACITY
 * rather than instruction — "there is plenty there" not "go for a run". A
 * widget that prescribes exercise off three numbers is `stress-score`'s own
 * caveat ignored: Apple Health cannot tell exercise from illness from a hard
 * week, and this is the same data.
 *
 * The weather only ever changes the SUGGESTION, never the score.
 */
function suitability(score, outdoor) {
  if (score >= 70) return outdoor === true ? 'Good for a long one' : 'Plenty in the tank';
  if (score >= 55) return outdoor === true ? 'Fine for a walk' : 'A steady day';
  if (score >= 40) return 'Enough for an easy one';
  return 'Take it gently today';
}

/**
 * Strain on a working day: the SAME reading, counted the other way up.
 *
 * `stress-score` returns a recovery scale where higher is better (98 = fully
 * recovered). Stress is its complement, so this inverts it — Nick's call, made
 * after I argued for keeping one direction and he reaffirmed it. Higher now
 * means worse, which is what everybody expects of the word.
 *
 * ⚠ Inverting the NUMBER alone would have been the actual lie. A dial that
 * fills as things improve, under a figure that rises as they worsen, reads
 * backwards at exactly the glance-speed a widget is for. So all three invert
 * together:
 *
 *   value    100 - score, rising with strain
 *   fill     the dial fills UP as stress rises
 *   colour   green when there is room, red when there is not
 *
 * The HRV bars underneath keep their own direction and stay labelled "HRV",
 * because a named metric means what it has always meant; only the gauge is
 * re-framed.
 *
 * The lock-screen ring is the weekly TARGET, never this, so there is no surface
 * where the two directions appear together.
 */
function stressGauge(health) {
  const s = health && health.known ? health : null;
  if (!s || s.status !== 'ok' || !Number.isFinite(Number(s.score))) return null;

  const score = Math.round(Number(s.score));
  const stress = Math.max(0, Math.min(100, 100 - score));

  // Inverted against readinessGauge: red is now the HIGH end.
  const pair = stress >= 60 ? HEX.critical
    : stress >= 45 ? HEX.high
      : HEX.positive;

  const hrv = Number.isFinite(Number(s.hrv)) ? Number(s.hrv).toFixed(1) : null;
  const base = Number.isFinite(Number(s.baselineMs)) ? Math.round(Number(s.baselineMs)) : null;

  const series = Array.isArray(health.hrvWeek) ? health.hrvWeek : [];

  return {
    value: String(stress),
    unit: 'stress',
    fraction: stress / 100,
    label: stress >= 60 ? 'Under strain'
      : stress >= 45 ? 'Running warm'
        : stress >= 30 ? 'Holding up'
          : 'Room to push',
    detail: hrv && base ? `HRV ${hrv}ms vs ${base} baseline` : 'HRV against your baseline',
    pair,
    series: series.length > 2 ? series : null,
    seriesLabel: 'HRV, last 7 days',
  };
}

/**
 * The shape of the day, hour by hour.
 *
 * Bars are RAIN CHANCE and the numbers are temperature — two facts on one
 * strip, which works because they are read for different reasons: the bars
 * answer "will I get wet", the digits answer "what do I wear". A zero-rain hour
 * keeps a faint stub so a dry hour reads as measured rather than missing.
 */
function dayStrip(w, weather) {
  const day = weather && weather.day;
  const hours = weather && Array.isArray(weather.hours) ? weather.hours.slice(0, 6) : [];
  if (!day || hours.length < 3) return false;

  const pair = day.outdoor ? HEX.positive : HEX.normal;

  const head = w.addStack();
  head.centerAlignContent();
  text(head, day.verdict, { size: 13, weight: 'bold', color: dyn(pair) });
  head.addSpacer(6);
  text(head, day.why, { size: 11, color: MUTED, max: 1 });
  head.addSpacer();

  w.addSpacer(6);
  const row = w.addStack();
  for (let i = 0; i < hours.length; i++) {
    if (i) row.addSpacer(6);
    const col = row.addStack();
    col.layoutVertically();
    col.centerAlignContent();
    text(col, `${hours[i].temp}°`, { size: 10.5, weight: 'bold' });
    const bar = spark([hours[i].pop], 16, 14, hours[i].pop >= 40 ? HEX.normal : HEX.low);
    if (bar) {
      const bs = col.addStack();
      const img = bs.addImage(bar);
      img.imageSize = new Size(16, 14);
    }
    text(col, `${String(hours[i].at.getHours()).padStart(2, '0')}`, { size: 9, color: MUTED });
  }
  row.addSpacer();
  return true;
}

/** The week's task target, on duty. The same instrument, measuring the commitment. */
function targetGauge(t) {
  if (!t || t.state === 'unknown' || !t.target) return null;
  const pair = targetPair(t);
  const series = Array.isArray(t.byDay) ? t.byDay.map((x) => Number(x.done) || 0) : null;
  return {
    value: String(t.done),
    unit: `of ${t.target}`,
    fraction: t.target > 0 ? t.done / t.target : 0,
    label: 'This week',
    detail: t.state === 'exceeded' ? `${t.over} past target`
      : t.state === 'met' ? 'target met'
        : t.state === 'behind' ? `${t.remaining} to go · behind pace`
          : `${t.remaining} to go`,
    pair,
    series: series && series.length > 2 ? series : null,
    seriesLabel: 'tasks closed, Mon-Sun',
  };
}

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
function accessoryView(family, res, d, wins, target, health) {
  const w = new ListWidget();
  // Fully transparent — the system paints the lock screen's own material behind
  // this, so any ground of ours would sit on top of it as a grey slab.
  w.backgroundColor = new Color('#000000', 0);
  w.setPadding(2, 2, 2, 2);

  const ctx = d.context || {};
  const duty = ctx.duty;
  // Same resolution as the large tile — the brain decides the side, including
  // for a pinned or flipped instance, so a lock widget can never disagree with
  // the home screen about what kind of day it is.
  const resolved = d.viewResolved || null;
  const offDuty = resolved
    ? resolved === 'personal'
    : (!res.error && duty && duty.known && duty.onDuty === false);
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
    // The BODY gauge, following the same context switch as the large tile:
    // readiness off duty, strain on it. It is the one number worth a
    // lock-screen slot, because it is true whatever else is going on and it is
    // the thing Nick cannot check any other way at a glance.
    //
    // The week's target keeps the rectangular widget below — a target is a
    // commitment with a denominator, and a bare ring cannot carry that as well
    // as a bar and its numbers can.
    //
    // ⚠ Fill, not hue: iOS tints lock-screen accessories, so the ring reads by
    // how much of it is solid. Readiness fills as it improves, strain fills as
    // it worsens — each gauge already carries the fraction pointing its own way.
    const gauge = offDuty ? readinessGauge(health) : stressGauge(health);
    if (gauge) {
      const img = dial(58, gauge.fraction, gauge.pair);
      if (img) w.backgroundImage = img;
      const stack = w.addStack();
      stack.layoutVertically();
      stack.centerAlignContent();
      text(stack, gauge.value, { size: 17, weight: 'heavy', max: 1 });
      text(stack, gauge.unit, { size: 8, max: 1 });
      w.url = tabUrl('today');
      return w;
    }

    // No usable reading — calibrating, stale, or the watch has not synced.
    // "?" rather than a zero ring, which would read as "you are finished",
    // and rather than silently falling back to the task target, which would
    // put a different meaning behind an identical ring.
    const stack = w.addStack();
    stack.layoutVertically();
    stack.centerAlignContent();
    text(stack, '?', { size: 19, weight: 'heavy', max: 1 });
    text(stack, 'no read', { size: 8, max: 1 });
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

function build(res, family, wins, weather, target, personal, health, view) {
  const d0 = res.data || {};
  if (String(family).startsWith('accessory')) {
    return accessoryView(family, res, d0, wins, target, health);
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
  saraSays(w, d0, res, target, weather, family, personal, health, view);
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
const view = widgetView();

const [res, weather] = await Promise.all([
  fetchAttention(cfg, view),
  isAccessory ? Promise.resolve(null) : fetchWeather(),
]);

// Only spend a second request when the brain has actually said he is off duty.
// The pin decides what to FETCH as well as what to draw — a personal card must
// not go without its personal tasks just because it happens to be a Tuesday.
// `viewResolved` comes back from the brain and already accounts for `flip`.
const duty = res.data && res.data.context && res.data.context.duty;
const resolvedView = res.data ? res.data.viewResolved : null;
const offDuty = resolvedView
  ? resolvedView === 'personal'
  : (!res.error && duty && duty.known && duty.onDuty === false);
// Off duty the wins ARE the view; on large they fill the strip at the bottom.
// Anywhere else it would be a request bought for nothing.
const needWins = !res.error && (offDuty || family === 'large');
const [wins, personal] = await Promise.all([
  needWins ? fetchWins(cfg) : Promise.resolve(null),
  // Personal tasks matter only off duty, and only where there is room to show them.
  (offDuty && !isAccessory) ? fetchPersonal(cfg) : Promise.resolve(null),
]);

// Readiness rides on the attention payload, like the target. It used to be two
// more requests of its own, and losing either of them silently removed the
// gauge — see the note in attention.build().
const health = res.data ? res.data.readiness : null;

// The target rides on the attention payload already — composed server-side with
// its own words, like `say` and `speech`. A second request would be a second
// opinion about the same week.
const target = res.data ? res.data.weeklyTarget : null;

const widget = build(res, family, wins, weather, target, personal, health, view);

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
