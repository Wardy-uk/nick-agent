'use strict';

/**
 * The get-to-know-you conversation.
 *
 * Nick's design (31 Aug 2026): seed the profile from the memory Claude and
 * ChatGPT already hold, *"then enrich that from a 'get to know me' session run
 * directly from NEURO — a one time conversation where it asks questions and I
 * answer — from there, SARA/NEURO adds to it as it learns."*
 *
 * The seed did the easy half and was deliberately conservative: 29 facts, and it
 * left out most of the SPECIFICS. It knows he has an aquarium; it does not know
 * it is 200 litres, a metre long, and what is in it — which is the difference
 * between "he likes fish" and being able to answer *"would this plant work?"*.
 * That gap is what this conversation is for.
 *
 * ── Why it is not the standup machinery ─────────────────────────────────────
 * `standup-session` is keyed per DAY, renders a daily note and reasons about
 * working days. This is a one-off that may span several sittings. Bending that
 * file into a third kind would have cost more than the ~200 lines here, and the
 * two would then share a shape neither wanted.
 *
 * What IS reused is the pattern that file proved: state in `agent_state`, the
 * transcript SAVED BEFORE AND AFTER every turn, and a tool path that DEGRADES to
 * a tool-less conversation rather than dying. The original guided standup held
 * everything in browser state until one final POST and lost the lot when that
 * POST failed; this holds an hour of someone talking about their life, which is
 * worse to lose and far harder to ask for twice.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 * ⚠ **SHE RECORDS ONLY WHAT HE SAYS.** The tool takes facts; the prompt forbids
 * inference. "He mentioned Ember on a walk" must not become "he walks Ember
 * every morning". Everything lands stamped `interview`, which renders as "(told
 * me)" — a stronger claim than the seed's "(mentioned)", and it has to be earned.
 *
 * ⚠ **IT ASKS, IT DOES NOT INTERROGATE.** One question at a time, following what
 * he actually gives it. A fixed questionnaire is the form this design exists to
 * avoid — he would answer four and abandon it, which is exactly how the old
 * guided standup failed.
 *
 * ⚠ **IT CAN BE STOPPED AND RESUMED.** Nothing is lost by walking away, and the
 * gaps it has not covered are still there next time.
 *
 * CommonJS — NEURO backend convention.
 */

const db = require('../db/database');
const profile = require('./profile');
const { VOICE_FULL } = require('./sara-voice');

const STATE_KEY = 'profile_interview';

const PROMPT = `${VOICE_FULL}

## What you are doing
You are getting to know Nick properly, once, so that you stop having to ask.

Almost everything NEURO holds about him is work: 263 meeting notes, 417
recordings, his calendar, his tasks. It knows what he does for a living in
enormous detail and almost nothing about the rest of him. A memory export from
two previous assistants has been loaded as a starting point — the CONTEXT below
shows what that gave you and which areas are still empty.

## How to do it
- ONE question at a time. This is a conversation, not a form. A questionnaire is
  the thing this exists to avoid: he would answer four and wander off.
- FOLLOW WHAT HE GIVES YOU. If he starts talking about the aquarium, stay there
  and get the useful specifics rather than moving dutifully to the next heading.
- GO FOR SPECIFICS, because they are what make the memory usable later. "He has
  an aquarium" is nearly useless; "200 litres, a metre long, 60cm tall, tetras
  and two female bettas, wants more colour at the back-left" means you can answer
  a question about a plant a year from now.
- Use what the seed already gave you. Do not ask what you have just been told —
  confirm it in passing if it is worth confirming, and move on.
- Call record_facts as you go, not in one lump at the end. If he stops halfway
  through, everything up to that point is already saved.
- Say roughly where you are up to now and then. He should never feel he has
  signed up for something with no end.
- When it has run its course, or he says he has had enough, call finish_interview
  and tell him what you took away.

## What NOT to do
- ⚠ RECORD ONLY WHAT HE ACTUALLY SAID. Never infer, never round up, never tidy a
  maybe into a fact. "Mentioned walking the dog" is not "walks the dog every
  morning". If you are unsure whether something is a fact or a passing remark,
  ask him, or leave it out.
- Do not ask about work. There are 263 meeting notes about that already.
- Do not ask anything medical unless he raises it himself.
- Do not make it earnest. This is a conversation with someone who knows him, not
  an onboarding wizard.`;

const TOOLS = [
  {
    name: 'record_facts',
    description: 'Record things Nick has just told you about himself. Call this as you go, not once at the end. Only what he actually said.',
    input_schema: {
      type: 'object',
      properties: {
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'One fact, short, third person. "Runs a 200 litre freshwater tropical tank, roughly 100cm x 60cm."' },
              section: { type: 'string', description: `One of: ${profile.SECTIONS.join(', ')}` },
            },
            required: ['text'],
          },
        },
      },
      required: ['facts'],
    },
  },
  {
    name: 'finish_interview',
    description: 'End the interview. Call when it has run its course or Nick says he has had enough.',
    input_schema: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'One or two sentences on what you took away.' } },
      required: [],
    },
  },
];

// ── State ────────────────────────────────────────────────────────────────────

function load() {
  try {
    const raw = db.getState(STATE_KEY);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.error('[ProfileInterview] Could not read:', e.message);
    return null;
  }
}

