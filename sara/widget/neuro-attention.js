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

// ── Rendering ───────────────────────────────────────────────────────────────

const INK = Color.dynamic(new Color('#1c1c1e'), new Color('#f2f2f7'));
const MUTED = Color.dynamic(new Color('#6b6b70'), new Color('#9a9aa0'));
const WARN = Color.dynamic(new Color('#a1442b'), new Color('#ff9f7a'));
const BG = Color.dynamic(new Color('#ffffff'), new Color('#1c1c1e'));

function tabUrl(tab) {
  return `${APP_URL}/?tab=${encodeURIComponent(tab || 'surface')}`;
}

function line(stack, text, { size = 12, color = INK, bold = false, max = 2 } = {}) {
  const t = stack.addText(String(text));
  t.font = bold ? Font.semiboldSystemFont(size) : Font.systemFont(size);
  t.textColor = color;
  t.lineLimit = max;
  return t;
}

function header(w, label, stamp) {
  const row = w.addStack();
  row.centerAlignContent();
  line(row, 'SARA', { size: 11, color: MUTED, bold: true, max: 1 });
  row.addSpacer(6);
  line(row, label || '', { size: 11, color: MUTED, max: 1 });
  row.addSpacer();
  line(row, stamp, { size: 10, color: MUTED, max: 1 });
  w.addSpacer(8);
}

/** One card: title, then the sentence SARA would say about it. */
function card(w, c, { primary = false } = {}) {
  const stack = w.addStack();
  stack.layoutVertically();
  stack.url = tabUrl(c.tab);
  line(stack, c.title, { size: primary ? 16 : 13, bold: true, max: primary ? 2 : 1 });
  const detail = c.say || c.reason;
  if (detail) line(stack, detail, { size: primary ? 12 : 11, color: MUTED, max: primary ? 3 : 1 });
}

/**
 * The four ways there is nothing to show, each said differently.
 * Returns true if it rendered one, meaning the caller must not draw cards.
 */
function renderSilence(w, d, error) {
  if (error) {
    line(w, "Can't reach NEURO", { size: 15, bold: true, color: WARN });
    line(w, error, { size: 11, color: MUTED, max: 3 });
    w.url = tabUrl('surface');
    return true;
  }
  if (d.poolAvailable === false) {
    line(w, "I can't see your work", { size: 15, bold: true, color: WARN });
    line(w, 'This is not an all-clear — the queue could not be read.', { size: 11, color: MUTED, max: 3 });
    w.url = tabUrl('surface');
    return true;
  }
  if (!d.primary) {
    // Quiet and empty are both legitimate, and they are not the same statement.
    const quiet = d.quiet === true;
    const ctx = d.context || {};
    line(w, quiet ? (ctx.label || 'Quiet') : 'Nothing pending', { size: 15, bold: true });
    const why = quiet
      ? (ctx.summary || d.rationale || 'Nothing to raise right now.')
      : 'Nothing needs you at the moment.';
    line(w, why, { size: 11, color: MUTED, max: 3 });
    w.url = tabUrl('surface');
    return true;
  }
  return false;
}

function build(res, family) {
  const w = new ListWidget();
  w.backgroundColor = BG;
  w.setPadding(14, 14, 14, 14);

  const d = res.data || {};
  const ctx = d.context || {};
  const stamp = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  header(w, res.error ? '' : ctx.label, stamp);

  if (renderSilence(w, d, res.error)) return w;

  card(w, d.primary, { primary: true });

  // Small has room for one thing, which is the point of the Surface anyway.
  const room = family === 'large' ? 4 : family === 'medium' ? 2 : 0;
  const rest = (d.secondary || []).slice(0, room);
  if (rest.length) {
    w.addSpacer(8);
    for (const c of rest) {
      card(w, c);
      w.addSpacer(4);
    }
  }

  // Held, not lost — say so rather than swallowing it, and never as a bare number.
  const dropped = Array.isArray(d.dropped) ? d.dropped.length : 0;
  const gaps = Array.isArray(d.gaps) ? d.gaps.length : 0;
  if (dropped || gaps) {
    w.addSpacer(4);
    const notes = [];
    if (dropped) notes.push(`${dropped} held back`);
    if (gaps) notes.push(`${gaps} couldn't be read`);
    line(w, notes.join(' · '), { size: 10, color: MUTED, max: 1 });
  }

  w.url = tabUrl(d.primary.tab);
  return w;
}

// ── Entry ───────────────────────────────────────────────────────────────────

const cfg = await loadConfig();
const res = await fetchAttention(cfg);
const widget = build(res, config.runsInWidget ? config.widgetFamily : 'large');

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentLarge();
}
Script.complete();
