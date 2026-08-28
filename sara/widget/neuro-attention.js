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
// The token is NEVER written into this file: the repo is public, and a
// credential in a tracked file is exactly how the PIN leaked in July.
// To change it later: run the script in-app and hold the Cancel-free prompt,
// or delete the keys via Scriptable's own console.

const KEY_URL = 'neuro_base_url';
const KEY_TOKEN = 'neuro_api_token';
const DEFAULT_URL = 'https://pi5.tailecb90f.ts.net';
const APP_URL = 'https://sara.nickward.co.uk';
const TIMEOUT_SECONDS = 12;

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
      if (base) Keychain.set(KEY_URL, base.trim().replace(/\/+$/, ''));
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

// ── Look ────────────────────────────────────────────────────────────────────
//
// Design rules, so this stays legible rather than merely decorated:
//  • ONE accent per card, taken from the brain's own `urgency` — colour is
//    information here, not styling. Nothing is coloured for the sake of it.
//  • The icon says the TYPE, the accent says the URGENCY. Two channels, two
//    facts; if they said the same thing one of them would be noise.
//  • Everything degrades: an unknown type falls back to a dot, a missing SF
//    Symbol falls back to a glyph, and both still render a readable row.

function tabUrl(tab) {
  return `${APP_URL}/?tab=${encodeURIComponent(tab || 'surface')}`;
}

const INK = Color.dynamic(new Color('#111114'), new Color('#f5f5f7'));
const MUTED = Color.dynamic(new Color('#8a8a8e'), new Color('#98989d'));
const HAIRLINE = Color.dynamic(new Color('#e6e6ea'), new Color('#3a3a3c'));
const CARD = Color.dynamic(new Color('#ffffff'), new Color('#2c2c2e'));
const TILE_BG = Color.dynamic(new Color('#f4f4f6'), new Color('#3a3a3c'));

// Urgency → accent. `critical` is the only red in the widget, so red always
// means the same thing wherever it appears.
const ACCENTS = {
  critical: Color.dynamic(new Color('#d92d20'), new Color('#ff6b5e')),
  high: Color.dynamic(new Color('#b54708'), new Color('#ffa94d')),
  normal: Color.dynamic(new Color('#0064d2'), new Color('#5ea9ff')),
  low: Color.dynamic(new Color('#6a6a70'), new Color('#98989d')),
};
const POSITIVE = Color.dynamic(new Color('#1a7f4b'), new Color('#4ad07d'));

function accentFor(card) {
  return ACCENTS[String(card && card.urgency)] || ACCENTS.normal;
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
  t.font = weight === 'bold' ? Font.semiboldSystemFont(size)
    : weight === 'heavy' ? Font.boldSystemFont(size)
      : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = max;
  t.minimumScaleFactor = 0.9;
  return t;
}