function save(session) {
  db.setState(STATE_KEY, JSON.stringify(session));
}

function clear() {
  db.setState(STATE_KEY, '');
}

function _empty() {
  return {
    state: 'active',
    messages: [],
    recorded: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function _context() {
  const found = profile.read();
  const known = found.ok ? profile.contextBlock(found.profile, { limit: 60 }) : null;
  const gaps = found.ok ? profile.gaps(found.profile) : profile.SECTIONS;
  return [
    known || 'Nothing recorded about him yet.',
    '',
    gaps.length
      ? `STILL EMPTY: ${gaps.join(', ')}. These are where the seed gave nothing.`
      : 'Every section has something in it. Go for depth rather than coverage.',
  ].join('\n');
}

// ── Turns ────────────────────────────────────────────────────────────────────

function _executeTool(session, name, input) {
  switch (name) {
    case 'record_facts': {
      const facts = Array.isArray(input.facts) ? input.facts : [];
      if (!facts.length) return { ok: false, error: 'no facts given' };
      // ⚠ Stamped `interview` — which renders "(told me)", a stronger claim than
      // the seed's "(mentioned)". It is only honest because the prompt forbids
      // inference, and it is why that rule is stated twice.
      const result = profile.addFacts(facts, { source: 'interview' });
      if (!result.ok) return { ok: false, error: result.why };
      session.recorded += result.added.length;
      return {
        ok: true,
        added: result.added.length,
        duplicates: result.duplicates.length,
        note: result.duplicates.length ? 'Some of those I already had — no harm.' : undefined,
      };
    }
    case 'finish_interview': {
      session.state = 'finished';
      session.summary = String(input.summary || '').slice(0, 500);
      return { ok: true, recorded: session.recorded };
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

async function _turn(session) {
  const prompt = `${PROMPT}\n\n---\nWHAT YOU ALREADY KNOW:\n${_context()}`;
  const aiRouting = require('./ai-routing');
  let reply = '';

  // ⚠ Saved BEFORE the turn as well as after. An hour of someone talking about
  // their life is the worst thing in this system to lose, and the hardest to ask
  // for a second time.
  save(session);

  const picked = aiRouting.getToolProvider('profile_interview');
  if (picked) {
    try {
      const result = await picked.provider.chatWithTools(
        prompt,
        session.messages,
        TOOLS.map(({ name, description, input_schema }) => ({ name, description, input_schema })),
        (name, input) => _executeTool(session, name, input),
        { maxTokens: 500, maxRounds: 4 },
      );
      reply = result.text || '';
      session.degraded = false;
      try {
        aiRouting.recordUsage(result.usage, {
          provider: picked.name,
          model: result.model || null,
          taskType: 'profile_interview_tools',
        });
      } catch { /* accounting must not cost the turn */ }
    } catch (e) {
      console.warn(`[ProfileInterview] Tool path (${picked.name}) failed, degrading:`, e.message);
      session.degradedReason = e.message.slice(0, 120);
    }
  }

  // Tool-less fallback. She can still hold the conversation; she just cannot
  // write anything down herself, so the transcript is the record and `harvest()`
  // is how it gets in afterwards. A conversation without tools is worth far more
  // than no conversation.
  if (!reply.trim()) {
    try {
      const result = await aiRouting.runTask('profile_interview', {
        systemPrompt: prompt,
        messages: session.messages,
        maxTokens: 500,
      });
      reply = result.text || '';
      if (reply.trim()) session.degraded = true;
    } catch (e) {
      console.error('[ProfileInterview] Fallback failed too:', e.message);
    }
  }

  if (!reply.trim()) {
    const detail = session.degradedReason || 'no AI provider available';
    session.lastError = detail;
    save(session);
    throw new Error(`Could not reach any AI provider (${detail})`);
  }

  session.messages.push({ role: 'assistant', content: reply });
  session.updatedAt = new Date().toISOString();
  session.lastError = null;
  save(session);
  return session;
}

/** Start, or resume one already under way. Restarting is explicit — an accidental
 *  restart would throw away a conversation he has already given an hour to. */
async function start({ restart = false } = {}) {
  const existing = load();
  if (existing && existing.state !== 'finished' && !restart) return existing;

  const session = _empty();
  session.messages.push({ role: 'user', content: "Let's do this — get to know me." });
  return _turn(session);
}

async function reply(message) {
  const session = load();
  if (!session) throw new Error('No interview in progress — start one first');
  if (session.state === 'finished') throw new Error('That interview is already finished');

  const text = String(message || '').trim();
  if (!text) throw new Error('message is required');

  session.messages.push({ role: 'user', content: text });
  return _turn(session);
}

function status() {
  const session = load();
  const found = profile.read();
  return {
    inProgress: !!(session && session.state === 'active'),
    finished: !!(session && session.state === 'finished'),
    recorded: session ? session.recorded : 0,
    degraded: !!(session && session.degraded),
    known: found.ok ? profile.count(found.profile) : null,
    gaps: found.ok ? profile.gaps(found.profile) : null,
  };
}

module.exports = { start, reply, load, save, clear, status, PROMPT, TOOLS, STATE_KEY };