/** A rounded tile carrying the type icon, tinted with the urgency accent. */
function tile(stack, type, accent, box) {
  const t = stack.addStack();
  t.size = new Size(box, box);
  t.cornerRadius = box * 0.3;
  t.backgroundColor = TILE_BG;
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

/** The header strip: who is talking, what state they think you are in, when. */
function header(w, ctxLabel, stamp, alert) {
  const row = w.addStack();
  row.centerAlignContent();

  tile(row, 'context', alert || ACCENTS.normal, 16);
  row.addSpacer(6);
  text(row, 'SARA', { size: 11, color: MUTED, weight: 'bold' });

  if (ctxLabel) {
    row.addSpacer(6);
    // The context reads as a pill so it is obviously a STATE, not another item.
    const pill = row.addStack();
    pill.cornerRadius = 7;
    pill.backgroundColor = TILE_BG;
    pill.setPadding(2, 7, 2, 7);
    text(pill, ctxLabel, { size: 10, color: MUTED });
  }

  row.addSpacer();
  text(row, stamp, { size: 10, color: MUTED });
  w.addSpacer(10);
}

/**
 * One item. `primary` gets its own card surface and room for the full sentence;
 * the rest are compact rows, because the Surface's whole claim is that there is
 * ONE thing and then some context for it.
 */
function itemRow(container, card, { primary = false } = {}) {
  const accent = accentFor(card);
  const row = container.addStack();
  row.url = tabUrl(card.tab);
  row.centerAlignContent();

  if (primary) {
    row.backgroundColor = CARD;
    row.cornerRadius = 14;
    row.setPadding(11, 11, 11, 11);
  }

  tile(row, card.type || card.kind, accent, primary ? 30 : 20);
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
  const show = (symbol, accent, title, body) => {
    const row = w.addStack();
    row.backgroundColor = CARD;
    row.cornerRadius = 14;
    row.setPadding(12, 12, 12, 12);
    row.centerAlignContent();
    tile(row, symbol, accent, 30);
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
    show('escalation', ACCENTS.critical, "Can't reach NEURO", error);
    return true;
  }
  if (d.poolAvailable === false) {
    show('escalation', ACCENTS.high, "Can't see your work",
      'This is not an all-clear — the queue could not be read.');
    return true;
  }
  if (!d.primary) {
    const ctx = d.context || {};
    if (d.quiet === true) {
      show('context', ACCENTS.low, ctx.label || 'Quiet',
        ctx.summary || d.rationale || 'Nothing to raise right now.');
    } else {
      show('todo', POSITIVE, 'All clear', 'Nothing needs you at the moment.');
    }
    return true;
  }
  return false;
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
    tile(row, 'waiting', ACCENTS.low, 13);
    row.addSpacer(5);
    text(row, `${dropped} held back`, { size: 10, color: MUTED });
  }
  if (dropped && gaps) {
    row.addSpacer(8);
  }
  if (gaps) {
    // A gap is not a held item — it is something NEURO could not read at all,
    // and it is the one number on this widget that should look slightly wrong.
    tile(row, 'escalation', ACCENTS.high, 13);
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

  tile(row, 'todo', week || today ? POSITIVE : ACCENTS.low, 30);
  row.addSpacer(11);
  const col = row.addStack();
  col.layoutVertically();
  text(col, title, { size: 15, weight: 'heavy', max: 2 });
  col.addSpacer(3);
  text(col, duty.reason || 'Not a working day.', { size: 12, color: MUTED, max: 2 });
  row.addSpacer();

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
function accessoryView(family, res, d, wins) {
  const w = new ListWidget();
  // Fully transparent — the system paints the lock screen's own material behind
  // this, so any ground of ours would sit on top of it as a grey slab.
  w.backgroundColor = new Color('#000000', 0);
  w.setPadding(2, 2, 2, 2);

  const ctx = d.context || {};
  const duty = ctx.duty;
  const offDuty = !res.error && duty && duty.known && duty.onDuty === false;
  const onFire = d.primary && d.primary.urgency === 'critical';

  // What the lock screen has room to say, in one decision rather than three.
  let head = 'SARA';
  let body;
  if (res.error) { head = 'SARA · offline'; body = "Couldn't reach NEURO."; }
  else if (d.poolAvailable === false) { head = 'SARA · blind'; body = "Can't see your work."; }
  else if (offDuty && !onFire) {
    const week = wins && Number(wins.doneThisWeek);
    head = 'SARA · off';
    body = week ? `${week} finished this week.` : (duty.reason || 'Off duty.');
  } else if (!d.primary) {
    head = ctx.label ? `SARA · ${ctx.label}` : 'SARA';
    body = d.quiet ? (ctx.summary || 'Nothing to raise.') : 'Nothing needs you.';
  } else {
    head = ctx.label ? `SARA · ${ctx.label}` : 'SARA';
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
    // A count is the only thing that survives this size. It is deliberately the
    // number of things SARA would raise, not a total of anything else.
    const n = (d.primary ? 1 : 0) + ((d.secondary || []).length);
    const stack = w.addStack();
    stack.layoutVertically();
    stack.centerAlignContent();
    text(stack, offDuty && !onFire ? '✓' : String(n), { size: 20, weight: 'heavy', max: 1 });
    w.url = tabUrl('surface');
    return w;
  }

  // accessoryRectangular
  text(w, head, { size: 11, weight: 'bold', max: 1 });
  text(w, body, { size: 13, max: 2 });
  w.url = tabUrl(d.primary && !offDuty ? d.primary.tab : offDuty ? 'today' : 'surface');
  return w;
}

function build(res, family, wins) {
  const d0 = res.data || {};
  if (String(family).startsWith('accessory')) {
    return accessoryView(family, res, d0, wins);
  }

  const w = new ListWidget();
  bg(w);
  w.setPadding(14, 14, 14, 14);
  // Tell iOS when this is worth refreshing. It is a hint, not a promise — the
  // system budgets widget refreshes and will ignore this when it wants to.
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

  const d = res.data || {};
  const ctx = d.context || {};
  const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const bad = res.error ? ACCENTS.critical : d.poolAvailable === false ? ACCENTS.high : null;

  // When the context IS the answer — a context card, a silence, or a failure —
  // the headline already says it, and repeating it in the pill puts the same
  // words on screen twice ("In a meeting" above "In a meeting"). The pill only
  // earns its place when it is framing something else.
  const contextIsTheAnswer = !!res.error
    || d.poolAvailable === false
    || !d.primary
    || d.primary.kind === 'context';
  header(w, contextIsTheAnswer ? null : ctx.label, stamp, bad);

  // Off duty: show what he did, not what he owes. ⚠ Except when something is
  // genuinely on fire — hiding a breaching escalation because it is Saturday is
  // the wrong failure, and `context-state` already treats a live work signal on
  // a non-working day as a contradiction rather than an all-clear.
  const duty = ctx.duty;
  const onFire = d.primary && d.primary.urgency === 'critical';
  if (!res.error && duty && duty.known && duty.onDuty === false && !onFire) {
    offDutyView(w, duty, wins);
    w.addSpacer();
    return w;
  }

  if (silence(w, d, res.error)) return w;

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

  footer(w, d);
  w.addSpacer();
  w.url = tabUrl(d.primary.tab);
  return w;
}

// ── Entry ───────────────────────────────────────────────────────────────────

const cfg = await loadConfig();
const res = await fetchAttention(cfg);

// Only spend a second request when the brain has actually said he is off duty.
const duty = res.data && res.data.context && res.data.context.duty;
const offDuty = !res.error && duty && duty.known && duty.onDuty === false;
const wins = offDuty ? await fetchWins(cfg) : null;

const widget = build(res, config.runsInWidget ? config.widgetFamily : 'large', wins);

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}
Script.complete();
